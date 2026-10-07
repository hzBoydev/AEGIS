import { config, publicClient } from "./config.js";

// ── Types ─────────────────────────────────────────────────────────────────────
/**
 * Origin of the `txCount` number — determines WHAT that number MEANS:
 * - "explorer" : incoming+outgoing tx count from the explorer (BscScan/Etherscan).
 * - "rpc_nonce": nonce from RPC = OUTGOING transactions ONLY. Incoming transactions
 *                are NOT counted, so a receive-only account shows 0.
 * - "none"     : no source at all (txCount null).
 */
export type TxCountSource = "explorer" | "rpc_nonce" | "none";

export interface OnChainIntel {
  /**
   * Transaction count. null if genuinely unavailable.
   * Source: the explorer tx list when available; IF the explorer fails, fall back
   * to the RPC nonce (OUTGOING transactions — an activity proxy, not in+out total).
   */
  txCount: number | null;
  /** Where `txCount` came from — MUST be read when displaying/explaining the number. */
  txCountSource: TxCountSource;
  /**
   * Wallet age in days since first transaction. null if unknown.
   * NOTE: only obtainable from the explorer — RPC has no first-transaction
   * history. Because the BSC testnet explorer is deprecated (Etherscan V2 needs
   * a paid plan for chain 97), this field is null in practice on testnet and
   * the rule engine must NOT branch on it. See `novelty` for the honest signal.
   */
  walletAgeInDays: number | null;
  /**
   * True if the address is a smart contract.
   *
   * NOTE: an EIP-7702 delegation designator (`0xef0100` + 20 bytes) is NOT a
   * contract — it is an EOA that delegated its code. Counting it as a contract
   * made Rule 6 hard-REJECT ordinary modern wallets; on BSC testnet every
   * standard Hardhat account answers with a delegation, so this was not an edge
   * case. See `eip7702Delegated`.
   */
  isContract: boolean;
  /**
   * True when the address carries an EIP-7702 delegation designator: an EOA
   * whose code is executed from a delegate contract. Still an EOA for the
   * purpose of "is this a contract", but worth showing in the evidence.
   */
  eip7702Delegated: boolean;
  /**
   * The delegate CONTRACT an EIP-7702 recipient executes its code from, when it is
   * delegated. null otherwise (including a plain EOA and a real contract).
   *
   * This address is where the account has actually been hijacked to: a sweeper
   * delegation points every transfer this EOA receives straight at the attacker's
   * code. So the delegate — not the EOA — is what must be screened, which is why it
   * is a first-class field here instead of being re-derived from the raw bytecode in
   * the pipeline.
   */
  delegateAddress: `0x${string}` | null;
  /** BNB balance. null if unavailable. */
  balanceBNB: number | null;
  /** True if BOTH the explorer and RPC failed to return any data. */
  unavailable: boolean;

  // ── Real, on-chain AEGIS activity (source: AegisVault logs via RPC) ─────────
  /**
   * Escrow activity of this address in AegisVault, read DIRECTLY from the chain
   * via eth_getLogs. This is the replacement for the dead explorer signal: it is
   * real, free, and available on any RPC node.
   */
  aegisEscrowIn: number;
  aegisEscrowOut: number;
  /** Distinct counterparties that ever funded this address through AEGIS. */
  aegisDistinctSenders: number;
  /** Block number of the earliest AEGIS escrow touching this address. */
  aegisFirstSeenBlock: bigint | null;
  /** Block number of the most recent AEGIS escrow touching this address. */
  aegisLastSeenBlock: bigint | null;
  /** True when the vault log query itself failed (unknown, NOT zero). */
  aegisLogsUnavailable: boolean;
  /** True when only a recent block window could be scanned (counts = lower bound). */
  aegisWindowLimited: boolean;

  // ── Honest composite signals derived from the fields above ─────────────────
  /**
   * How "fresh" this account is, expressed ONLY in signals that actually exist.
   *
   * "novel"       — no outgoing tx, zero balance, never seen in the vault.
   * "barelyUsed"   — has sent at least one tx OR holds funds, but no vault history.
   * "established" — has AEGIS escrow history in the vault.
   * "unknown"     — not enough data to tell (logs unavailable / RPC down).
   *
   * NOTE: the previous `isNewWallet` flag claimed `txCount === 0` means "new
   * wallet", but txCount is the OUTGOING nonce — a receive-only account that has
   * been funded many times legitimately shows 0 and was mislabelled "new", which
   * made a hard REJECT rule fire on ordinary users.
   */
  novelty: NoveltyLevel;
  /** True only for `novel` — used by the hard rules. */
  isNovelAccount: boolean;
}

export type NoveltyLevel = "novel" | "barelyUsed" | "established" | "unknown";

/**
 * Classify the bytecode returned by `eth_getCode`.
 *
 * Three cases matter:
 *   - empty            → plain EOA;
 *   - `0xef0100` + 20  → EIP-7702 delegation: an EOA that points its code at a
 *                        delegate contract. Empirically, the standard Hardhat
 *                        test accounts on BSC testnet ALL look like this, so
 *                        treating them as contracts made the contract-receiver
 *                        rule reject normal wallets;
 *   - anything else    → a real contract.
 *
 * The delegate address is returned for the middle case (see `OnChainIntel.
 * delegateAddress`): a 7702 delegation is the standard way a real wallet gets
 * hijacked by a sweeper, so the delegate has to be screened.
 *
 * Exported so the red-team suite can pin this behaviour without an RPC call.
 */
export function classifyCode(code: string | undefined | null): {
  isContract: boolean;
  eip7702Delegated: boolean;
  delegateAddress: `0x${string}` | null;
} {
  if (!code || code === "0x") {
    return { isContract: false, eip7702Delegated: false, delegateAddress: null };
  }
  const hex = code.toLowerCase();
  // 23 bytes of code = "0x" + 46 hex chars (3-byte designator + 20-byte address).
  if (hex.length === 2 + 46 && hex.startsWith("0xef0100")) {
    return {
      isContract: false,
      eip7702Delegated: true,
      delegateAddress: `0x${hex.slice(2 + 6)}` as `0x${string}`,
    };
  }
  return { isContract: true, eip7702Delegated: false, delegateAddress: null };
}

// ── BscScan response shapes ───────────────────────────────────────────────────
interface BscScanTxEntry {
  timeStamp: string;
  [key: string]: unknown;
}

interface BscScanTxListResponse {
  status: string;
  message: string;
  result: BscScanTxEntry[] | string;
}

interface BscScanBalanceResponse {
  status: string;
  message: string;
  result: string;
}

interface BscScanContractABIEntry {
  ABI: string;
  [key: string]: unknown;
}

interface BscScanContractResponse {
  status: string;
  message: string;
  result: BscScanContractABIEntry[] | string;
}

// ── Helpers ───────────────────────────────────────────────────────────────────
async function bscscanGet<T>(
  params: Record<string, string>,
  signal: AbortSignal
): Promise<T | null> {
  const url = new URL(config.BSCSCAN_API_URL);
  for (const [k, v] of Object.entries(params)) {
    url.searchParams.set(k, v);
  }
  if (config.BSCSCAN_API_KEY) {
    url.searchParams.set("apikey", config.BSCSCAN_API_KEY);
  }

  try {
    const response = await fetch(url.toString(), { signal });
    if (!response.ok) return null;
    return (await response.json()) as T;
  } catch {
    return null;
  }
}

function daysSince(timestampSeconds: number): number {
  const now = Date.now() / 1000;
  return (now - timestampSeconds) / 86_400;
}

function parseFirstTxAge(
  result: BscScanTxEntry[]
): { txCount: number; walletAgeInDays: number | null } {
  if (result.length === 0) {
    return { txCount: 0, walletAgeInDays: null };
  }
  const first = result[0];
  const firstTs = first ? Number(first.timeStamp) : NaN;
  const walletAgeInDays =
    !isNaN(firstTs) && firstTs > 0 ? daysSince(firstTs) : null;
  return { txCount: result.length, walletAgeInDays };
}

// ── Recent transactions (for tool calling) ───────────────────────────────────
export interface RecentTx {
  /** Transaction time "YYYY-MM-DD HH:mm" (UTC). */
  time: string;
  direction: "in" | "out";
  /** Counterparty address (not the address being queried). */
  address: string;
  valueBNB: number;
}

/**
 * Fetch the N MOST RECENT transactions (sort desc) of an address,
 * used by the `get_recipient_recent_txs` tool to inspect activity patterns.
 *
 * @returns The transaction list, [] when there genuinely are no transactions,
 *          or null when BscScan is unreachable (unavailable ≠ empty).
 */
export async function getRecentTransactions(
  address: string,
  limit: number = 10
): Promise<RecentTx[] | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.BSCSCAN_TIMEOUT_MS);

  try {
    const resp = await bscscanGet<BscScanTxListResponse>(
      {
        module: "account",
        action: "txlist",
        address: address.toLowerCase(),
        sort: "desc",
        page: "1",
        offset: String(limit),
      },
      controller.signal
    );
    clearTimeout(timer);

    if (!resp) return null;
    if (resp.status === "1" && Array.isArray(resp.result)) {
      const addr = address.toLowerCase();

      return resp.result.slice(0, limit).map((tx): RecentTx => {
        const ts = Number(tx.timeStamp);
        const time =
          !isNaN(ts) && ts > 0
            ? new Date(ts * 1000).toISOString().slice(0, 16).replace("T", " ")
            : "?";

        let valueBNB = 0;
        try {
          valueBNB = Number(BigInt(String(tx.value ?? "0"))) / 1e18;
        } catch {
          valueBNB = 0;
        }
        valueBNB = Math.round(valueBNB * 1e8) / 1e8;

        const from = String(tx.from ?? "").toLowerCase();
        const direction: RecentTx["direction"] = from === addr ? "out" : "in";
        const counterparty = from === addr ? String(tx.to ?? "?") : from;

        return { time, direction, address: counterparty, valueBNB };
      });
    }
    // Only "No transactions found" really means empty.
    // NOTOK / endpoint deprecated / rate limit → null (failure, not empty).
    if (
      resp.status === "0" &&
      typeof resp.result === "string" &&
      resp.result.toLowerCase().includes("no transactions found")
    ) {
      return [];
    }
    return null;
  } catch {
    clearTimeout(timer);
    return null;
  }
}

// ── On-chain AEGIS vault history (real data, free, via RPC) ───────────────────
/**
 * Real AEGIS escrow history read straight from the chain with `eth_getLogs`.
 *
 * Why this replaces the explorer: the BSC testnet explorer is dead (V1
 * deprecated; Etherscan V2 is a paid plan for chain 97), so `walletAgeInDays`
 * can never be populated and every "new wallet" heuristic built on top of it was
 * fabricated — worse, the fallback (`outgoing nonce === 0`) mislabels ordinary
 * receive-only wallets as brand new, which triggered hard REJECTs on regular
 * users. `eth_getLogs` against the vault needs no API key, no plan and no
 * indexer: it is the one on-chain history source that is both free and actually
 * available here, so it becomes the honest signal.
 *
 * Scope limit (stated to the LLM, never hidden): it only sees transfers that went
 * THROUGH AEGIS. It is not a complete history of the address.
 */

const escrowedEvent = {
  type: "event",
  name: "EscrowCreated",
  inputs: [
    { indexed: true, name: "escrowId", type: "bytes32" },
    { indexed: true, name: "sender", type: "address" },
    { indexed: true, name: "recipient", type: "address" },
    { indexed: false, name: "amount", type: "uint256" },
  ],
} as const;

export interface VaultActivity {
  /** Escrows created with this address as the RECIPIENT. */
  escrowIn: number;
  /** Escrows created with this address as the SENDER. */
  escrowOut: number;
  /** Distinct counterparties that ever funded this address through AEGIS. */
  distinctSenders: number;
  /** Block number of the earliest AEGIS escrow touching this address. */
  firstSeenBlock: bigint | null;
  /** Block number of the most recent AEGIS escrow touching this address. */
  lastSeenBlock: bigint | null;
  /**
   * True when the log query failed → every count above is UNKNOWN, not zero.
   * Never let a failed read become "this address has no history".
   */
  unavailable: boolean;
  /**
   * True when only a recent window could be scanned (public RPCs cap the block
   * range of a single eth_getLogs call). The counts are then a LOWER BOUND.
   */
  windowLimited: boolean;
}

const UNKNOWN_VAULT_ACTIVITY: VaultActivity = {
  escrowIn: 0,
  escrowOut: 0,
  distinctSenders: 0,
  firstSeenBlock: null,
  lastSeenBlock: null,
  unavailable: true,
  windowLimited: false,
};

/**
 * Block where the vault was deployed, found by binary search over `eth_getCode`
 * and cached for the process lifetime.
 *
 * Needed because public RPCs refuse `eth_getLogs` from block 0, and we must not
 * silently under-count by scanning only a recent window.
/**
 * Block where the vault was deployed, found by binary search over `eth_getCode`
 * and cached for the process lifetime.
 *
 * Needed because public RPCs refuse `eth_getLogs` from block 0, and we must not
 * silently under-count by scanning only a recent window.
 *
 * `null` means UNKNOWN — the node could not answer, so we know nothing about the
 * deploy block and must anchor the scan at the budget floor with the result
 * flagged as a lower bound. The two ways this happens in the wild, both observed
 * on BSC testnet:
 *   1. the node refuses historical state outright ("Missing or invalid
 *      parameters" / "missing trie node") — it is not an archival node;
 *   2. the node answers "0x" for every historical block even though the contract
 *      has code at the head, i.e. it cannot distinguish "not deployed yet" from
 *      "no historical state" — the bisect then collapses to 0, which is not a
 *      real deploy block and must not be used as one.
 */
let deployBlockPromise: Promise<bigint | null> | null = null;

/**
 * Locate the block the vault was deployed in, by bisecting on bytecode presence.
 *
 * Returns:
 *   0n    — the vault is not deployed at the configured address, so no
 *           EscrowCreated event can ever exist (empty is a real answer here);
 *   block — the resolved deploy block;
 *   null  — the deploy block is UNKNOWN; the caller must scan a bounded window
 *           and report the counts as a lower bound.
 */
async function resolveVaultDeployBlock(): Promise<bigint | null> {
  if (deployBlockPromise) return deployBlockPromise;

  deployBlockPromise = (async (): Promise<bigint | null> => {
    const address = config.CONTRACT_ADDRESS;
    let lo = 0n;
    let hi = await publicClient.getBlockNumber();

    // Confirm the contract is deployed at all before bisecting.
    let headCode: string | undefined;
    try {
      headCode = await publicClient.getCode({ address });
    } catch (err) {
      console.warn(
        `[Vault]  eth_getCode failed at the chain head ` +
          `(${err instanceof Error ? err.message : err}) — AEGIS history UNKNOWN.`
      );
      return null;
    }
    if (!headCode || headCode === "0x") {
      console.warn(
        `[Vault]  No contract code at ${address} — no AEGIS escrow can exist; ` +
          `treating vault history as empty, not as unknown.`
      );
      return 0n;
    }

    // Probe the node's historical support before trusting a bisect over it.
    try {
      await publicClient.getCode({ address, blockNumber: hi / 2n });
    } catch (err) {
      console.warn(
        `[Vault]  The RPC node cannot serve historical state ` +
          `(${err instanceof Error ? err.message : err}) — the vault deploy block is ` +
          `UNKNOWN, so the AEGIS history will be a lower bound over a recent window.`
      );
      return null;
    }

    while (lo < hi) {
      const mid = (lo + hi + 1n) / 2n;
      let code: string | undefined;
      try {
        code = await publicClient.getCode({ address, blockNumber: mid });
      } catch (err) {
        console.warn(
          `[Vault]  eth_getCode at block ${mid} failed ` +
            `(${err instanceof Error ? err.message : err}) — deploy block UNKNOWN.`
        );
        return null;
      }
      if (code && code !== "0x") lo = mid;
      else hi = mid - 1n;
    }

    if (lo === 0n) {
      // The node reported "no code" at every historical block while the head has
      // code: that is a node without usable history, not a genesis deployment.
      console.warn(
        `[Vault]  Bisect collapsed to block 0 while the head has code — treating the ` +
          `deploy block as UNKNOWN and the AEGIS history as a lower bound.`
      );
      return null;
    }

    console.log(`[Vault]  Vault deploy block resolved: ${lo}`);
    return lo;
  })().catch((err) => {
    console.warn(
      `[Vault]  Deploy-block lookup failed (${err instanceof Error ? err.message : err}).`
    );
    return null;
  });

  return deployBlockPromise;
}


/** One EscrowCreated log, as returned by viem. */
type EscrowLog = {
  blockNumber: bigint | null;
  args?: { sender?: string; recipient?: string } | undefined;
};

/** Which side of an escrow the address was on. */
type EscrowSide = "recipient" | "sender";

type LogQuery = {
  fromBlock: bigint;
  toBlock: bigint;
  address: `0x${string}`;
  side: EscrowSide;
};

const CHUNK = BigInt(Math.max(1, config.VAULT_LOG_CHUNK_BLOCKS));
const MIN_CHUNK = BigInt(Math.max(1, config.VAULT_LOG_MIN_CHUNK_BLOCKS));

/**
 * Memo: block range (aligned to CHUNK) → the vault emitted no EscrowCreated
 * event in it.
 *
 * EscrowCreated logs are immutable once the range is behind the head, so "this
 * range has no vault activity" is a permanent fact and can be reused by every
 * later evaluation instead of re-querying the same 50 chunks per address. Without
 * this, one address costs ~100 round-trips (~11 s measured), and the pipeline
 * needs the scan for the recipient, the sender profile and the Advocate's own
 * side evidence.
 *
 * A range whose emptiness could not be proven is simply absent from the map, so
 * a failed probe never becomes a cached "empty".
 */
const emptyRangeMemo = new Map<string, boolean>();
const EMPTY_MEMO_LIMIT = 5_000;

function rangeKey(fromBlock: bigint, toBlock: bigint): string {
  return `${fromBlock}-${toBlock}`;
}

async function fetchLogs(from: bigint, to: bigint, args?: Record<string, `0x${string}`>): Promise<EscrowLog[]> {
  const res = await publicClient.getLogs({
    address: config.CONTRACT_ADDRESS,
    event: escrowedEvent,
    fromBlock: from,
    toBlock: to,
    ...(args ? { args } : {}),
  });
  return res as unknown as EscrowLog[];
}

/**
 * Prove (and remember) that the vault emitted no EscrowCreated in [from, to].
 * Returns false when the node would not answer — the caller must then query the
 * range itself and report the failure.
 */
async function rangeIsProvablyEmpty(from: bigint, to: bigint, depth = 0): Promise<boolean> {
  if (to < from) return true;
  const key = rangeKey(from, to);
  const memo = emptyRangeMemo.get(key);
  if (memo !== undefined) return memo;

  try {
    const logs = await fetchLogs(from, to);
    if (logs.length > 0) return false;
  } catch (err) {
    const span = to - from + 1n;
    if (depth < 24 && span > MIN_CHUNK) {
      const mid = from + span / 2n;
      const [a, b] = await Promise.all([
        rangeIsProvablyEmpty(from, mid - 1n, depth + 1),
        rangeIsProvablyEmpty(mid, to, depth + 1),
      ]);
      return a && b;
    }
    return false;
  }

  if (emptyRangeMemo.size > EMPTY_MEMO_LIMIT) {
    // Oldest-first eviction; the memo is only an optimization, so dropping it is safe.
    const oldest = emptyRangeMemo.keys().next();
    if (!oldest.done) emptyRangeMemo.delete(oldest.value);
  }
  emptyRangeMemo.set(key, true);
  return true;
}

/**
 * Read this address's EscrowCreated logs over [fromBlock, toBlock].
 *
 * The range is cut into CHUNK-sized, CHUNK-aligned blocks, each checked against
 * the range-level memo before spending a request on it, and the chunks are
 * fetched through a small worker pool. A chunk the node still refuses is split in
 * half recursively; a range that ultimately cannot be read is reported in
 * `failed` and the caller must treat the result as a lower bound.
 */
async function getLogsChunked(query: LogQuery): Promise<{
  logs: EscrowLog[];
  failed: Array<{ fromBlock: bigint; toBlock: bigint; error: string }>;
}> {
  const logs: EscrowLog[] = [];
  const failed: Array<{ fromBlock: bigint; toBlock: bigint; error: string }> = [];

  // Aligned ranges: [k*CHUNK, min((k+1)*CHUNK-1, toBlock)], newest last, so the
  // memo is shared across evaluations that start from the same budget floor.
  const firstAligned = (query.fromBlock / CHUNK) * CHUNK;
  const ranges: Array<[bigint, bigint]> = [];
  for (let from = firstAligned; from <= query.toBlock; from += CHUNK) {
    const to = from + CHUNK - 1n > query.toBlock ? query.toBlock : from + CHUNK - 1n;
    ranges.push([from < query.fromBlock ? query.fromBlock : from, to]);
  }

  const run = async (from: bigint, to: bigint, depth: number): Promise<void> => {
    if (to < from) return;
    // A range with provably no vault activity cannot contain this address.
    if (await rangeIsProvablyEmpty(from, to)) return;
    try {
      const res = await fetchLogs(from, to, { [query.side]: query.address } as Record<string, `0x${string}`>);
      logs.push(...res);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const span = to - from + 1n;
      if (depth < 24 && span > MIN_CHUNK) {
        const mid = from + span / 2n;
        await run(from, mid - 1n, depth + 1);
        await run(mid, to, depth + 1);
        return;
      }
      failed.push({ fromBlock: from, toBlock: to, error: msg });
    }
  };

  const concurrency = Math.max(1, config.VAULT_LOG_CONCURRENCY);
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const i = next++;
      if (i >= ranges.length) return;
      const [from, to] = ranges[i]!;
      await run(from, to, 0);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, ranges.length) }, worker));

  return { logs, failed };
}

/** Summarize raw logs into a VaultActivity, flagging a truncated scan. */
function summarizeLogs(
  logs: EscrowLog[],
  opts: { outbound: number; failed: boolean }
): VaultActivity {
  const senders = new Set<string>();
  const blocks: bigint[] = [];
  for (const l of logs) {
    if (l.args?.sender) senders.add(String(l.args.sender).toLowerCase());
    if (l.blockNumber !== null && l.blockNumber !== undefined) blocks.push(l.blockNumber);
  }
  return {
    escrowIn: logs.length,
    escrowOut: opts.outbound,
    distinctSenders: senders.size,
    firstSeenBlock: blocks.length ? blocks.reduce((a, b) => (a < b ? a : b)) : null,
    lastSeenBlock: blocks.length ? blocks.reduce((a, b) => (a > b ? a : b)) : null,
    // A scan that failed on every range taught us nothing → unavailable. A scan
    // that failed on SOME ranges gave us a lower bound → windowLimited.
    unavailable: logs.length === 0 && opts.failed,
    windowLimited: opts.failed,
  };
}

/**
 * Read this address's REAL AEGIS escrow history from the chain.
 * Both directions are queried: what funded it, and what it funded.
 *
 * Range: from the vault's deploy block, bounded by a VAULT_SCAN_LOOKBACK_BLOCKS
 * budget, chunked so public-node range caps cannot wipe out the whole scan.
 */
export async function getVaultActivity(address: string): Promise<VaultActivity> {
  const addr = address.toLowerCase() as `0x${string}`;

  try {
    const [latest, deployBlock] = await Promise.all([
      publicClient.getBlockNumber(),
      resolveVaultDeployBlock(),
    ]);

    const budget = BigInt(config.VAULT_SCAN_LOOKBACK_BLOCKS);
    const floor = latest > budget ? latest - budget : 0n;
    // An UNKNOWN deploy block must never be treated as "history starts at the
    // head" — that is how a scan reports zero escrows on an address that has
    // them. Anchor at the budget floor and mark the result a lower bound.
    const fromBlock = deployBlock !== null && deployBlock > floor ? deployBlock : floor;
    const truncatedByBudget = deployBlock === null || deployBlock < floor;
    if (deployBlock === null) {
      console.warn(
        `[Vault]  Scanning only blocks ${fromBlock}–${latest} for the vault log; ` +
          `older escrows (if any) are not included.`
      );
    }
    if (fromBlock > latest) {
      return { ...UNKNOWN_VAULT_ACTIVITY, unavailable: false, windowLimited: true };
    }

    const [inbound, outbound] = await Promise.all([
      getLogsChunked({ fromBlock, toBlock: latest, address: addr, side: "recipient" }),
      getLogsChunked({ fromBlock, toBlock: latest, address: addr, side: "sender" }),
    ]);

    const failedCount = inbound.failed.length + outbound.failed.length;
    if (failedCount > 0) {
      console.warn(
        `[Vault]  ${address}: ${failedCount} block range(s) refused by the RPC node ` +
          `(e.g. ${(inbound.failed[0] ?? outbound.failed[0])?.error}) — ` +
          `AEGIS history is a LOWER BOUND over blocks ${fromBlock}–${latest}.`
      );
    }

    return summarizeLogs(inbound.logs, {
      outbound: outbound.logs.length,
      failed: failedCount > 0 || truncatedByBudget,
    });
  } catch (err) {
    console.warn(
      `[Vault]  eth_getLogs failed for ${address} ` +
        `(${err instanceof Error ? err.message : err}) — AEGIS history UNKNOWN, not empty.`
    );
    return UNKNOWN_VAULT_ACTIVITY;
  }
}

// ── Cheap RPC intel (tool: get_address_onchain_intel) ─────────────────────────
/**
 * Minimal on-chain facts for ANY in-scope address: nonce, balance and code.
 *
 * Deliberately cheaper than `getOnChainIntel`: no explorer call, and above all
 * no `eth_getLogs` vault scan (that scan costs ~50 chunked round-trips and is
 * already memoised for the two escrow endpoints — running it again for every
 * counterparty the agent decides to inspect would blow the escrow's time budget
 * on a 6 GB box).
 *
 * `novelty` is intentionally ABSENT: classifying it needs the AEGIS vault
 * history, and emitting a partial classification here would invite the model to
 * read "not established" as "novel". The payload says where the full history
 * lives instead.
 */
export interface BasicOnChainIntel {
  address: string;
  /** True when the RPC answered nothing — every field below is then UNKNOWN. */
  unavailable: boolean;
  /** EOA nonce = OUTGOING transactions only (incoming are not counted). */
  nonce: number | null;
  balanceBNB: number | null;
  isContract: boolean;
  eip7702Delegated: boolean;
  codeSizeBytes: number | null;
  /** Which fields the node actually answered. */
  fields: string[];
  fieldsUnavailable: string[];
}

export async function getBasicOnChainIntel(address: string): Promise<BasicOnChainIntel> {
  const addr = address.toLowerCase() as `0x${string}`;
  const [balRes, nonceRes, codeRes] = await Promise.allSettled([
    publicClient.getBalance({ address: addr }),
    publicClient.getTransactionCount({ address: addr }),
    publicClient.getCode({ address: addr }),
  ]);

  const fields: string[] = [];
  const fieldsUnavailable: string[] = [];

  let balanceBNB: number | null = null;
  if (balRes.status === "fulfilled") {
    balanceBNB = Number(balRes.value) / 1e18;
    fields.push("balance");
  } else {
    fieldsUnavailable.push("balance");
  }

  let nonce: number | null = null;
  if (nonceRes.status === "fulfilled") {
    nonce = Number(nonceRes.value);
    fields.push("nonce");
  } else {
    fieldsUnavailable.push("nonce");
  }

  let isContract = false;
  let eip7702Delegated = false;
  let codeSizeBytes: number | null = null;
  if (codeRes.status === "fulfilled") {
    const code = codeRes.value ?? "0x";
    ({ isContract, eip7702Delegated } = classifyCode(code));
    // "0x" (an EOA) is 0 bytes, not UNKNOWN — the node answered.
    codeSizeBytes = Math.max(0, (code.length - 2) / 2);
    fields.push("code");
  } else {
    fieldsUnavailable.push("code");
  }

  if (fieldsUnavailable.length > 0) {
    console.warn(
      `[RPC]    Cheap intel unavailable for ${address}: ${fieldsUnavailable.join(", ")} — ` +
        `those fields are UNKNOWN, not zero.`
    );
  }

  return {
    address,
    unavailable: fields.length === 0,
    nonce,
    balanceBNB,
    isContract,
    eip7702Delegated,
    codeSizeBytes,
    fields,
    fieldsUnavailable,
  };
}

// ── Contract code info (tool: get_contract_code_info) ─────────────────────────
/**
 * Bytecode / proxy / verification state of an address.
 *
 * `sourceVerification` is hardcoded to "unknown" and that is the honest answer
 * on BSC testnet: the explorer endpoint that serves verified source is deprecated
 * for chain 97, and guessing "unverified" from an unreachable endpoint would be
 * exactly the "unavailable became a verdict" bug this codebase keeps fixing.
 */
export interface ContractCodeInfo {
  address: string;
  unavailable: boolean;
  /** Deployed bytecode size in bytes. 0 for an EOA. null when unreadable. */
  codeSizeBytes: number | null;
  isContract: boolean;
  eip7702Delegated: boolean;
  /** EIP-1967 implementation slot (or EIP-1822 legacy slot), when non-zero. */
  proxyImplementation: `0x${string}` | null;
  /** Heuristic: a standard proxy slot holds a non-zero address. */
  isProxy: boolean;
  /** False when the storage reads failed — then isProxy is UNKNOWN, not false. */
  proxySlotsReadable: boolean;
  sourceVerification: "unknown";
  note: string;
}

/** EIP-1967 implementation slot. */
const EIP1967_IMPL_SLOT =
  "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc" as const;
/** EIP-1967 beacon slot (UUPS proxies point here, not at the implementation). */
const EIP1967_BEACON_SLOT =
  "0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50" as const;
/** EIP-1822 (pre-1967 UUPS) slot — still deployed by some frameworks. */
const EIP1822_PROXIABLE_SLOT =
  "0xc5f16f0fcc639fa48a6947836d9850f504798523bf8c9a3a87d5876cf622bcf7" as const;

const PROXY_SLOTS: Array<{ name: string; slot: `0x${string}` }> = [
  { name: "eip1967_implementation", slot: EIP1967_IMPL_SLOT },
  { name: "eip1967_beacon", slot: EIP1967_BEACON_SLOT },
  { name: "eip1822_proxiable", slot: EIP1822_PROXIABLE_SLOT },
];

/** True when a storage slot holds something other than 31 zero bytes. */
function slotHasValue(value: string | undefined | null): boolean {
  if (!value) return false;
  const hex = value.toLowerCase();
  return hex.length > 2 && !/^0x0+$/.test(hex);
}

export async function getContractCodeInfo(address: string): Promise<ContractCodeInfo> {
  const addr = address.toLowerCase() as `0x${string}`;

  let code: string | undefined;
  try {
    code = await publicClient.getCode({ address: addr });
  } catch (err) {
    console.warn(
      `[RPC]    eth_getCode failed for ${address} ` +
        `(${err instanceof Error ? err.message : err}) — contract info UNKNOWN.`
    );
    return {
      address,
      unavailable: true,
      codeSizeBytes: null,
      isContract: false,
      eip7702Delegated: false,
      proxyImplementation: null,
      isProxy: false,
      proxySlotsReadable: false,
      sourceVerification: "unknown",
      note:
        "The RPC node could not return the bytecode for this address. " +
        "Contract status and proxy state are UNKNOWN — do NOT read this as 'not a contract'.",
    };
  }

  const normalized = code ?? "0x";
  const { isContract, eip7702Delegated } = classifyCode(normalized);
  const codeSizeBytes = Math.max(0, (normalized.length - 2) / 2);

  // An EOA (or a 7702 delegation) has no meaningful storage to inspect.
  if (!isContract) {
    return {
      address,
      unavailable: false,
      codeSizeBytes,
      isContract,
      eip7702Delegated,
      proxyImplementation: null,
      isProxy: false,
      proxySlotsReadable: true,
      sourceVerification: "unknown",
      note: eip7702Delegated
        ? "This address is an EOA carrying an EIP-7702 delegation designator: its code is executed from a delegate contract. It is NOT a contract address, and no proxy storage applies."
        : "No bytecode at this address: a plain EOA wallet. There is no contract, no proxy and no verified source.",
    };
  }

  const reads = await Promise.allSettled(
    PROXY_SLOTS.map((s) => publicClient.getStorageAt({ address: addr, slot: s.slot }))
  );
  let proxyImplementation: `0x${string}` | null = null;
  let readable = 0;
  reads.forEach((r) => {
    if (r?.status === "fulfilled") {
      readable += 1;
      if (proxyImplementation === null && slotHasValue(r.value)) {
        proxyImplementation = r.value as `0x${string}`;
      }
    }
  });
  const proxySlotsReadable = readable === PROXY_SLOTS.length;
  const isProxy = readable > 0 && proxyImplementation !== null;

  return {
    address,
    unavailable: false,
    codeSizeBytes,
    isContract,
    eip7702Delegated,
    proxyImplementation,
    isProxy,
    proxySlotsReadable,
    sourceVerification: "unknown",
    note:
      "Verified-source status is UNKNOWN on BSC testnet: the explorer endpoint that serves it is " +
      "not available, so this tool deliberately does not claim 'verified' or 'unverified'. " +
      (isProxy
        ? " A standard proxy slot (EIP-1967 / EIP-1822) is non-zero, which means this contract " +
          "delegates its logic elsewhere — read the implementation address before judging it."
        : " No standard proxy slot was non-zero. That is a heuristic, not a proof of absence: a " +
          "custom proxy or a non-standard slot would not be detected.") +
      (!proxySlotsReadable
        ? " Some storage reads failed, so the proxy verdict above is UNKNOWN rather than false."
        : ""),
  };
}

// ── Main function ─────────────────────────────────────────────────────────────
/**
 * Fetch on-chain intelligence for a given address from BscScan Testnet.
 *
 * Runs balance + tx list + contract check in parallel.
 * On full failure, returns unavailable=true with null fields.
 *
 * BscScan is ON-CHAIN INTELLIGENCE, not a security oracle.
 * Do NOT conclude: wallet old = safe, many txs = safe.
 */
export async function getOnChainIntel(address: string): Promise<OnChainIntel> {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    config.BSCSCAN_TIMEOUT_MS
  );

  const addr = address.toLowerCase();

  try {
    // ── Parallel calls ────────────────────────────────────────────────────────
    // The vault log query runs alongside the explorer + RPC calls: it is the
    // only working on-chain history source on testnet, so it must not be
    // serialised behind the (currently dead) explorer endpoints.
    const [txListResp, balanceResp, contractResp, vault] = await Promise.all([
      bscscanGet<BscScanTxListResponse>(
        {
          module: "account",
          action: "txlist",
          address: addr,
          sort: "asc",
          page: "1",
          offset: "10000",
        },
        controller.signal
      ),
      bscscanGet<BscScanBalanceResponse>(
        { module: "account", action: "balance", address: addr, tag: "latest" },
        controller.signal
      ),
      bscscanGet<BscScanContractResponse>(
        { module: "contract", action: "getabi", address: addr },
        controller.signal
      ),
      getVaultActivity(addr),
    ]);

    clearTimeout(timer);

    // ── Parse tx count & wallet age ───────────────────────────────────────────
    let txCount: number | null = null;
    let txCountSource: TxCountSource = "none";
    let walletAgeInDays: number | null = null;

    if (txListResp && txListResp.status === "1" && Array.isArray(txListResp.result)) {
      const parsed = parseFirstTxAge(txListResp.result);
      txCount = parsed.txCount;
      txCountSource = "explorer";
      walletAgeInDays = parsed.walletAgeInDays;
    } else if (
      txListResp &&
      txListResp.status === "0" &&
      typeof txListResp.result === "string" &&
      txListResp.result.toLowerCase().includes("no transactions found")
    ) {
      // "No transactions found" — valid empty response
      txCount = 0;
      txCountSource = "explorer";
      walletAgeInDays = null;
    }
    // Any OTHER status "0" (NOTOK / endpoint deprecated / rate limit) must NOT
    // be read as "0 transactions" — leave it null (API failure ≠ empty wallet).

    // ── Parse balance ─────────────────────────────────────────────────────────
    let balanceBNB: number | null = null;
    if (balanceResp && balanceResp.status === "1" && typeof balanceResp.result === "string") {
      try {
        const wei = BigInt(balanceResp.result);
        balanceBNB = Number(wei) / 1e18;
      } catch {
        balanceBNB = null;
      }
    }

    // ── Is contract? ──────────────────────────────────────────────────────────
    const isContractFromExplorer =
      !!contractResp &&
      contractResp.status === "1" &&
      Array.isArray(contractResp.result) &&
      contractResp.result.length > 0 &&
      contractResp.result[0]?.ABI !== "Contract source code not verified";

    let isContract = isContractFromExplorer;
    let eip7702Delegated = false;
    let delegateAddress: `0x${string}` | null = null;

    // ── Fallback & ground-truth via RPC node ──────────────────────────────────
    // The BscScan V1 explorer endpoint is deprecated and chain 97 is NOT in the
    // free Etherscan V2 tier (paid-only) — explorer data can die completely.
    // Balance, nonce (outgoing transactions) and contract code remain available
    // for FREE from the same RPC node the whole app already uses.
    // Wallet age CANNOT be fetched from RPC → stays null ("unknown").
    const addr0x = addr as `0x${string}`;
    const [balRes, nonceRes, codeRes] = await Promise.allSettled([
      publicClient.getBalance({ address: addr0x }),
      publicClient.getTransactionCount({ address: addr0x }),
      publicClient.getCode({ address: addr0x }),
    ]);

    if (balRes.status === "fulfilled") {
      balanceBNB = Number(balRes.value) / 1e18;
    }
    if (txCount === null && nonceRes.status === "fulfilled") {
      // Activity proxy: EOA nonce = number of OUTGOING transactions (not in+out total).
      txCount = Number(nonceRes.value);
      txCountSource = "rpc_nonce";
    }
    if (codeRes.status === "fulfilled" && codeRes.value !== undefined) {
      // getCode is the ground truth for contract status (more reliable than the
      // explorer ABI heuristic, which also dies once the endpoint is deprecated).
      ({ isContract, eip7702Delegated, delegateAddress } = classifyCode(codeRes.value));
    }

    // ── isNewWallet → honest novelty classification ───────────────────────────
    const allNull =
      txCount === null && walletAgeInDays === null && balanceBNB === null;

    const novelty = classifyNovelty({
      txCount,
      balanceBNB,
      escrowIn: vault.escrowIn,
      escrowOut: vault.escrowOut,
    });

    return {
      txCount,
      txCountSource,
      walletAgeInDays,
      isContract,
      eip7702Delegated,
      delegateAddress,
      balanceBNB,
      unavailable: allNull,
      aegisEscrowIn: vault.escrowIn,
      aegisEscrowOut: vault.escrowOut,
      aegisDistinctSenders: vault.distinctSenders,
      aegisFirstSeenBlock: vault.firstSeenBlock,
      aegisLastSeenBlock: vault.lastSeenBlock,
      aegisLogsUnavailable: vault.unavailable,
      aegisWindowLimited: vault.windowLimited,
      novelty,
      isNovelAccount: novelty === "novel",
    };
  } catch (err) {
    clearTimeout(timer);
    console.warn(`[BscScan] Error fetching intel for ${address}:`, err);
    return unknownIntel();
  }
}

/**
 * Classify how "fresh" an account is, using ONLY signals that actually exist.
 *
 * The old `isNewWallet = (txCount === 0)` was a fabrication: txCount is the
 * OUTGOING nonce, so a receive-only account that has been funded 50 times shows
 * 0 and was labelled "brand new" — then hard-rejected. Wallet age, the field
 * that would actually answer the question, needs an indexer and is unavailable.
 *
 * Rules (all from real RPC data):
 *   - the account has interacted with the AEGIS vault  → "established"
 *   - the account has sent a tx, or holds funds        → "barelyUsed"
 *   - nothing outgoing, zero balance                    → "novel"
 *   - not enough data                                  → "unknown"
 *
 * "novel" and "barelyUsed" are decided from RPC facts ONLY (nonce + balance).
 * The vault log can promote an account to "established" but can never demote it
 * — and when the log is unreachable we must NOT pretend the account has no vault
 * history, which is why the labels avoid claiming anything about it. Callers
 * that need the vault history must read aegisLogsUnavailable explicitly.
 */
function classifyNovelty(input: {
  txCount: number | null;
  balanceBNB: number | null;
  escrowIn: number;
  escrowOut: number;
}): NoveltyLevel {
  const { txCount, balanceBNB, escrowIn, escrowOut } = input;

  if (escrowIn > 0 || escrowOut > 0) return "established";

  // Both the nonce and the balance are RPC facts, so "novel" is only claimed
  // when we actually have them.
  if (txCount === null || balanceBNB === null) return "unknown";

  // "novel"/"barelyUsed" are RPC-only verdicts (nonce + balance). They are NOT
  // claims about AEGIS history: an unreachable vault log can neither promote nor
  // demote them, and the caller must surface aegisLogsUnavailable so that a
  // failed log is never read as "no AEGIS history".

  const neverSent = txCount === 0;
  const noFunds = balanceBNB === 0;

  if (neverSent && noFunds) return "novel";
  return "barelyUsed";
}

/**
 * Plain-language label for a novelty level.
 *
 * Exported so the LLM prompts and the tool payloads describe the classification
 * in the same words — the label is deliberately explicit that UNKNOWN is not
 * "new", which is exactly the confusion the old `isNewWallet` flag caused.
 */
export function describeNovelty(novelty: NoveltyLevel): string {
  switch (novelty) {
    case "novel":
      return "NOVEL — RPC facts only: nonce 0 (never sent a transaction) and zero balance";
    case "barelyUsed":
      return "in use — RPC facts only: has sent a transaction (nonce > 0) or holds a balance";
    case "established":
      return "established — has AEGIS escrow history in the on-chain vault log";
    default:
      return "UNKNOWN — not enough data to classify (do NOT read this as 'new')";
  }
}

/** Every field explicitly unknown — used when intel collection throws. */
export function unknownIntel(): OnChainIntel {
  return {
    txCount: null,
    txCountSource: "none",
    walletAgeInDays: null,
    isContract: false,
    eip7702Delegated: false,
    delegateAddress: null,
    balanceBNB: null,
    unavailable: true,
    aegisEscrowIn: 0,
    aegisEscrowOut: 0,
    aegisDistinctSenders: 0,
    aegisFirstSeenBlock: null,
    aegisLastSeenBlock: null,
    aegisLogsUnavailable: true,
    aegisWindowLimited: false,
    novelty: "unknown",
    isNovelAccount: false,
  };
}

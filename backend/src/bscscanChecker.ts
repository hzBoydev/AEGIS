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
   * history, so this field stays null while the explorer is down.
   */
  walletAgeInDays: number | null;
  /** True if walletAgeInDays < NEW_WALLET_DAYS; when age is unknown, based on txCount === 0. */
  isNewWallet: boolean;
  /** True if the address is a smart contract. */
  isContract: boolean;
  /** BNB balance. null if unavailable. */
  balanceBNB: number | null;
  /** True if BOTH the explorer and RPC failed to return any data. */
  unavailable: boolean;
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
    const [txListResp, balanceResp, contractResp] = await Promise.all([
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
      isContract = codeRes.value !== "0x";
    }

    // ── isNewWallet ───────────────────────────────────────────────────────────
    const isNewWallet =
      walletAgeInDays !== null
        ? walletAgeInDays < config.NEW_WALLET_DAYS
        : txCount === 0; // no txs = treat as new

    const allNull =
      txCount === null && walletAgeInDays === null && balanceBNB === null;

    return {
      txCount,
      txCountSource,
      walletAgeInDays,
      isNewWallet,
      isContract,
      balanceBNB,
      unavailable: allNull,
    };
  } catch (err) {
    clearTimeout(timer);
    console.warn(`[BscScan] Error fetching intel for ${address}:`, err);
    return {
      txCount: null,
      txCountSource: "none",
      walletAgeInDays: null,
      isNewWallet: false,
      isContract: false,
      balanceBNB: null,
      unavailable: true,
    };
  }
}

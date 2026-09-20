import { config } from "./config.js";

// ── Types ─────────────────────────────────────────────────────────────────────
export interface OnChainIntel {
  /** Total outgoing + incoming transactions. null if unavailable. */
  txCount: number | null;
  /** Wallet age in days since first transaction. null if no txs or unavailable. */
  walletAgeInDays: number | null;
  /** True if walletAgeInDays < NEW_WALLET_DAYS threshold. */
  isNewWallet: boolean;
  /** True if the address is a smart contract. */
  isContract: boolean;
  /** BNB balance. null if unavailable. */
  balanceBNB: number | null;
  /** True if BscScan data is fully unavailable (API error). */
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
    let walletAgeInDays: number | null = null;

    if (txListResp && txListResp.status === "1" && Array.isArray(txListResp.result)) {
      const parsed = parseFirstTxAge(txListResp.result);
      txCount = parsed.txCount;
      walletAgeInDays = parsed.walletAgeInDays;
    } else if (txListResp && txListResp.status === "0") {
      // "No transactions found" — valid empty response
      txCount = 0;
      walletAgeInDays = null;
    }

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
    const isContract =
      !!contractResp &&
      contractResp.status === "1" &&
      Array.isArray(contractResp.result) &&
      contractResp.result.length > 0 &&
      contractResp.result[0]?.ABI !== "Contract source code not verified";

    // ── isNewWallet ───────────────────────────────────────────────────────────
    const isNewWallet =
      walletAgeInDays !== null
        ? walletAgeInDays < config.NEW_WALLET_DAYS
        : txCount === 0; // no txs = treat as new

    const allNull =
      txCount === null && walletAgeInDays === null && balanceBNB === null;

    return {
      txCount,
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
      walletAgeInDays: null,
      isNewWallet: false,
      isContract: false,
      balanceBNB: null,
      unavailable: true,
    };
  }
}

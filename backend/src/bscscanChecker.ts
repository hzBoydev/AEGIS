import { config, publicClient } from "./config.js";

// ── Types ─────────────────────────────────────────────────────────────────────
export interface OnChainIntel {
  /**
   * Jumlah transaksi. null jika benar-benar tidak tersedia.
   * Sumber: daftar tx explorer bila aktif; JIKA explorer gagal, fallback ke
   * nonce RPC (transaksi KELUAR — proxy aktivitas, bukan total in+out).
   */
  txCount: number | null;
  /**
   * Wallet age in days since first transaction. null jika tidak diketahui.
   * CATATAN: hanya bisa diambil dari explorer — RPC tidak punya riwayat
   * transaksi pertama, sehingga saat explorer down field ini tetap null.
   */
  walletAgeInDays: number | null;
  /** True jika walletAgeInDays < NEW_WALLET_DAYS; jika usia tak diketahui, berbasis txCount === 0. */
  isNewWallet: boolean;
  /** True if the address is a smart contract. */
  isContract: boolean;
  /** BNB balance. null if unavailable. */
  balanceBNB: number | null;
  /** True if BOTH explorer dan RPC gagal mengembalikan data apa pun. */
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

// ── Recent transactions (untuk tool calling) ──────────────────────────────────
export interface RecentTx {
  /** Waktu transaksi "YYYY-MM-DD HH:mm" (UTC). */
  waktu: string;
  arah: "masuk" | "keluar";
  /** Alamat lawan transaksi (bukan address yang di-query). */
  alamat: string;
  nilaiBNB: number;
}

/**
 * Ambil N transaksi TERAKHIR (sort desc) milik sebuah alamat,
 * dipakai oleh tool `get_recipient_recent_txs` untuk melihat pola aktivitas.
 *
 * @returns Daftar transaksi, [] jika memang tidak ada transaksi,
 *          atau null jika BscScan gagal dijangkau (unavailable ≠ kosong).
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
        const waktu =
          !isNaN(ts) && ts > 0
            ? new Date(ts * 1000).toISOString().slice(0, 16).replace("T", " ")
            : "?";

        let nilaiBNB = 0;
        try {
          nilaiBNB = Number(BigInt(String(tx.value ?? "0"))) / 1e18;
        } catch {
          nilaiBNB = 0;
        }
        nilaiBNB = Math.round(nilaiBNB * 1e8) / 1e8;

        const from = String(tx.from ?? "").toLowerCase();
        const arah: RecentTx["arah"] = from === addr ? "keluar" : "masuk";
        const alamat = from === addr ? String(tx.to ?? "?") : from;

        return { waktu, arah, alamat, nilaiBNB };
      });
    }
    // "No transactions found" saja yang berarti benar-benar kosong.
    // NOTOK / endpoint deprecated / rate limit → null (gagal, bukan kosong).
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
    let walletAgeInDays: number | null = null;

    if (txListResp && txListResp.status === "1" && Array.isArray(txListResp.result)) {
      const parsed = parseFirstTxAge(txListResp.result);
      txCount = parsed.txCount;
      walletAgeInDays = parsed.walletAgeInDays;
    } else if (
      txListResp &&
      txListResp.status === "0" &&
      typeof txListResp.result === "string" &&
      txListResp.result.toLowerCase().includes("no transactions found")
    ) {
      // "No transactions found" — valid empty response
      txCount = 0;
      walletAgeInDays = null;
    }
    // status "0" LAINNYA (NOTOK / endpoint deprecated / rate limit) TIDAK boleh
    // dianggap "0 transaksi" — biarkan null (API gagal ≠ dompet kosong).

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
    // Endpoint explorer BscScan V1 sudah deprecated dan chain 97 TIDAK ada di
    // tier gratis Etherscan V2 (paid-only) — data explorer bisa mati total.
    // Balance, nonce (transaksi keluar), dan code contract tetap tersedia
    // GRATIS dari RPC node yang sama yang dipakai seluruh aplikasi ini.
    // Usia wallet TIDAK bisa diambil dari RPC → tetap null ("tidak diketahui").
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
      // Proxy aktivitas: nonce EOA = jumlah transaksi KELUAR (bukan total in+out).
      txCount = Number(nonceRes.value);
    }
    if (codeRes.status === "fulfilled" && codeRes.value !== undefined) {
      // getCode adalah ground truth untuk status contract (lebih andal dari
      // heuristic ABI explorer yang ikut mati saat endpoint deprecated).
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

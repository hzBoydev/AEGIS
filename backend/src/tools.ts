import { checkAddressSecurity } from "./goplusChecker.js";
import { getOnChainIntel, getRecentTransactions } from "./bscscanChecker.js";
import {
  getSenderEscrowHistory,
  getRecipientEscrowHistory,
} from "./db.js";

// ── Types ─────────────────────────────────────────────────────────────────────
export interface ToolContext {
  /** Alamat pengirim escrow (0x...). */
  sender: string;
  /** Alamat penerima escrow (0x...). */
  recipient: string;
}

export interface ToolDefinition {
  /** Nama tool — satu-satunya nilai yang sah muncul di needsData LLM. */
  name: string;
  /** Deskripsi singkat untuk katalog prompt. */
  description: string;
}

export interface ToolExecutionResult {
  /** Nama tool yang diminta LLM (sudah divalidasi terhadap katalog). */
  requested: string[];
  /** Tool yang berhasil dieksekusi. */
  succeeded: string[];
  /** Tool yang gagal (API down, dst). */
  failed: string[];
  /** Blok teks siap-suntik ke prompt putaran ke-2. */
  block: string;
}

// ── Katalog tool (sumber kebenaran untuk validasi needsData) ──────────────────
export const TOOL_CATALOG: ToolDefinition[] = [
  {
    name: "get_sender_profile",
    description:
      "Profil on-chain pengirim (saldo, umur wallet, jumlah transaksi, apakah contract) + reputasi keamanan GoPlus untuk alamat pengirim.",
  },
  {
    name: "get_recipient_recent_txs",
    description:
      "10 transaksi terakhir milik penerima (waktu, arah masuk/keluar, alamat lawan transaksi, nominal BNB) untuk melihat pola aktivitas dan velocity.",
  },
  {
    name: "get_sender_db_history",
    description:
      "Riwayat escrow AEGIS dari pengirim ini: total pernah mengirim, berapa disetujui/ditolak, serta daftar penerima lain yang pernah dikirimi.",
  },
  {
    name: "get_recipient_db_history",
    description:
      "Semua escrow AEGIS yang pernah ditujukan ke penerima ini dari berbagai pengirim berbeda (deteksi penerima sebagai titik kumpul dana).",
  },
];

export const TOOL_NAMES: ReadonlySet<string> = new Set(
  TOOL_CATALOG.map((t) => t.name)
);

/**
 * Validasi `needsData` LLM terhadap katalog.
 * Nama di luar katalog tidak pernah dieksekusi (injection / hallucination).
 */
export function sanitizeNeedsData(raw: readonly string[]): {
  requested: string[];
  dropped: string[];
} {
  const requested = raw.filter((n) => TOOL_NAMES.has(n));
  const dropped = raw.filter((n) => !TOOL_NAMES.has(n));
  return { requested, dropped };
}

/** Batas total karakter blok tool agar prompt putaran ke-2 tetap ringan. */
const BLOCK_CHAR_LIMIT = 6000;

// ── Eksekutor per tool ────────────────────────────────────────────────────────
async function runSenderProfile(ctx: ToolContext): Promise<string> {
  const [intel, security] = await Promise.all([
    getOnChainIntel(ctx.sender),
    checkAddressSecurity(ctx.sender),
  ]);

  return JSON.stringify({
    alamat: ctx.sender,
    onChain: {
      txCount: intel.txCount,
      umurHari:
        intel.walletAgeInDays !== null
          ? Number(intel.walletAgeInDays.toFixed(1))
          : null,
      saldoBNB:
        intel.balanceBNB !== null
          ? Number(intel.balanceBNB.toFixed(6))
          : null,
      isNewWallet: intel.isNewWallet,
      isContract: intel.isContract,
      unavailable: intel.unavailable,
    },
    goplus: {
      status: security.status,
      flags: security.riskFlags,
      catatan:
        security.status === "unavailable"
          ? "GoPlus tidak tersedia — anggap TIDAK DIKETAHUI, bukan aman."
          : undefined,
    },
  });
}

async function runRecipientRecentTxs(ctx: ToolContext): Promise<string> {
  const txs = await getRecentTransactions(ctx.recipient, 10);
  if (txs === null) {
    throw new Error("BscScan txlist tidak tersedia");
  }
  if (txs.length === 0) {
    return JSON.stringify({
      catatan: "Penerima ini tidak memiliki transaksi tercatat di BSC Testnet.",
    });
  }
  return JSON.stringify({ jumlah: txs.length, transaksi: txs });
}

function runSenderDbHistory(ctx: ToolContext): string {
  const h = getSenderEscrowHistory(ctx.sender);
  return JSON.stringify({
    totalEscrow: h.total,
    disetujui: h.approved,
    ditolak: h.rejected,
    penerimaLain: h.otherRecipients,
    escrowTerakhir: h.recent,
  });
}

function runRecipientDbHistory(ctx: ToolContext): string {
  const h = getRecipientEscrowHistory(ctx.recipient);
  return JSON.stringify({
    totalEscrow: h.total,
    disetujui: h.approved,
    ditolak: h.rejected,
    pengirimBerbeda: h.distinctSenders,
    escrowTerakhir: h.recent,
  });
}

async function runSingleTool(name: string, ctx: ToolContext): Promise<string> {
  switch (name) {
    case "get_sender_profile":
      return runSenderProfile(ctx);
    case "get_recipient_recent_txs":
      return runRecipientRecentTxs(ctx);
    case "get_sender_db_history":
      return runSenderDbHistory(ctx);
    case "get_recipient_db_history":
      return runRecipientDbHistory(ctx);
    default:
      throw new Error(`Tool tidak dikenal: ${name}`);
  }
}

// ── Eksekusi massal (paralel, tiap tool gagal-terisolasi) ─────────────────────
/**
 * Jalankan semua tool yang diminta LLM secara paralel.
 *
 * Sifat keamanan:
 * - Tool HANYA menghasilkan bukti tambahan; tool TIDAK PERNAH menentukan
 *   keputusan eligible/confidence (tetap di LLM + threshold + hard rules).
 * - Kegagalan tool dilaporkan eksplisit sebagai "GAGAL / tidak diketahui"
 *   ke prompt — kegagalan API tidak pernah dianggap aman.
 * - Gagal total pun tetap menghasilkan blok berisi penanda kegagalan,
 *   caller yang memutuskan apakah layak putaran ke-2.
 */
export async function executeTools(
  requested: string[],
  ctx: ToolContext
): Promise<ToolExecutionResult> {
  const results = await Promise.all(
    requested.map(async (name) => {
      try {
        const out = await runSingleTool(name, ctx);
        return { name, ok: true, out };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          name,
          ok: false,
          out: JSON.stringify({
            status: "GAGAL",
            error: msg,
            catatan:
              "Tool gagal dijalankan. Anggap data ini TIDAK DIKETAHUI, bukan aman.",
          }),
        };
      }
    })
  );

  const succeeded = results.filter((r) => r.ok).map((r) => r.name);
  const failed = results.filter((r) => !r.ok).map((r) => r.name);

  const block = results
    .map((r) => `=== HASIL TOOL: ${r.name} ===\n${r.out}`)
    .join("\n\n")
    .slice(0, BLOCK_CHAR_LIMIT);

  return { requested, succeeded, failed, block };
}

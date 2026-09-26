import { getDb } from "./db.js";

export interface AddressMemory {
  totalSeen: number;
  totalRejected: number;
  totalApproved: number;
  avgConfidence: number;
  dominantRiskLevel: string | null;
  seenRiskFlags: string[];
  hadHardRuleReject: boolean;
  firstSeenAt: string | null;
  lastSeenAt: string | null;
  recentDecisions: RecentDecision[];
}

export interface RecentDecision {
  eligible: boolean;
  confidence: number;
  riskLevel: string;
  decidedBy: string;
  amount: string;
  createdAt: string;
}

// Koneksi yang sama dengan db.ts (satu koneksi per proses — anti SQLITE_BUSY)
const db = getDb();

/**
 * Ambil riwayat keputusan AEGIS untuk satu alamat (sebagai recipient).
 * Hasilnya digunakan sebagai konteks memori untuk prompt LLM.
 */
export function getAddressMemory(address: string): AddressMemory {
  const addr = address.toLowerCase();

  const agg = db
    .prepare(
      "SELECT COUNT(*) AS totalSeen, " +
      "SUM(CASE WHEN eligible = 0 THEN 1 ELSE 0 END) AS totalRejected, " +
      "SUM(CASE WHEN eligible = 1 THEN 1 ELSE 0 END) AS totalApproved, " +
      "AVG(confidence) AS avgConfidence, " +
      "MIN(created_at) AS firstSeenAt, MAX(created_at) AS lastSeenAt " +
      "FROM decisions WHERE LOWER(recipient) = ?"
    )
    .get(addr) as {
    totalSeen: number;
    totalRejected: number;
    totalApproved: number;
    avgConfidence: number | null;
    firstSeenAt: string | null;
    lastSeenAt: string | null;
  } | null;

  if (!agg || agg.totalSeen === 0) {
    return {
      totalSeen: 0,
      totalRejected: 0,
      totalApproved: 0,
      avgConfidence: 0,
      dominantRiskLevel: null,
      seenRiskFlags: [],
      hadHardRuleReject: false,
      firstSeenAt: null,
      lastSeenAt: null,
      recentDecisions: [],
    };
  }

  const riskRow = db
    .prepare(
      "SELECT risk_level FROM decisions " +
      "WHERE LOWER(recipient) = ? AND risk_level IS NOT NULL " +
      "GROUP BY risk_level ORDER BY COUNT(*) DESC LIMIT 1"
    )
    .get(addr) as { risk_level: string } | null;

  const hardRuleRow = db
    .prepare(
      "SELECT 1 FROM decisions " +
      "WHERE LOWER(recipient) = ? AND decided_by = 'hard_rule' LIMIT 1"
    )
    .get(addr);

  const flagRows = db
    .prepare(
      "SELECT risk_flags FROM decisions " +
      "WHERE LOWER(recipient) = ? AND risk_flags IS NOT NULL"
    )
    .all(addr) as { risk_flags: string }[];

  const seenRiskFlags = Array.from(
    new Set(
      flagRows.flatMap((r) => {
        try { return JSON.parse(r.risk_flags) as string[]; }
        catch { return []; }
      })
    )
  );

  const recentRows = db
    .prepare(
      "SELECT eligible, confidence, risk_level, decided_by, amount, created_at " +
      "FROM decisions WHERE LOWER(recipient) = ? " +
      "ORDER BY created_at DESC LIMIT 3"
    )
    .all(addr) as Array<{
    eligible: number;
    confidence: number;
    risk_level: string;
    decided_by: string;
    amount: string;
    created_at: string;
  }>;

  return {
    totalSeen: agg.totalSeen,
    totalRejected: agg.totalRejected,
    totalApproved: agg.totalApproved,
    avgConfidence: agg.avgConfidence ?? 0,
    dominantRiskLevel: riskRow?.risk_level ?? null,
    seenRiskFlags,
    hadHardRuleReject: !!hardRuleRow,
    firstSeenAt: agg.firstSeenAt,
    lastSeenAt: agg.lastSeenAt,
    recentDecisions: recentRows.map((r) => ({
      eligible: r.eligible === 1,
      confidence: r.confidence,
      riskLevel: r.risk_level ?? "UNKNOWN",
      decidedBy: r.decided_by ?? "unknown",
      amount: r.amount,
      createdAt: r.created_at,
    })),
  };
}

/**
 * Format AddressMemory menjadi teks siap-inject ke prompt LLM.
 * Jika belum ada riwayat, kembalikan keterangan "pertama kali".
 */
export function formatMemoryForPrompt(memory: AddressMemory): string {
  if (memory.totalSeen === 0) {
    return "MEMORI HISTORIS AEGIS:\n  Alamat ini BELUM PERNAH dilihat sebelumnya oleh sistem AEGIS. Ini adalah evaluasi pertama.";
  }

  const rejRate = ((memory.totalRejected / memory.totalSeen) * 100).toFixed(0);
  const flags =
    memory.seenRiskFlags.length > 0
      ? memory.seenRiskFlags.join(", ")
      : "tidak ada";
  const hardWarnLine = memory.hadHardRuleReject
    ? "\n  PERINGATAN: Alamat ini PERNAH ditolak oleh hard security rule (GoPlus/blacklist)."
    : "";

  const recentLines = memory.recentDecisions
    .map(
      (d, i) =>
        "  [" + (i + 1) + "] " + (d.eligible ? "APPROVED" : "REJECTED") +
        " | " + d.amount + " BNB" +
        " | risk=" + d.riskLevel +
        " | confidence=" + (d.confidence * 100).toFixed(0) + "%" +
        " | by=" + d.decidedBy +
        " | " + d.createdAt
    )
    .join("\n");

  const parts: string[] = [
    "MEMORI HISTORIS AEGIS (konteks dari database keputusan sebelumnya):",
    "  Total evaluasi            : " + memory.totalSeen + "x",
    "  Disetujui                 : " + memory.totalApproved + "x",
    "  Ditolak                   : " + memory.totalRejected + "x (tingkat penolakan: " + rejRate + "%)",
    "  Avg confidence sebelumnya : " + (memory.avgConfidence * 100).toFixed(1) + "%",
    "  Risk level dominan        : " + (memory.dominantRiskLevel ?? "tidak ada"),
    "  Risk flags pernah terlihat: " + flags,
    "  Pertama dilihat           : " + (memory.firstSeenAt ?? "-"),
    "  Terakhir dilihat          : " + (memory.lastSeenAt ?? "-"),
    hardWarnLine,
  ];

  if (memory.recentDecisions.length > 0) {
    parts.push("\n  3 Keputusan Terakhir:\n" + recentLines);
  }

  parts.push(
    "\nGUNAKAN KONTEKS INI: Jika alamat ini sering ditolak atau pernah terkena hard rule, " +
    "tingkatkan kewaspadaan dan berikan bobot lebih pada riwayat negatif tersebut."
  );

  return parts.filter((l) => l !== "").join("\n");
}

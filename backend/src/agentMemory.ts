import Database from "better-sqlite3";

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

// Uses the same DB as db.ts (shared SQLite file)
const db = new Database("aegis.db", { readonly: false, fileMustExist: false });

/**
 * Fetch the AEGIS decision history for one address (as recipient).
 * The result is used as memory context for the LLM prompt.
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
 * Format AddressMemory as text ready to inject into the LLM prompt.
 * If there is no history yet, return the "first time" notice.
 */
export function formatMemoryForPrompt(memory: AddressMemory): string {
  if (memory.totalSeen === 0) {
    return "AEGIS HISTORICAL MEMORY (INTERNAL history — NOT on-chain data):\n  This address has NEVER transacted via AEGIS before (internal history is empty). This is the first evaluation.";
  }

  const rejRate = ((memory.totalRejected / memory.totalSeen) * 100).toFixed(0);
  const flags =
    memory.seenRiskFlags.length > 0
      ? memory.seenRiskFlags.join(", ")
      : "none";
  const hardWarnLine = memory.hadHardRuleReject
    ? "\n  WARNING: This address WAS REJECTED before by a hard security rule (GoPlus/blacklist)."
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
    "AEGIS HISTORICAL MEMORY (system INTERNAL history — NOT on-chain data):",
    "  Transactions via AEGIS  : " + memory.totalSeen + "x (AEGIS DATABASE history — not the on-chain transaction count)",
    "  Approved                : " + memory.totalApproved + "x",
    "  Rejected                : " + memory.totalRejected + "x (rejection rate: " + rejRate + "%)",
    "  Avg confidence previously: " + (memory.avgConfidence * 100).toFixed(1) + "%",
    "  Dominant risk level     : " + (memory.dominantRiskLevel ?? "none"),
    "  Risk flags ever seen    : " + flags,
    "  First seen              : " + (memory.firstSeenAt ?? "-"),
    "  Last seen               : " + (memory.lastSeenAt ?? "-"),
    hardWarnLine,
  ];

  if (memory.recentDecisions.length > 0) {
    parts.push("\n  3 Most Recent Decisions:\n" + recentLines);
  }

  parts.push(
    "\nUSE THIS CONTEXT: State these facts to the user in the reason — how many times this " +
    "account has transacted via AEGIS and how many times it was rejected. If this address is " +
    "rejected often or has ever hit a hard rule, raise your guard and give that negative " +
    "history more weight."
  );

  return parts.filter((l) => l !== "").join("\n");
}

/**
 * ONE-LINE memory summary to be inserted as the "Facts" line in the
 * final reason shown to the user — guaranteed to appear even if the LLM
 * forgets to mention it in its reasoning.
 */
export function formatMemoryFacts(memory: AddressMemory): string {
  if (memory.totalSeen === 0) {
    return "never before (first evaluation)";
  }
  return (
    memory.totalSeen +
    "x (approved " + memory.totalApproved + "x, rejected " + memory.totalRejected + "x" +
    (memory.hadHardRuleReject ? ", previously hit a hard rule" : "") + ")"
  );
}

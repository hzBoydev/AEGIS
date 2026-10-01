import { db } from "./db.js";

export interface AddressMemory {
  /** Finalized escrows where this address was the recipient. */
  totalSeen: number;
  totalRejected: number;
  totalApproved: number;
  /**
   * Average confidence over decisions that ACTUALLY produced a verdict
   * (llm / human). fail_safe rows are excluded on purpose: they store a
   * hardcoded 1.0 that means "we could not analyse this", not "we were
   * certain" — averaging them in would inflate this number into nonsense.
   */
  avgConfidence: number;
  /** True when avgConfidence has no usable sample (no llm/human decisions yet). */
  avgConfidenceKnown: boolean;
  dominantRiskLevel: string | null;
  seenRiskFlags: string[];
  /**
   * True when the address was ever blocked by something stronger than the LLM
   * alone: a hard rule, the GoPlus override, a fail-safe, or a human veto.
   * Previously this only matched decided_by='hard_rule', which hid every
   * human rejection and every fail-safe from the LLM's warning line.
   */
  hadHardRuleReject: boolean;
  /** How many times it was rejected by a human operator specifically. */
  humanRejections: number;
  /** Escrows still waiting for a human vote — NOT counted as verdicts yet. */
  pendingHuman: number;
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

/**
 * Fetch the AEGIS decision history for one address (as recipient).
 * The result is used as memory context for the LLM prompt.
 */
export function getAddressMemory(address: string): AddressMemory {
  const addr = address.toLowerCase();

  // ── Ground truth = FINALIZED decisions only ─────────────────────────────────
  // `pending_human` rows store the AI's *recommendation* in `eligible`, not a
  // verdict. Counting them made the system remember its own guess as history
  // (self-confirming memory). They are reported separately as `pendingHuman`.
  const agg = db
    .prepare(
      "SELECT COUNT(*) AS totalSeen, " +
      "SUM(CASE WHEN eligible = 0 THEN 1 ELSE 0 END) AS totalRejected, " +
      "SUM(CASE WHEN eligible = 1 THEN 1 ELSE 0 END) AS totalApproved, " +
      "AVG(CASE WHEN decided_by IN ('llm', 'human') THEN confidence END) AS avgConfidence, " +
      "MIN(created_at) AS firstSeenAt, MAX(created_at) AS lastSeenAt " +
      "FROM decisions WHERE LOWER(recipient) = ? AND status = 'final'"
    )
    .get(addr) as {
    totalSeen: number;
    totalRejected: number;
    totalApproved: number;
    avgConfidence: number | null;
    firstSeenAt: string | null;
    lastSeenAt: string | null;
  } | null;

  const pendingRow = db
    .prepare(
      "SELECT COUNT(*) AS n FROM decisions " +
      "WHERE LOWER(recipient) = ? AND status = 'pending_human'"
    )
    .get(addr) as { n: number } | undefined;
  const pendingHuman = pendingRow?.n ?? 0;

  if (!agg || agg.totalSeen === 0) {
    return {
      totalSeen: 0,
      totalRejected: 0,
      totalApproved: 0,
      avgConfidence: 0,
      avgConfidenceKnown: false,
      dominantRiskLevel: null,
      seenRiskFlags: [],
      hadHardRuleReject: false,
      humanRejections: 0,
      pendingHuman,
      firstSeenAt: null,
      lastSeenAt: null,
      recentDecisions: [],
    };
  }

  // 'fail_safe' rows are excluded here as well: they stored a fabricated
  // risk_level of CRITICAL / confidence of 1.0, which the judge would read as
  // a severe verified risk finding. They still count in totalSeen /
  // totalRejected, so the rejection is never hidden — only the fake severity.
  const riskRow = db
    .prepare(
      "SELECT risk_level FROM decisions " +
      "WHERE LOWER(recipient) = ? AND risk_level IS NOT NULL AND status = 'final' " +
      "AND decided_by IS NOT 'fail_safe' " +
      "GROUP BY risk_level ORDER BY COUNT(*) DESC LIMIT 1"
    )
    .get(addr) as { risk_level: string } | null;

  // A "strong rejection" means a security verdict was actually reached against
  // this address: a hard rule / GoPlus override, or a human veto.
  //
  // 'fail_safe' is deliberately EXCLUDED. A fail-safe reject only means the
  // judge was not confident enough (< HUMAN_CONF_MIN) — it carries no risk
  // finding. Counting it here created a self-reinforcing loop: one unconfident
  // verdict flipped hadHardRuleReject to true forever, the MEMORY block then
  // told the judge "previously hit a hard rule", which pushed the next
  // confidence below the floor again, and so on.
  const strongRow = db
    .prepare(
      "SELECT " +
      "SUM(CASE WHEN decided_by = 'hard_rule' THEN 1 ELSE 0 END) AS automated, " +
      "SUM(CASE WHEN decided_by = 'human' AND eligible = 0 THEN 1 ELSE 0 END) AS humanRej " +
      "FROM decisions " +
      "WHERE LOWER(recipient) = ? AND status = 'final' AND eligible = 0"
    )
    .get(addr) as { automated: number | null; humanRej: number | null } | undefined;

  const humanRejections = strongRow?.humanRej ?? 0;
  const hadHardRuleReject = (strongRow?.automated ?? 0) > 0 || humanRejections > 0;

  const flagRows = db
    .prepare(
      "SELECT risk_flags FROM decisions " +
      "WHERE LOWER(recipient) = ? AND risk_flags IS NOT NULL AND status = 'final'"
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
      "FROM decisions WHERE LOWER(recipient) = ? AND status = 'final' " +
      "AND decided_by IS NOT 'fail_safe' " +
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
    totalRejected: agg.totalRejected ?? 0,
    totalApproved: agg.totalApproved ?? 0,
    avgConfidence: agg.avgConfidence ?? 0,
    avgConfidenceKnown: agg.avgConfidence !== null,
    dominantRiskLevel: riskRow?.risk_level ?? null,
    seenRiskFlags,
    hadHardRuleReject,
    humanRejections,
    pendingHuman,
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
    if (memory.pendingHuman > 0) {
      return (
        "AEGIS HISTORICAL MEMORY (INTERNAL history — NOT on-chain data):\n" +
        "  This address has no FINALIZED AEGIS history yet.\n" +
        `  Note: ${memory.pendingHuman} escrow(s) for this address are still awaiting a human decision — ` +
        "they are NOT counted as approved or rejected, because no verdict exists yet."
      );
    }
    return "AEGIS HISTORICAL MEMORY (INTERNAL history — NOT on-chain data):\n  This address has NEVER transacted via AEGIS before (internal history is empty). This is the first evaluation.";
  }

  const rejRate = ((memory.totalRejected / memory.totalSeen) * 100).toFixed(0);
  const flags =
    memory.seenRiskFlags.length > 0
      ? memory.seenRiskFlags.join(", ")
      : "none";
  const hardWarnLine = memory.hadHardRuleReject
    ? "\n  WARNING: This address was REJECTED before by something stronger than an AI release " +
      "(a hard security rule, the GoPlus override, a fail-safe" +
      (memory.humanRejections > 0
        ? `, or a HUMAN operator ${memory.humanRejections} time(s)`
        : "") +
      "). This is a strong negative signal — do NOT release without an exceptional reason."
    : "";
  const pendingLine =
    memory.pendingHuman > 0
      ? `\n  Awaiting human decision     : ${memory.pendingHuman} escrow(s) (not counted as verdicts)`
      : "";
  // Never show an average built from a zero sample as if it were a real statistic.
  const avgLine = memory.avgConfidenceKnown
    ? "  Avg confidence of prior verdicts: " + (memory.avgConfidence * 100).toFixed(1) + "%"
    : "  Avg confidence of prior verdicts: unknown (no AI/human verdict recorded yet)";

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
    avgLine,
    "  Dominant risk level     : " + (memory.dominantRiskLevel ?? "none"),
    "  Risk flags ever seen    : " + flags,
    "  First seen              : " + (memory.firstSeenAt ?? "-"),
    "  Last seen               : " + (memory.lastSeenAt ?? "-"),
    pendingLine,
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
    return memory.pendingHuman > 0
      ? "no finalized history yet (first evaluation; " + memory.pendingHuman + " awaiting human decision)"
      : "never before (first evaluation)";
  }
  return (
    memory.totalSeen +
    "x (approved " + memory.totalApproved + "x, rejected " + memory.totalRejected + "x" +
    (memory.humanRejections > 0 ? ", " + memory.humanRejections + " vetoed by a human" : "") +
    (memory.hadHardRuleReject && memory.humanRejections === 0 ? ", previously hit a hard rule" : "") +
    ")"
  );
}

// ── Sender reputation (the other half of the risk picture) ─────────────────────
export interface SenderMemory {
  /** Finalized escrows SENT by this address through AEGIS. */
  totalSent: number;
  approved: number;
  rejected: number;
  /** Rejections that were not the LLM's own doing (hard rule / override / fail-safe / human). */
  strongRejections: number;
  /** Distinct counterparties this sender has ever paid. */
  distinctRecipients: number;
  /** Recipients this sender was REJECTED for — a strong repeat-offender signal. */
  rejectedRecipients: string[];
  pendingHuman: number;
  lastSentAt: string | null;
}

/**
 * AEGIS decision history from the SENDER side.
 *
 * Rationale: the memory block shown to the LLM used to cover the RECIPIENT only.
 * But a scam's strongest signal is often a repeat sender, not a repeat
 * recipient — a wallet that has been blocked before and is trying again looks
 * identical to a first-time sender if you never look at its side. This closes
 * that gap without making the model spend a tool call on it.
 */
export function getSenderMemory(address: string): SenderMemory {
  const addr = address.toLowerCase();

  const agg = db
    .prepare(
      "SELECT COUNT(*) AS totalSent, " +
      "SUM(CASE WHEN eligible = 1 THEN 1 ELSE 0 END) AS approved, " +
      "SUM(CASE WHEN eligible = 0 THEN 1 ELSE 0 END) AS rejected, " +
      "SUM(CASE WHEN eligible = 0 AND decided_by IN ('hard_rule','human') THEN 1 ELSE 0 END) AS strongRejections, " +
      "COUNT(DISTINCT LOWER(recipient)) AS distinctRecipients, " +
      "MAX(created_at) AS lastSentAt " +
      "FROM decisions WHERE LOWER(sender) = ? AND status = 'final'"
    )
    .get(addr) as {
    totalSent: number;
    approved: number | null;
    rejected: number | null;
    strongRejections: number | null;
    distinctRecipients: number | null;
    lastSentAt: string | null;
  } | undefined;

  const pendingRow = db
    .prepare(
      "SELECT COUNT(*) AS n FROM decisions " +
      "WHERE LOWER(sender) = ? AND status = 'pending_human'"
    )
    .get(addr) as { n: number } | undefined;

  const rejectedRecipients = (
    db
      .prepare(
        "SELECT DISTINCT LOWER(recipient) AS r FROM decisions " +
        "WHERE LOWER(sender) = ? AND status = 'final' AND eligible = 0"
      )
      .all(addr) as { r: string }[]
  ).map((x) => x.r);

  return {
    totalSent: agg?.totalSent ?? 0,
    approved: agg?.approved ?? 0,
    rejected: agg?.rejected ?? 0,
    strongRejections: agg?.strongRejections ?? 0,
    distinctRecipients: agg?.distinctRecipients ?? 0,
    rejectedRecipients,
    pendingHuman: pendingRow?.n ?? 0,
    lastSentAt: agg?.lastSentAt ?? null,
  };
}

/** Sender reputation as a prompt block. Empty sender history → an explicit "no history" line. */
export function formatSenderMemoryForPrompt(sender: SenderMemory): string {
  if (sender.totalSent === 0 && sender.pendingHuman === 0) {
    return (
      "AEGIS SENDER HISTORY (INTERNAL history — NOT on-chain data):\n" +
      "  The sender has never sent an escrow via AEGIS before (first sender)."
    );
  }

  const warn =
    sender.strongRejections > 0
      ? `\n  WARNING: this sender has ${sender.strongRejections} prior rejection(s) that were NOT a routine AI release ` +
        "(hard rule, GoPlus override, fail-safe, or human veto). Treat it as a repeat-risk sender."
      : "";

  const rejectedList =
    sender.rejectedRecipients.length > 0
      ? `\n  Previously rejected recipients: ${sender.rejectedRecipients.slice(0, 5).join(", ")}` +
        (sender.rejectedRecipients.length > 5
          ? ` (+${sender.rejectedRecipients.length - 5} more)`
          : "")
      : "";

  const pendingLine =
    sender.pendingHuman > 0
      ? `\n  Awaiting human decision: ${sender.pendingHuman} escrow(s) (not counted as verdicts)`
      : "";

  return (
    "AEGIS SENDER HISTORY (INTERNAL history — NOT on-chain data):\n" +
    `  Escrows sent via AEGIS  : ${sender.totalSent}x\n` +
    `  Approved                : ${sender.approved}x\n` +
    `  Rejected                : ${sender.rejected}x\n` +
    `  Distinct recipients     : ${sender.distinctRecipients}\n` +
    `  Last activity           : ${sender.lastSentAt ?? "-"}` +
    pendingLine +
    rejectedList +
    warn
  );
}
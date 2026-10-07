import { db } from "./db.js";
import { config } from "./config.js";

/**
 * Hard rules whose REJECT means "we positively identified this address as malicious".
 *
 * This list is the difference between a REJECT that is evidence and a REJECT that is
 * an incident: rules 2, 6 and 7 used to reject on *shape* (new account, contract
 * receiver, zero balance) and were downgraded to LLM signals, so they are deliberately
 * absent here. A `triggered_rule` outside this set — or no rule at all — is not a
 * malicious confirmation, no matter how final the row looks.
 */
export const CONFIRMED_MALICIOUS_TRIGGER_RULES: readonly string[] = [
  "RULE_1_GOPLUS_MALICIOUS",
  "RULE_1B_GOPLUS_MALICIOUS_NO_FLAGS",
  "RULE_8_GOPLUS_PHISHING_FLAGS",
  "RULE_12_LOCAL_DENYLIST",
  "RULE_15_EIP7702_MALICIOUS_DELEGATE",
];

/**
 * `decided_by` values that mean a human said no.
 *
 * `human_veto` is what the human-facing code writes for a declined escrow and `human`
 * is what `finalizeHumanDecision` writes; both are accepted because a human veto is a
 * human veto regardless of which path produced it.
 */
const HUMAN_DECIDERS: readonly string[] = ["human", "human_veto"];

/** `decided_by` value written by the GoPlus hard override. */
const OVERRIDE_DECIDER = "override_malicious";

/** `triggered_rule` prefix written by the GoPlus hard override (recipient or sender). */
const OVERRIDE_RULE_PREFIX = "OVERRIDE_GOPLUS_MALICIOUS";

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
  /**
   * Rejections that POSITIVELY identified this address as malicious: a hard rule from
   * {@link CONFIRMED_MALICIOUS_TRIGGER_RULES}, the GoPlus override, or a human veto.
   *
   * Deliberately narrower than `hadHardRuleReject`, which is what the prompt warning
   * uses. The difference is the whole point: a `fail_safe` row (the judge was not
   * confident enough), an LLM-only rejection and the now-downgraded shape rules (2/6/7)
   * are all *rejections without evidence of malice*. Counting them here would let a
   * single network outage — or one unconfident hearing — blacklist an address forever,
   * which is the exact failure mode `hadHardRuleReject` was already burned for.
   */
  confirmedMaliciousRejects: number;
  /** Which rule(s) produced those confirmed rejections, for the audit trail. */
  confirmedMaliciousRules: string[];
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
      confirmedMaliciousRejects: 0,
      confirmedMaliciousRules: [],
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

  const confirmed = countConfirmedMaliciousRejects(addr);

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
    confirmedMaliciousRejects: confirmed.count,
    confirmedMaliciousRules: confirmed.rules,
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
 * Pull the rule-engine verdict out of a stored transcript.
 *
 * `triggered_rule` is persisted INSIDE the transcript JSON (`ruleEngine.triggeredRule`)
 * rather than as its own column. That is a deliberate choice, not a shortcut: `db.ts`
 * creates the `decisions` table at import time, so adding a column would ALTER the
 * production `aegis.db` the first time any process touches it, and a migration that
 * silently rewrites the decision audit trail the moment a backend starts is not
 * something to add for one convenience field.
 */
export function readRuleContext(transcript: unknown): {
  triggeredRule: string | null;
  signals: string[];
} {
  if (transcript === null || typeof transcript !== "object") {
    return { triggeredRule: null, signals: [] };
  }
  const ruleEngine = (transcript as Record<string, unknown>).ruleEngine;
  if (ruleEngine === null || typeof ruleEngine !== "object") {
    return { triggeredRule: null, signals: [] };
  }
  const rec = ruleEngine as Record<string, unknown>;
  const triggeredRule =
    typeof rec.triggeredRule === "string" && rec.triggeredRule.trim() !== ""
      ? rec.triggeredRule
      : null;
  const signals: string[] = [];
  if (Array.isArray(rec.signals)) {
    for (const s of rec.signals) {
      if (s !== null && typeof s === "object" && typeof (s as { rule?: unknown }).rule === "string") {
        signals.push((s as { rule: string }).rule);
      }
    }
  }
  return { triggeredRule, signals };
}

/**
 * Rejections of `recipient` that are *evidence of malice*, and nothing else.
 *
 * Counted:
 *   - `decided_by = 'hard_rule'` with a `triggered_rule` in
 *     {@link CONFIRMED_MALICIOUS_TRIGGER_RULES};
 *   - `decided_by = 'override_malicious'`, and the equivalent hard_rule rows whose rule
 *     is the GoPlus override (both spellings exist in the codebase, and both mean the
 *     same thing: GoPlus said malicious and the debate was overruled);
 *   - a HUMAN rejection (`decided_by` human/human_veto with `eligible = 0`), because a
 *     person looking at the case is itself a positive finding.
 *
 * NOT counted — the exclusions are the feature:
 *   - `fail_safe`: "the judge could not analyse this", not "this is malicious". One
 *     Ollama hiccup must never blacklist an address permanently.
 *   - LLM-only rejections: a model opinion with no rule behind it.
 *   - the downgraded shape rules (2/6/7), which reject without evidence of malice.
 *   - `pending_human` rows: a recommendation is not a verdict.
 */
function countConfirmedMaliciousRejects(recipient: string): {
  count: number;
  rules: string[];
} {
  const rows = db
    .prepare(
      "SELECT decided_by, human_vote, debate FROM decisions " +
      "WHERE LOWER(recipient) = ? AND status = 'final' AND eligible = 0"
    )
    .all(recipient) as Array<{
    decided_by: string | null;
    human_vote: number | null;
    debate: string | null;
  }>;

  const rules: string[] = [];
  let count = 0;

  for (const row of rows) {
    const decider = (row.decided_by ?? "").toLowerCase();

    if (HUMAN_DECIDERS.includes(decider)) {
      count += 1;
      rules.push("human_veto");
      continue;
    }
    if (decider === OVERRIDE_DECIDER) {
      count += 1;
      rules.push("OVERRIDE_GOPLUS_MALICIOUS");
      continue;
    }
    if (decider !== "hard_rule") continue;

    let triggeredRule: string | null = null;
    if (row.debate !== null) {
      try {
        triggeredRule = readRuleContext(JSON.parse(row.debate) as unknown).triggeredRule;
      } catch {
        triggeredRule = null;
      }
    }
    // No recorded rule = no evidence. Never infer one from `decided_by`.
    if (triggeredRule === null) continue;

    const isMaliciousRule =
      CONFIRMED_MALICIOUS_TRIGGER_RULES.includes(triggeredRule) ||
      triggeredRule.startsWith(OVERRIDE_RULE_PREFIX);
    if (isMaliciousRule) {
      count += 1;
      rules.push(triggeredRule);
    }
  }

  return { count, rules: Array.from(new Set(rules)) };
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
  /**
   * Escrows this sender opened inside the burst window
   * (`SENDER_BURST_WINDOW_MIN`, default 10 min).
   *
   * `pending_human` rows are INCLUDED on purpose: a burst of escrows still awaiting a
   * verdict is exactly what a compromised key produces, and counting only finalized
   * rows would hide the drain until the drain had finished.
   */
  recentEscrowCount: number;
  pendingHuman: number;
  lastSentAt: string | null;
}

/**
 * Recipients this sender has paid before — the input for address-poisoning detection.
 *
 * DISTINCT and lowercased, and this sender ONLY: a lookalike of somebody else's
 * counterparty is not evidence against this transfer, and one repeated row must not
 * look like several.
 *
 * Bounded by `limit` on purpose — this is a UI/LLM context list, and the address-poison
 * rule compares the recipient against it, so the recent few hundred cover every
 * address a user could plausibly still confuse with a real one.
 *
 * The AEGIS vault event log would extend this to on-chain escrows that never reached
 * this database, but that is an `eth_getLogs` walk costing tens of chunked round-trips
 * per escrow; the DB half is the cheap half and is what the rule uses.
 */
export function getSenderCounterparties(
  sender: string,
  limit: number = 500
): string[] {
  const addr = sender.toLowerCase();
  // GROUP BY, not DISTINCT: the most-recent-first ordering needs MAX(created_at), and
  // an aggregate in the ORDER BY of a `SELECT DISTINCT` is a SQLITE_ERROR
  // ("misuse of aggregate") rather than a working sort.
  const rows = db
    .prepare(
      "SELECT LOWER(recipient) AS r FROM decisions " +
        "WHERE LOWER(sender) = ? " +
        "GROUP BY LOWER(recipient) " +
        "ORDER BY MAX(created_at) DESC, MAX(id) DESC LIMIT ?"
    )
    .all(addr, Math.max(1, Math.floor(limit))) as Array<{ r: string }>;
  return rows.map((r) => r.r).filter((r) => typeof r === "string" && r !== "");
}

/**
 * Count the escrows one sender opened at or after `sinceIso`.
 *
 * `sinceIso` must be a timestamp SQLite can compare against `created_at`, i.e.
 * `YYYY-MM-DD HH:MM:SS` in UTC (which is what `CURRENT_TIMESTAMP` writes).
 */
export function countRecentEscrowsBySender(sender: string, sinceIso: string): number {
  const row = db
    .prepare(
      "SELECT COUNT(*) AS n FROM decisions " +
      "WHERE LOWER(sender) = ? AND created_at >= ?"
    )
    .get(sender.toLowerCase(), sinceIso) as { n: number } | undefined;
  return row?.n ?? 0;
}

/**
 * SQLite's `CURRENT_TIMESTAMP` format, N minutes ago.
 *
 * `created_at` is written by SQLite, so the window boundary must be produced in the
 * SAME format — comparing an ISO string with a `T` separator against
 * "YYYY-MM-DD HH:MM:SS" orders lexicographically and the window silently includes
 * (or excludes) the wrong rows.
 */
function minutesAgoSql(minutes: number): string {
  return new Date(Date.now() - minutes * 60_000)
    .toISOString()
    .slice(0, 19)
    .replace("T", " ");
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

  const recentEscrowCount = countRecentEscrowsBySender(
    addr,
    minutesAgoSql(config.SENDER_BURST_WINDOW_MIN)
  );

  return {
    totalSent: agg?.totalSent ?? 0,
    approved: agg?.approved ?? 0,
    rejected: agg?.rejected ?? 0,
    strongRejections: agg?.strongRejections ?? 0,
    distinctRecipients: agg?.distinctRecipients ?? 0,
    rejectedRecipients,
    recentEscrowCount,
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
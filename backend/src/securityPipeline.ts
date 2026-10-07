import { isAddress } from "viem";
import { config } from "./config.js";
import {
  checkAddressSecurity,
  unavailableSecurity,
  type SecurityCheckResult,
} from "./goplusChecker.js";
import { getOnChainIntel, unknownIntel, type OnChainIntel } from "./bscscanChecker.js";
import { runRules, toRuleContext } from "./ruleEngine.js";
import { checkLocalDenylist } from "./denylist.js";
import {
  callLLM,
  callAdvocate,
  callJudge,
  runInvestigatorAgent,
  runAdvocateAgent,
  runFocusedRepass,
  generateHardRuleExplanation,
  type LLMInput,
  type LLMDecision,
  type AdvocateResult,
  type DebateTranscript,
  type JudgeOutcome,
} from "./aiAnalyzer.js";
import type { AgentStepEvent } from "./agentLoop.js";
import {
  createEscrowBudget,
  evidenceRequestReservation,
  focusedRepassLedgerSize,
  LlmBudget,
} from "./llmBudget.js";
import {
  getAddressMemory,
  getSenderMemory,
  getSenderCounterparties,
  formatMemoryForPrompt,
  formatMemoryFacts,
  formatSenderMemoryForPrompt,
  type AddressMemory,
  type SenderMemory,
} from "./agentMemory.js";
import {
  executeTools,
  sanitizeNeedsData,
  buildAdvocateEvidence,
  createToolContext,
  type ToolContext,
} from "./tools.js";
import { publish } from "./streamBus.js";
import type { RuleEngineContext, RuleSignal } from "./ruleEngine.js";

// ── Helpers (used by the pipeline body below) ──────────────────────────────────

/**
 * Run a database read and downgrade any failure to `null` = UNKNOWN.
 *
 * The rule engine treats `null` as "not known", so a SQLite error can never turn into a
 * clean-looking empty history — and therefore never into a rejection. The alternative
 * (letting the throw escape) took down the whole escrow on a transient lock.
 */
function readOrNull<T>(read: () => T, what: string): T | null {
  try {
    return read();
  } catch (err) {
    console.warn(`[Memory]  Could not read ${what}:`, err);
    return null;
  }
}

/** A zeroed AddressMemory, for call sites that must not handle null. */
function emptyAddressMemory(): AddressMemory {
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
    pendingHuman: 0,
    firstSeenAt: null,
    lastSeenAt: null,
    recentDecisions: [],
  };
}

/** A zeroed SenderMemory, for call sites that must not handle null. */
function emptySenderMemory(): SenderMemory {
  return {
    totalSent: 0,
    approved: 0,
    rejected: 0,
    strongRejections: 0,
    distinctRecipients: 0,
    rejectedRecipients: [],
    recentEscrowCount: 0,
    pendingHuman: 0,
    lastSentAt: null,
  };
}

/**
 * Prompt text for an unreadable memory table.
 *
 * Deliberately NOT the "this address has NEVER transacted via AEGIS before" line: an
 * empty table and a broken one look identical in SQL, and telling the model "no history"
 * when the query failed teaches it to treat an outage as evidence of innocence.
 */
const MEMORY_UNAVAILABLE =
  "AEGIS HISTORICAL MEMORY (INTERNAL history — NOT on-chain data):\n" +
  "  UNAVAILABLE — the AEGIS decision database could not be read for this address.\n" +
  "  Treat the recipient's history as UNKNOWN (not as 'no history'), and do not treat the\n" +
  "  absence of remembered rejections as evidence in the recipient's favour.";

const SENDER_MEMORY_UNAVAILABLE =
  "AEGIS SENDER HISTORY (INTERNAL history — NOT on-chain data):\n" +
  "  UNAVAILABLE — the AEGIS decision database could not be read for this sender.\n" +
  "  Treat the sender's history as UNKNOWN (not as 'no history').";

/**
 * Render the rule-engine signals for the Investigator's evidence block.
 *
 * Every signal is included, with its severity and its rule id, so the hearing can see
 * exactly which deterministic observations exist. The rule ids are included on purpose:
 * they let the model cite the specific observation it is reasoning about instead of
 * re-deriving it from raw numbers.
 */
function formatRuleSignals(signals: RuleSignal[]): string {
  if (signals.length === 0) return "";
  return (
    "AEGIS DETERMINISTIC RULE SIGNALS (the rule engine found no hard rule to reject; " +
    "these are the observations it did find, and they are the strongest evidence you have):\n" +
    signals
      .map((s) => `  [${s.severity.toUpperCase()}] ${s.rule}: ${s.reason}`)
      .join("\n")
  );
}

// ── Types ─────────────────────────────────────────────────────────────────────

/** One agent step, recorded for the SSE trace and the decision audit. */
export interface AgentTraceEntry {
  agent: string;
  step: number;
  kind: "tool_request" | "final" | "budget_stop";
  toolNames: string[];
  llmCalls: number;
}

export interface FinalDecision {
  eligible: boolean;
  confidence: number;
  riskLevel: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
  reason: string;
  /** What produced the final decision. */
  decidedBy: "hard_rule" | "llm" | "fail_safe" | "human_review";
  /** Which rule triggered (if hard_rule or fail_safe). */
  triggeredRule?: string;
  /**
   * The deterministic rule-engine verdict (decision, rule id, every NEEDS_LLM signal).
   *
   * Persisted inside the transcript JSON on EVERY path, including the hard-REJECT one
   * that produces no debate. Without it a past `decided_by = 'hard_rule'` row carries
   * no way to tell a malicious identification (GoPlus flag, denylist hit) from a
   * shape-based rejection — and `getAddressMemory` would have to guess, i.e. blacklist
   * an address because of an outage.
   */
  ruleEngine?: RuleEngineContext;
  /**
   * Tools the AI executed before the final decision (tool calling).
   * Empty [] if the LLM did not request any extra data.
   */
  toolsUsed: string[];
  /**
   * Multi-agent hearing transcript (Investigator → Advocate → Judge).
   * Only present on the LLM/debate path; hard rule & fail-safe do not debate.
   */
  debate?: DebateTranscript;
  /**
   * Per-agent tool trace: which agent called which tool, in which step.
   *
   * Present whenever an LLM agent ran, so an auditor can answer "where did this
   * conclusion come from" without re-running the hearing — including for the
   * legacy path, where the trace is emitted synthetically from `needsData`.
   */
  agentTrace?: AgentTraceEntry[];
  /**
   * True → do NOT submit on-chain. Hold the escrow, request 1 human vote.
   * `eligible` = the AI recommendation (for display), not the final decision.
   */
  needsHuman?: boolean;
  /** Escalation reason (English). */
  humanReason?: string;
  /** Evidence collected during pipeline. */
  evidence: {
    security: SecurityCheckResult;
    intel: OnChainIntel;
  };
}

// ── Final guards (exported & red-team tested — do not duplicate the logic) ───
type FinalGuard =
  | { kind: "fail_low_confidence" }
  | { kind: "override_malicious"; side: "recipient" | "sender" }
  | { kind: "needs_human"; reason: string }
  | { kind: "judge"; eligible: boolean };

/**
 * The final guard that DETERMINES the outcome after the Judge.
 *
 * Order (HUMAN_ESCALATION_ENABLED=true, default):
 *   1) GoPlus malicious → hard override REJECT (no vote, no debate can beat it)
 *   2) conf < humanMin → fail-safe REJECT (conf too low to be worth a vote)
 *   3) conf < threshold → HOLD for human (grey zone)
 *   4) Investigator vs Judge lean differently → HOLD for human (hearing flipped)
 *   5) otherwise → follow the Judge
 * With escalation disabled: the same override first, then the old behaviour —
 * conf < threshold → fail-safe.
 *
 * The malicious override runs FIRST on purpose. It used to run after the
 * confidence check, so a GoPlus-flagged address that also produced a low
 * confidence was recorded as a plain `fail_safe` — the outcome was still
 * REJECT, but the "GoPlus flagged this address" attribution was lost from the
 * UI, the event stream and the agent memory, making a real detection
 * indistinguishable from a model hiccup.
 *
 * The red-team calls this function directly.
 */
export function evaluateFinalOutcome(input: {
  judgeEligible: boolean;
  judgeConfidence: number;
  investigatorEligible?: boolean | undefined;
  securityStatus: SecurityCheckResult["status"];
  /** GoPlus status of the SENDER; defaults to "clean" when not screened. */
  senderSecurityStatus?: SecurityCheckResult["status"] | undefined;
  threshold: number;
  humanMin: number;
  humanEscalationEnabled: boolean;
}): FinalGuard {
  const { humanEscalationEnabled, humanMin, threshold } = input;

  // 1) Threat intelligence always wins, regardless of how unsure the Judge was.
  // Both ends of the transfer are screened. Only checking the recipient left a
  // real laundering path open: in a live test the Advocate produced GoPlus flags
  // for the SENDER (stealing_attack, sanctioned) and the Judge still released the
  // transfer at 0.95 confidence, because a recipient-only oracle has no say over
  // who is sending the money.
  if (input.securityStatus === "malicious") {
    return { kind: "override_malicious", side: "recipient" };
  }
  if (input.senderSecurityStatus === "malicious") {
    return { kind: "override_malicious", side: "sender" };
  }

  if (!humanEscalationEnabled) {
    if (input.judgeConfidence < threshold) {
      return { kind: "fail_low_confidence" };
    }
    return { kind: "judge", eligible: input.judgeEligible };
  }

  if (input.judgeConfidence < humanMin) {
    return { kind: "fail_low_confidence" };
  }
  if (input.judgeConfidence < threshold) {
    return {
      kind: "needs_human",
      reason:
        `The AI judge confidence (${(input.judgeConfidence * 100).toFixed(0)}%) sits in the grey zone ` +
        `(${(humanMin * 100).toFixed(0)}–${(threshold * 100).toFixed(0)}%). ` +
        `The AI is not confident enough to decide on its own — waiting for 1 human vote.`,
    };
  }
  if (
    input.investigatorEligible !== undefined &&
    input.investigatorEligible !== input.judgeEligible
  ) {
    return {
      kind: "needs_human",
      reason:
        `The hearing flipped: the Investigator leans ${input.investigatorEligible ? "RELEASE" : "REJECT"}, ` +
        `while the Judge ruled ${input.judgeEligible ? "RELEASE" : "REJECT"} ` +
        `(confidence ${(input.judgeConfidence * 100).toFixed(0)}%). ` +
        `The agent opinions do not align — waiting for a human veto.`,
    };
  }
  return { kind: "judge", eligible: input.judgeEligible };
}

// ── Evidence request: Judge #1 asked, now what? ───────────────────────────────
/** The exact event shape `publish` accepts (no `ts` — the bus stamps it). */
export type EvidenceStreamEvent = Parameters<typeof publish>[0];

/**
 * Everything the evidence-request branch needs from its escrow, injected.
 *
 * The branch is the only part of the pipeline that has to reason about two nested
 * failure modes, so it is kept testable on its own: the LLM entry points
 * (`runFocusedRepass`, `callJudge`) and the two closures the branch uses instead of
 * the outside world (`publish`, `finalize`) are parameters. Nothing here changes what
 * the branch does — it is the same code, called the same way.
 */
export interface EvidenceDeps {
  /** The escrow's hard ceiling. Reserved from and released to — never re-created. */
  budget: LlmBudget;
  /** native tools AND `AGENT_MAX_FOLLOWUP_STEPS > 0` (gates 2 and 3). */
  repassEnabled: boolean;
  /** Worst case of ONE re-pass run (`focusedRepassLedgerSize`). */
  repassLedgerSize: number;
  /** The re-pass ledger AND Judge #2, reserved as one unit (`evidenceRequestReservation`). */
  repassReservation: number;
  runFocusedRepass: typeof runFocusedRepass;
  callJudge: typeof callJudge;
  publish: (event: EvidenceStreamEvent) => void;
  /** `finalizeReason(reason, intel, recipientMemory)`, already bound to this escrow. */
  finalize: (reason: string) => string;
}

/** The escrow state the branch needs: who said what, and where to report progress. */
export interface EvidenceCtx {
  escrowId: string | undefined;
  llmInput: LLMInput;
  /** The assessment Judge #2 falls back to when the re-pass cannot produce one. */
  investigator: LLMDecision;
  advocate: AdvocateResult | null;
  toolCtx: ToolContext;
  toolResultsBlock: string | undefined;
  onAgentStep: (agent: string, event: AgentStepEvent) => void;
}

export interface EvidenceResult {
  /** The ruling this branch produced — `null` only when `failSafeReason` is set. */
  judge: LLMDecision | null;
  /** The re-pass verdict, `null` when it did not run or did not survive. */
  focusedRepass: LLMDecision | null;
  /** Which Investigator assessment the ruling belongs to. */
  leanSplitSource: DebateTranscript["leanSplitSource"];
  evidenceRequest: NonNullable<DebateTranscript["evidenceRequest"]>;
  /** Non-null ⇒ the caller must fail safe; the branch has no ruling to give. */
  failSafeReason: string | null;
  /** Every Judge call made here, reservation or not (forced rulings included). */
  judgeCalls: number;
}

/**
 * Resolve one `request_evidence` from Judge #1: focused re-pass, then Judge #2.
 *
 * The three outcomes, and why they are different things:
 *
 *  1. RE-PASS FAILS → Judge #2 still runs, on the ORIGINAL Investigator decision.
 *     A re-pass that throws is an improvement that did not happen, not a verdict, and
 *     Judge #2 is already paid for by the pair reservation — so there is nothing to
 *     pay for and nothing to decide: the hearing continues on the evidence it has.
 *     `skippedBecause: "repass_failed"`, `leanSplitSource: "investigator"`. Asking the
 *     budget for a *second* reservation here is what used to happen, and it could be
 *     refused — turning a recoverable hiccup into a needless fail-safe.
 *
 *  2. JUDGE #2 FAILS (throws, or is not a ruling) → fail-safe, and only AFTER `finally`
 *     has handed the unused reservation back, so the escrow is not failed while budget
 *     it no longer holds is still reserved. No forced ruling and no third Judge call:
 *     Judge #2 is the escrow's last word, and "the Judge could not finish" is not
 *     permission to ask again.
 *
 *  3. BOTH SUCCEED → `judge` is Judge #2's, `leanSplitSource: "focused_repass"`.
 *
 * The two no-reservation paths (re-pass disabled, or the pair unaffordable) keep the
 * forced ruling: the Judge still owes an answer, so it is called once with the evidence
 * option CLOSED, reserving that single call itself. If even that cannot be afforded the
 * branch fails safe. An evidence request is never a release, on any path.
 */
export async function resolveEvidenceRequest(
  deps: EvidenceDeps,
  ctx: EvidenceCtx,
  request: { focus: string; reason: string }
): Promise<EvidenceResult> {
  const { budget, publish, finalize } = deps;
  const {
    escrowId,
    llmInput,
    investigator,
    advocate,
    toolCtx,
    toolResultsBlock,
    onAgentStep,
  } = ctx;
  const { focus, reason } = request;

  let focusedRepass: LLMDecision | null = null;
  let leanSplitSource: DebateTranscript["leanSplitSource"] = "investigator";
  let judge: LLMDecision | null = null;
  let failSafeReason: string | null = null;
  let evidenceRequest: NonNullable<DebateTranscript["evidenceRequest"]> = { focus, reason };
  /** Every Judge call made here, forced rulings included. */
  let judgeCalls = 0;

  /**
   * Ask the Judge for a ruling with the evidence-request option CLOSED.
   *
   * Required because the Judge can decline to rule and the escrow still owes the user
   * a decision: the alternatives were "run a re-pass nobody can judge" (an
   * unaccountable hearing) or "release because the Judge hesitated", which is worse.
   * Reserves its own single call — it is reachable ONLY from the two paths that hold no
   * reservation, so it can never be asked for money that is already spoken for.
   * Returns null when the ruling cannot be afforded or does not parse; the caller then
   * fails safe.
   */
  const forceJudgeRuling = async (why: string): Promise<LLMDecision | null> => {
    const reserved = budget.tryReserve(1);
    if (!reserved.ok) {
      const msg =
        `no LLM-call budget left for the ruling the Judge owes (${budget.describe()}) ` +
        `after it asked for evidence — ${why}`;
      console.error(`[Judge]    ERROR: ${msg}`);
      publish({
        escrowId,
        phase: "judge",
        status: "fail",
        label: "Judge requested evidence but cannot rule — budget exhausted",
        detail: msg,
      });
      return null;
    }
    try {
      console.log(`[Judge]    Re-deciding with the evidence option closed (${why})...`);
      publish({
        escrowId,
        phase: "judge",
        status: "start",
        label: "Judge ruling without a further evidence round",
      });
      const forced = await deps.callJudge(
        llmInput,
        investigator,
        advocate,
        toolResultsBlock
      );
      // Unreachable via the parser (`allowRequestEvidence` is false), but checked so a
      // future change to the parser cannot quietly reopen the second request.
      if (forced.kind !== "ruling") {
        throw new Error("the Judge requested evidence a second time");
      }
      console.log(
        `[Judge]    eligible=${forced.eligible} ` +
          `confidence=${forced.confidence.toFixed(2)} ` +
          `riskLevel=${forced.riskLevel}`
      );
      console.log(`[Judge]    Reason: ${forced.reason}`);
      publish({
        escrowId,
        phase: "judge",
        status: "ok",
        label: `Judge: ${forced.eligible ? "RULING RELEASE" : "RULING REJECT"}`,
        detail: finalize(forced.reason),
        data: {
          eligible: forced.eligible,
          confidence: forced.confidence,
          riskLevel: forced.riskLevel,
        },
      });
      return forced;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[Judge]    ERROR: ${msg}`);
      publish({
        escrowId,
        phase: "judge",
        status: "fail",
        label: "Judge could not rule after requesting evidence",
        detail: msg,
      });
      return null;
    }
  };

  /** One place for "no re-pass possible → the Judge still owes a ruling". */
  const ruleWithoutRepass = async (
    skippedBecause: "budget" | "disabled"
  ): Promise<void> => {
    evidenceRequest = { focus, reason, skippedBecause };
    const why = skippedBecause === "disabled" ? "the evidence re-pass is disabled" : "the LLM-call budget";
    console.warn(
      `[Repass]  Skipped — ${why}. The Judge will rule without the extra evidence.`
    );
    publish({
      escrowId,
      phase: "judge",
      status: "skip",
      label:
        skippedBecause === "disabled"
          ? "Evidence request cannot be granted — re-pass disabled"
          : "Evidence request cannot be granted — LLM call budget exhausted",
      detail: `The Judge asked: ${focus}`,
      data: { skippedBecause, budget: budget.describe() },
    });
    const forced = await forceJudgeRuling(why);
    if (forced === null) {
      failSafeReason =
        `the Judge asked for further evidence but could not be given a second round (${why}) ` +
        `and then could not rule (${budget.describe()})`;
      return;
    }
    judge = forced;
    judgeCalls += 1;
  };

  if (!deps.repassEnabled) {
    await ruleWithoutRepass("disabled");
  } else if (!budget.tryReserve(deps.repassReservation).ok) {
    await ruleWithoutRepass("budget");
  } else {
    // Paid for up front: the whole path (re-pass + Judge #2) is charged now and
    // spent against the child ledger below, so neither half can overrun. Whatever
    // is left over is handed back afterwards, keeping the escrow total a count of
    // calls that actually happened.
    const { repassLedgerSize, repassReservation } = deps;
    let repassLedger = new LlmBudget(repassLedgerSize);
    let judgeCallsSpent = 0;
    // Which half of the pair is running. Only Judge #2 failures may end the
    // escrow from here; a re-pass failure is recovered by Judge #2 itself.
    let stage: "repass" | "judge2" = "repass";
    // Set when Judge #2 fails. Acted on only AFTER `finally` has handed the
    // unused reservation back, so no budget is reserved while one is held.
    let deferredFailSafe: string | null = null;
    try {
      // ── Stage 1: focused re-pass (recoverable) ───────────────────────────────
      // The decision Judge #2 will rule on. Falls back to the original
      // Investigator if the re-pass cannot produce one.
      let decisionForJudge2: LLMDecision = investigator;
      try {
        console.log(`[Repass]  Investigator answers the Judge's question: ${focus}`);
        publish({
          escrowId,
          phase: "investigator",
          status: "start",
          label: "Investigator focused re-pass (evidence requested by the Judge)",
          detail: focus,
        });
        const repass = await deps.runFocusedRepass(
          llmInput,
          investigator,
          advocate,
          toolCtx,
          repassLedger,
          { onStep: (e) => onAgentStep("Investigator (re-pass)", e) },
          focus
        );
        focusedRepass = { ...repass, reason: finalize(repass.reason) };
        decisionForJudge2 = focusedRepass;
        leanSplitSource = "focused_repass";
        console.log(
          `[Repass]  Revised: eligible=${focusedRepass.eligible} ` +
            `confidence=${focusedRepass.confidence.toFixed(2)}`
        );
        console.log(`[Repass]  Reason: ${focusedRepass.reason}`);
        publish({
          escrowId,
          phase: "investigator",
          status: "ok",
          label: `Investigator (re-pass): ${focusedRepass.eligible ? "supports RELEASE" : "supports REJECT"}`,
          detail: focusedRepass.reason,
          data: {
            eligible: focusedRepass.eligible,
            confidence: focusedRepass.confidence,
            riskLevel: focusedRepass.riskLevel,
          },
        });
      } catch (err) {
        // A failed re-pass is an improvement that did not happen, not a verdict.
        // Judge #2 is already paid for, so it rules on the ORIGINAL evidence —
        // no new reservation, no forced ruling.
        const msg = err instanceof Error ? err.message : String(err);
        focusedRepass = null;
        decisionForJudge2 = investigator;
        evidenceRequest = { focus, reason, skippedBecause: "repass_failed" };
        console.warn(`[Repass]  Failed (${msg}) — the Judge will rule on the original evidence.`);
        publish({
          escrowId,
          phase: "investigator",
          status: "fail",
          label: "Focused re-pass failed — Judge rules on the original evidence",
          detail: msg,
        });
      }

      // ── Stage 2: Judge #2 — final ruling, evidence option CLOSED ─────────────
      stage = "judge2";
      console.log(`[Judge]    Re-deciding (final ruling)...`);
      publish({
        escrowId,
        phase: "judge",
        status: "start",
        label: "Judge re-deciding after the focused re-pass",
      });
      // Already paid for by the reservation above — do not charge the escrow budget
      // a second time. Counted BEFORE the await: an attempted call is a spent call,
      // so a throw after the LLM answered is never released back to the budget.
      judgeCallsSpent = 1;
      judgeCalls += 1;
      const second = await deps.callJudge(
        llmInput,
        decisionForJudge2,
        advocate,
        toolResultsBlock
      );
      if (second.kind !== "ruling") {
        // Unreachable via the parser (`allowRequestEvidence` is false). Kept so a
        // future parser change cannot reopen a second request.
        throw new Error("the Judge requested evidence a second time");
      }
      judge = second;
      console.log(
        `[Judge]    Revised: eligible=${judge.eligible} ` +
          `confidence=${judge.confidence.toFixed(2)}`
      );
      console.log(`[Judge]    Reason: ${judge.reason}`);
      publish({
        escrowId,
        phase: "judge",
        status: "ok",
        label: `Judge (revised): ${judge.eligible ? "RULING RELEASE" : "RULING REJECT"}`,
        detail: finalize(judge.reason),
        data: {
          eligible: judge.eligible,
          confidence: judge.confidence,
          riskLevel: judge.riskLevel,
        },
      });
    } catch (err) {
      // Stage 1 has its own catch, so only Judge #2 can land here. Judge #2 is the
      // escrow's final ruling: no forced ruling, no third Judge call.
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[Judge]    Final ruling failed at stage "${stage}": ${msg}`);
      publish({
        escrowId,
        phase: "judge",
        status: "fail",
        label: "Judge's final ruling failed",
        detail: msg,
      });
      deferredFailSafe = `the Judge's final ruling after the evidence round failed (${msg})`;
    } finally {
      const unused = repassReservation - repassLedger.used - judgeCallsSpent;
      if (unused > 0) {
        const returned = budget.release(unused);
        console.log(
          `[Repass]  Returned ${returned} unused reservation(s) to the escrow budget ` +
            `(${budget.describe()}).`
        );
      }
      repassLedger = new LlmBudget(0);
    }
    if (deferredFailSafe !== null) {
      failSafeReason = deferredFailSafe;
    }
  }

  return {
    judge,
    focusedRepass,
    leanSplitSource,
    evidenceRequest,
    failSafeReason,
    judgeCalls,
  };
}

// ── Pipeline ──────────────────────────────────────────────────────────────────
/**
 * Run the full AEGIS security pipeline for a transfer.
 *
 * Flow:
 *  1. Validate EVM address
 *  2. Query GoPlus + BscScan in parallel
 *  3. Run deterministic rule engine
 *  4. If REJECT → stop, return REJECT (the hard rule wins — no debate is run)
 *  5. If NEEDS_LLM → Investigator (Qwen3:8b via Ollama)
 *  5b. Tool calling (AGENTIC LOOP, at most 1 round):
 *      if the Investigator fills needsData → execute tools (pure code, 0 LLM cost)
 *      → call the Investigator a second time with the additional evidence.
 *  5c. MULTI-AGENT DEBATE:
 *      the Advocate builds a steelman for the position OPPOSITE to the Investigator's lean
 *      → the Judge weighs the evidence + both opinions → final decision.
 *      The Judge may instead ask for ONE more bounded evidence round
 *      (`request_evidence`), which the Investigator answers and the Judge then rules
 *      on — see step 6e; it is the Judge's decision, not a fixed pipeline stage.
 *  6. Validate the LLM JSON output
 *  7. Apply the confidence threshold (to the Judge's decision)
 *  8. Hard rule override: GoPlus malicious ALWAYS wins over any agent
 *  9. Return a structured FinalDecision (including the debate transcript)
 *
 * HARD GUARANTEES:
 * - GoPlus malicious → REJECT regardless of the LLM/Judge output
 * - LLM error / timeout / malformed → fail-safe REJECT
 * - LLM low confidence → fail-safe REJECT
 * - API unavailable ≠ clean (this also applies to tool failures)
 * - Tools ONLY add evidence; tools never decide eligible/confidence
 * - The Advocate does NOT produce a decision — only arguments; the Judge is final
 * - If the Advocate fails → the Judge runs without arguments (more cautious)
 * - If the Judge fails → fail-safe REJECT
 * - The Judge may ask for ONE more bounded evidence round (Judge #1 only); Judge #2
 *   is never offered it. If the request cannot be granted the Judge still rules, and
 *   if it cannot rule the escrow fails safe. An evidence request is never a release.
 * - AT MOST 2 JUDGE CALLS PER ESCROW: Judge #1, and then either Judge #2 or the single
 *   forced ruling that replaces it. Never both, never a third.
 *
 * MAXIMUM LLM CALLS PER ESCROW
 * The ceiling is `AGENT_MAX_LLM_CALLS` (default 12) and it is enforced by
 * reservations, not by hope. Worst case on the debate path:
 *
 *   Investigator  (AGENT_MAX_STEPS 4 + 1 forced)              = 5
 *   Advocate      (ADVOCATE_MAX_STEPS 2 + 1 forced)          = 3
 *   Judge #1                                                 = 1
 *   focused re-pass (AGENT_MAX_FOLLOWUP_STEPS 1 + 1 forced)   = 2   } reserved
 *   Judge #2                                                 = 1   } together
 *                                                            total = 12
 *
 * The re-pass + Judge #2 pair is reserved in ONE `tryReserve(evidenceRequestReservation())`
 * — never just the re-pass, or the last call of the escrow would run unreserved — and
 * whatever the pair does not spend is returned with `budget.release()`, so the escrow
 * total stays a count of calls that actually happened. This whole branch is now
 * conditional: it runs only when Judge #1 returned `request_evidence`, so an ordinary
 * hearing costs 9 calls, not 12.
 *
 * The two ways it can go wrong are deliberately different outcomes, and neither is a
 * third Judge call: a failed RE-PASS is recovered by Judge #2, which is already paid
 * for and rules on the ORIGINAL Investigator, while a failed JUDGE #2 (its final
 * ruling) fails the escrow safe once the unused reservation has been handed back. So
 * the re-pass failing still costs at most the 12 above, and a Judge #2 failure costs
 * only what actually ran.
 *
 * NOT counted, deliberately: the hard-rule explanation call (below) and lesson
 * generation (after the decision). Neither can influence the outcome — the rule
 * engine has already decided REJECT when the explanation runs, and a failed
 * explanation falls back to the deterministic rule text — so charging them would
 * either shrink the debate's real allowance or make a settled REJECT look starved.
 *
 * @param sender      Escrow sender EVM address (0x...)
 * @param recipient   Recipient EVM address (0x...)
 * @param amountBNB   Transfer amount in BNB (as number)
 */
export async function runSecurityPipeline(
  sender: string,
  recipient: string,
  amountBNB: number,
  escrowId?: string
): Promise<FinalDecision> {
  console.log(`\n[Security] ─────────────────────────────────────────────`);
  console.log(`[Security] Checking recipient: ${recipient}`);
  console.log(`[Security] Sender: ${sender}`);
  console.log(`[Security] Amount: ${amountBNB} BNB`);

  // ── Step 1: Validate EVM address ──────────────────────────────────────────
  if (!isAddress(recipient)) {
    console.warn(`[Security] REJECT — invalid EVM address: ${recipient}`);
    publish({
      escrowId,
      phase: "rules",
      status: "fail",
      label: "Invalid address",
      detail: recipient,
    });
    return failSafe(
      `Invalid EVM address format: ${recipient}`,
      "FAIL_INVALID_ADDRESS"
    );
  }

  // ── Step 2: Query GoPlus + BscScan in parallel ────────────────────────────
  console.log(`[Security] Querying GoPlus + on-chain intel (RPC + vault log) in parallel...`);
  publish({
    escrowId,
    phase: "evidence",
    status: "start",
    label: "Collecting GoPlus + BscScan evidence",
    data: { recipient, amountBNB, sender },
  });

  const [security, intel] = await Promise.all([
    checkAddressSecurity(recipient).catch((err): SecurityCheckResult => {
      console.warn(`[GoPlus] Unexpected error:`, err);
      return unavailableSecurity();
    }),
    getOnChainIntel(recipient).catch((err) => {
      console.warn(`[OnChain] Unexpected error:`, err);
      return unknownIntel();
    }),
  ]);

  // ── Step 2b: EIP-7702 delegate screening ──────────────────────────────────
  //
  // A 7702 recipient runs its code from a DELEGATE contract, so the delegate — not the
  // recipient address — is what a sweeper hijacks, and it is invisible to every lookup
  // on the recipient itself. Screening it is what stops "the recipient is clean" from
  // meaning "the funds will reach the owner".
  //
  // Not literally inside the Promise.all above, because the delegate address only
  // becomes known once `eth_getCode` has answered inside `getOnChainIntel`: issuing a
  // second, duplicated `eth_getCode` up front would buy overlapping latency at the cost
  // of an extra RPC round-trip per escrow. Sequential instead, and behind a guard so it
  // costs nothing on a plain EOA.
  let delegateSecurity: SecurityCheckResult | null = null;
  if (intel.delegateAddress !== null) {
    console.log(
      `[EIP7702] Recipient is delegated to ${intel.delegateAddress} — screening the delegate...`
    );
    delegateSecurity = await checkAddressSecurity(intel.delegateAddress).catch(
      (err): SecurityCheckResult | null => {
        // A failed delegate check is UNKNOWN, never clean: `runRules` turns this into
        // the RULE_16 signal instead of silently treating the delegation as benign.
        console.warn(
          `[EIP7702] Delegate check failed for ${intel.delegateAddress}:`,
          err
        );
        return null;
      }
    );
    console.log(
      `[EIP7702] Delegate ${intel.delegateAddress}: ${delegateSecurity?.status ?? "unavailable (unknown)"}` +
        (delegateSecurity && delegateSecurity.softFlags.length > 0
          ? ` soft=[${delegateSecurity.softFlags.join(", ")}]`
          : "")
    );
  }

  // ── Step 2c: local denylist (GoPlus-independent) ──────────────────────────
  // Checked on the recipient first, then on the delegate. Ordering matters only for
  // attribution: both are hard REJECTs, and a delegate on the denylist is reported as
  // RULE_12 because the pipeline hands both hits over through one field.
  const localDenylistHit =
    checkLocalDenylist(recipient) ??
    (intel.delegateAddress !== null ? checkLocalDenylist(intel.delegateAddress) : null);
  if (localDenylistHit !== null) {
    console.log(
      `[Denylist] HIT (list: ${localDenylistHit.list}) — ${localDenylistHit.label}`
    );
  }

// ── Log evidence ──────────────────────────────────────────────────────────
  console.log(
    `[GoPlus]  status=${security.status} flags=[${security.riskFlags.join(", ")}]` +
      (security.hardFlags.length > 0 ? ` hard=[${security.hardFlags.join(", ")}]` : "") +
      (security.softFlags.length > 0 ? ` soft=[${security.softFlags.join(", ")}]` : "") +
      (security.simulated ? " *** SIMULATED ***" : "") +
      (security.flaggedChains ? ` chains=${security.flaggedChains.join("+")}` : "") +
      (security.failedChains?.length
        ? ` PARTIAL (failed: ${security.failedChains.join("+")})`
        : "")
  );
  console.log(
    `[OnChain] txCount=${intel.txCount ?? "?"}(${intel.txCountSource}) ` +
      `profile=${intel.novelty} ` +
      `isContract=${intel.isContract} ` +
      (intel.delegateAddress !== null ? `delegate=${intel.delegateAddress} ` : "") +
      `balance=${intel.balanceBNB !== null ? `${intel.balanceBNB.toFixed(4)}BNB` : "?"} ` +
      `vaultIn=${intel.aegisEscrowIn} senders=${intel.aegisDistinctSenders}` +
      (intel.aegisLogsUnavailable ? " (logs UNKNOWN)" : "") +
      (intel.aegisWindowLimited ? " (window-limited)" : "")
  );
  publish({
    escrowId,
    phase: "evidence",
    status: "ok",
    label: `GoPlus ${security.status}${security.simulated ? " (simulated)" : ""}`,
    detail:
      `txCount=${intel.txCount ?? "?"}(${intel.txCountSource}), profile=${intel.novelty}, ` +
      `balance=${intel.balanceBNB !== null ? intel.balanceBNB.toFixed(4) + " BNB" : "?"}` +
      `, aegisEscrows=${intel.aegisEscrowIn}` +
      (security.riskFlags.length > 0 ? `, flags=[${security.riskFlags.join(", ")}]` : ""),
    data: {
      goplus: security.status,
      flags: security.riskFlags,
      hardFlags: security.hardFlags,
      softFlags: security.softFlags,
      simulated: security.simulated === true,
    },
  });

  // ── Step 3: Load agent memory (recipient AND sender) ─────────────────────
  // Moved BEFORE the rule engine because the rules now READ it: rule 13 needs the
  // recipient's confirmed-malicious history and rule 18 needs the sender's record, and
  // a rule that cannot see the evidence it is supposed to reason about cannot be
  // correct. (It used to run after, because the rules only looked at GoPlus + RPC.)
  //
  // Both sides matter for the prompt too: the recipient's history says "has this account
  // ever been blocked", the sender's says "is this someone who was already blocked trying
  // again". Previously only the recipient was loaded.
  //
  // Every read is wrapped: a failing database must yield `null` — i.e. UNKNOWN — never a
  // crash, and never an empty-looking "no history". The prompt text and the rule engine
  // both key off that null: the rules skip their history-based checks entirely, and the
  // Investigator is told the history is unavailable instead of being shown a blank one.
  const recipientMemory = readOrNull(
    () => getAddressMemory(recipient),
    "recipient memory"
  );
  const memory = recipientMemory ?? emptyAddressMemory();
  const memoryContext =
    recipientMemory !== null
      ? formatMemoryForPrompt(recipientMemory)
      : MEMORY_UNAVAILABLE;
  const senderMemoryRead = readOrNull(() => getSenderMemory(sender), "sender memory");
  const senderMemory = senderMemoryRead ?? emptySenderMemory();
  const senderContext =
    senderMemoryRead !== null
      ? formatSenderMemoryForPrompt(senderMemoryRead)
      : SENDER_MEMORY_UNAVAILABLE;
  const senderCounterparties = readOrNull(
    () => getSenderCounterparties(sender),
    "sender counterparties"
  );

  if (senderCounterparties === null) {
    console.log(
      `[Memory]  Sender counterparty history is UNKNOWN — address-poisoning detection is skipped (unknown ≠ clean).`
    );
  }

  if (recipientMemory === null) {
    console.log(`[Memory]  Recipient history is UNKNOWN — history-based rules are skipped.`);
  } else if (memory.totalSeen > 0) {
    console.log(
      `[Memory]  Recipient seen before: ${memory.totalSeen}x | ` +
        `approved=${memory.totalApproved} rejected=${memory.totalRejected} | ` +
        `humanRej=${memory.humanRejections} strongReject=${memory.hadHardRuleReject}` +
        ` confirmedMalicious=${memory.confirmedMaliciousRejects}` +
        (memory.pendingHuman > 0 ? ` | pendingHuman=${memory.pendingHuman}` : "")
    );
  } else {
    console.log(`[Memory]  First finalized AEGIS decision for this recipient.`);
  }
  console.log(
    `[Memory]  Sender escrows=${senderMemory.totalSent} ` +
      `approved=${senderMemory.approved} rejected=${senderMemory.rejected} ` +
      `strongRejections=${senderMemory.strongRejections} ` +
      `lastWindowCount=${senderMemory.recentEscrowCount} ` +
      `counterparties=${senderCounterparties === null ? "UNKNOWN" : senderCounterparties.length}`
  );

  // ── Step 4: Run rule engine ─────────────────────────────────────────────
  const ruleResult = runRules({
    security,
    intel,
    amountBNB,
    sender: sender as `0x${string}`,
    recipient: recipient as `0x${string}`,
    recipientMemory,
    senderMemory: senderMemoryRead,
    senderCounterparties,
    delegateSecurity,
    localDenylistHit,
  });
  const ruleEngineContext = toRuleContext(ruleResult);
  const ruleSignals: RuleSignal[] = ruleResult.signals;
  console.log(
    `[Rules]   decision=${ruleResult.decision} rule=${ruleResult.triggeredRule}` +
      (ruleSignals.length > 0
        ? ` signals=[${ruleSignals.map((s) => `${s.rule}(${s.severity})`).join(", ")}]`
        : "")
  );
  publish({
    escrowId,
    phase: "rules",
    status: ruleResult.decision === "REJECT" ? "fail" : "ok",
    label:
      ruleResult.decision === "REJECT"
        ? `Hard rule REJECT — ${ruleResult.triggeredRule}`
        : `Rules passed → AI hearing (${ruleResult.triggeredRule})`,
    detail: ruleResult.reason,
    data: {
      decision: ruleResult.decision,
      rule: ruleResult.triggeredRule,
      signals: ruleSignals,
    },
  });

  // The Investigator is told which deterministic signals fired, so the hearing reasons
  // about the same observations the rule engine did instead of rediscovering them.
  const ruleContext = formatRuleSignals(ruleSignals);

  // ── Step 5: Hard REJECT from rules → generate AI explanation, then stop ────
  if (ruleResult.decision === "REJECT") {
    console.log(`[Final]   REJECT (hard rule — ${ruleResult.triggeredRule})`);
    console.log(`[LLM]     Generating AI explanation for hard rule rejection...`);
    publish({
      escrowId,
      phase: "final",
      status: "start",
      label: "Explaining the hard rule rejection",
    });

    // Decision is FINAL (REJECT). Only the explanation is AI-generated.
    const explanation = await generateHardRuleExplanation({
      recipient,
      amountBNB,
      security,
      intel,
      memoryContext,
      triggeredRule: ruleResult.triggeredRule,
      ruleContext: ruleResult.reason,
    });
    const finalReason = finalizeReason(explanation, intel, recipientMemory);

    console.log(`[Final]   Reason: ${finalReason}`);
    publish({
      escrowId,
      phase: "final",
      status: "done",
      label: "REJECTED (hard rule)",
      detail: finalReason,
      data: { eligible: false, decidedBy: "hard_rule" },
    });
    return {
      eligible: false,
      confidence: 1.0,
      riskLevel: "CRITICAL",
      reason: finalReason,
      decidedBy: "hard_rule",
      triggeredRule: ruleResult.triggeredRule,
      // No debate runs on this path, so the transcript would be empty — the rule verdict
      // itself has to be persisted, or a later `getAddressMemory` cannot tell whether
      // this rejection was a positive identification or a shape-based one.
      ruleEngine: ruleEngineContext,
      toolsUsed: [],
      evidence: { security, intel },
    };
  }

  // ── Step 6: Investigator ─────────────────────────────────────────────────────
  //
  // Two interchangeable implementations behind one output shape:
  //   native  (AGENT_NATIVE_TOOLS=true, default) — the model calls the read-only
  //           tool registry itself, up to AGENT_MAX_STEPS rounds.
  //   legacy  (AGENT_NATIVE_TOOLS=false)         — the pre-agent pipeline: one
  //           JSON call listing `needsData`, tools executed in code, one optional
  //           second call. Pinned by AGENT_MAX_STEPS=1.
  //
  // Both are bounded by the SAME per-escrow `budget`, so switching modes can never
  // change the worst-case cost of an escrow.
  const budget = createEscrowBudget();
  const nativeTools = config.AGENT_NATIVE_TOOLS;
  console.log(
    `[LLM]     Investigator: ${config.OLLAMA_MODEL} via Ollama ` +
      `(${nativeTools ? "native tools" : "legacy needsData"}, budget ${budget.describe()})`
  );
  publish({
    escrowId,
    phase: "investigator",
    status: "start",
    label: "Investigator assessing the case",
    detail: `Model ${config.OLLAMA_MODEL} · ${budget.describe()}`,
  });

  // Address scope for every tool in this hearing. Threaded through the whole run
  // so the discovered-address cap bounds the investigation, not each turn of it.
  const toolCtx = createToolContext(sender, recipient);

  /** Tools actually executed, in order, deduped — for the decision record. */
  const toolsUsed: string[] = [];
  /** Per-agent tool trace, for SSE + auditing. */
  const agentTrace: AgentTraceEntry[] = [];

  /**
   * Publish one agent step and fold it into the trace.
   *
   * The UI needs to see that an agent is *working* — with a local 8B model a
   * multi-round investigation can take a minute, and a hearing that looks frozen
   * is indistinguishable from one that has crashed.
   */
  const onAgentStep = (agent: string, event: AgentStepEvent): void => {
    for (const name of event.toolNames) {
      if (!toolsUsed.includes(name)) toolsUsed.push(name);
    }
    const kindLabel =
      event.kind === "tool_request"
        ? `requested ${event.toolNames.length} tool(s): ${event.toolNames.join(", ")}`
        : event.kind === "budget_stop"
          ? "stopped — LLM call budget exhausted"
          : "produced its verdict";
    agentTrace.push({
      agent,
      step: event.index,
      kind: event.kind,
      toolNames: event.toolNames,
      llmCalls: event.llmCalls,
    });
    publish({
      escrowId,
      phase: "agent_step",
      status: event.kind === "budget_stop" ? "fail" : "ok",
      label: `${agent} step ${event.index}: ${kindLabel}`,
      detail: `LLM call ${event.llmCalls} · ${Math.round(event.generationMs / 100) / 10}s generation`,
      data: {
        agent,
        step: event.index,
        kind: event.kind,
        toolNames: event.toolNames,
        llmCalls: event.llmCalls,
      },
    });
  };

  /**
   * The pre-agent Investigator: one JSON call listing `needsData`, tools executed
   * purely in code (0 LLM calls), then ONE optional follow-up call.
   *
   * Kept byte-for-byte equivalent in behaviour to the pre-agent pipeline so that
   * `AGENT_NATIVE_TOOLS=false` is a true regression baseline rather than a
   * second implementation. It is bounded the same way as the native path: at most
   * 2 LLM calls, both charged to the same per-escrow budget, and a failed
   * follow-up keeps the first-round assessment instead of failing the escrow.
   */
  let legacyToolBlock: string | undefined;

  async function runLegacyInvestigator(
    input: LLMInput
  ): Promise<LLMDecision> {
    const first = budget.tryReserve(1);
    if (!first.ok) {
      throw new Error(
        `Investigator could not start: escrow LLM-call budget exhausted (${budget.describe()})`
      );
    }
    const round1 = await callLLM(input);

    const { requested, dropped } = sanitizeNeedsData(round1.needsData);
    if (dropped.length > 0) {
      console.warn(`[Agent]   Unknown tools ignored: ${dropped.join(", ")}`);
    }
    if (requested.length === 0) {
      return round1;
    }

    console.log(`[Agent]   Investigator requests data: ${requested.join(", ")}`);
    publish({
      escrowId,
      phase: "tools",
      status: "start",
      label: `Tool calling: ${requested.join(", ")}`,
    });
    onAgentStep("Investigator", {
      index: 1,
      kind: "tool_request",
      toolNames: requested,
      generationMs: 0,
      llmCalls: 1,
    });

    const exec = await executeTools(requested, toolCtx);
    for (const name of exec.succeeded) {
      if (!toolsUsed.includes(name)) toolsUsed.push(name);
    }

    const okTools = exec.succeeded.filter((n) => !exec.unavailable.includes(n));
    const allFailed = exec.failed.length > 0 && exec.succeeded.length === 0;
    const toolLabels: string[] = [];
    if (okTools.length > 0) toolLabels.push(`Tool OK: ${okTools.join(", ")}`);
    if (exec.unavailable.length > 0)
      toolLabels.push(`Tool unavailable: ${exec.unavailable.join(", ")}`);

    console.log(
      `[Agent]   Tools finished: ${okTools.length} succeeded, ` +
        `${exec.unavailable.length} unavailable` +
        (exec.unavailable.length > 0 ? ` (${exec.unavailable.join(", ")})` : "") +
        `, ${exec.failed.length} failed` +
        (exec.failed.length > 0 ? ` (${exec.failed.join(", ")})` : "")
    );
    publish({
      escrowId,
      phase: "tools",
      status: allFailed ? "fail" : "ok",
      label: allFailed ? "All tools failed" : toolLabels.join(" · ") || "Tool calling finished",
      detail: exec.failed.length > 0 ? `failed: ${exec.failed.join(", ")}` : undefined,
      data: {
        succeeded: okTools,
        unavailable: exec.unavailable,
        failed: exec.failed,
      },
    });

    if (exec.succeeded.length === 0) {
      console.warn(
        `[Agent]   No usable tool evidence (all requested tools failed) — using the first-round assessment.`
      );
      return round1;
    }

    legacyToolBlock = exec.block;

    const second = budget.tryReserve(1);
    if (!second.ok) {
      console.warn(
        `[Agent]   Second Investigator round skipped — escrow LLM-call budget exhausted ` +
          `(${budget.describe()}). Using the first-round assessment.`
      );
      return round1;
    }

    console.log(`[Agent]   Investigator second round with additional data...`);
    publish({
      escrowId,
      phase: "investigator",
      status: "start",
      label: "Investigator second round (additional evidence)",
    });
    try {
      const followUp = await callLLM({ ...input, toolResults: exec.block, followUp: true });
      onAgentStep("Investigator", {
        index: 2,
        kind: "final",
        toolNames: [],
        generationMs: 0,
        llmCalls: 2,
      });
      const updated: LLMDecision = { ...followUp, needsData: [] };
      console.log(
        `[Investigator] Updated: eligible=${updated.eligible} ` +
          `confidence=${updated.confidence.toFixed(2)}`
      );
      console.log(`[Investigator] Reason: ${updated.reason}`);
      publish({
        escrowId,
        phase: "investigator",
        status: "ok",
        label: `Investigator (update): ${updated.eligible ? "supports RELEASE" : "supports REJECT"}`,
        detail: updated.reason,
        data: {
          eligible: updated.eligible,
          confidence: updated.confidence,
          riskLevel: updated.riskLevel,
        },
      });
      return updated;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[Agent]   Second round failed (${msg}) — using the first-round assessment.`);
      publish({
        escrowId,
        phase: "investigator",
        status: "fail",
        label: "Second round failed — using the initial assessment",
        detail: msg,
      });
      return round1;
    }
  }

  /** Tool evidence, as one block, for the Advocate and Judge. */
  let toolResultsBlock: string | undefined;

  let investigator: LLMDecision;
  try {
    investigator = nativeTools
      ? await runInvestigatorAgent(
          { sender, recipient, amountBNB, security, intel, memoryContext, senderContext, ruleContext },
          toolCtx,
          budget,
          {
            onStep: (e) => onAgentStep("Investigator", e),
          }
        )
      : await runLegacyInvestigator({
          sender,
          recipient,
          amountBNB,
          security,
          intel,
          memoryContext,
          senderContext,
          ruleContext,
        });
    toolResultsBlock = legacyToolBlock;
    investigator = { ...investigator, reason: finalizeReason(investigator.reason, intel, recipientMemory) };
    console.log(
      `[Investigator] eligible=${investigator.eligible} ` +
      `confidence=${investigator.confidence.toFixed(2)} ` +
      `riskLevel=${investigator.riskLevel}`
    );
    console.log(`[Investigator] Reason: ${investigator.reason}`);
    publish({
      escrowId,
      phase: "investigator",
      status: "ok",
      label: `Investigator: ${investigator.eligible ? "supports RELEASE" : "supports REJECT"}`,
      detail: investigator.reason,
      data: {
        eligible: investigator.eligible,
        confidence: investigator.confidence,
        riskLevel: investigator.riskLevel,
      },
    });
  } catch (err) {
    // ── Investigator failure → fail-safe REJECT ───────────────────────────────
    // Covers the legacy throw, the native loop running out of budget, and an
    // answer that is not a verdict. An investigator that stopped looking has not
    // cleared anything, so the only safe reading is "not established".
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[LLM]     ERROR: ${msg}`);
    console.log(`[Final]   REJECT (fail-safe — Investigator unavailable/error)`);
    const llmFailReason = finalizeReason(
      `The Investigator analysis failed (${msg}). Funds are returned to the sender as a fail-safe action.`,
      intel,
      recipientMemory
    );
    publish({
      escrowId,
      phase: "investigator",
      status: "fail",
      label: "Investigator failed",
      detail: msg,
    });
    publish({
      escrowId,
      phase: "final",
      status: "done",
      label: "REJECTED (fail-safe)",
      detail: llmFailReason,
      data: { eligible: false, decidedBy: "fail_safe" },
    });
    return failSafe(llmFailReason, "FAIL_LLM_ERROR", security, intel, ruleEngineContext);
  }


  // ── Step 6c: MULTI-AGENT DEBATE — Advocate (steelman of the opposite position) ─
  // The Advocate collects its OWN side evidence in code first. It used to argue
  // with less information than the Investigator (no sender profile, no sender
  // history), which made the adversarial round weak.
  const advocateEvidence = await buildAdvocateEvidence(toolCtx);
  const advocateContext = advocateEvidence.context;
  // The sender-side GoPlus result is DECISIVE, not advisory: the Advocate found a
  // GoPlus-flagged sender during a live test and the Judge released the transfer
  // at 0.95 confidence anyway. The guard below makes that impossible, and the
  // screen is fetched here (deterministically) rather than being left to whichever
  // agent happens to ask for a sender profile.
  const senderSecurity = advocateEvidence.senderSecurity;
  if (senderSecurity.status === "malicious") {
    console.log(
      `[Sender]  GoPlus flags the SENDER itself: [${senderSecurity.riskFlags.join(", ")}] ` +
        `(chains ${(senderSecurity.flaggedChains ?? []).join("+") || "n/a"})`
    );
    publish({
      escrowId,
      phase: "evidence",
      status: "ok",
      label: "GoPlus flags the SENDER",
      detail: `The sender is flagged: ${senderSecurity.riskFlags.join(", ")}`,
      data: { senderFlags: senderSecurity.riskFlags },
    });
  } else {
    console.log(
      `[Sender]  GoPlus sender check: ${senderSecurity.status}` +
        (senderSecurity.status === "unavailable" ? " (unknown — not treated as safe)" : "")
    );
  }
  const llmInput: LLMInput = {
    sender,
    recipient,
    amountBNB,
    security,
    intel,
    memoryContext,
    senderContext,
    ruleContext,
    advocateContext,
  };
  let advocate: AdvocateResult | null = null;

  try {
    const advPos = investigator.eligible ? "REJECT" : "RELEASE";
    console.log(
      `[Advocate] Building arguments for position ` +
      `${advPos} (opposite to the Investigator)...`
    );
    publish({
      escrowId,
      phase: "advocate",
      status: "start",
      label: `Advocate arguing for position ${advPos}`,
      detail: "Building the adversarial steelman…",
    });

    // Native: the Advocate may run its own short tool loop (ADVOCATE_MAX_STEPS);
    // the loop reserves its own calls. Legacy: a single JSON call, so the caller
    // must reserve that one call here — an unreserved call is a call the escrow
    // budget cannot see, which is how a "bounded" hearing stops being bounded.
    if (nativeTools) {
      advocate = await runAdvocateAgent(
        llmInput,
        investigator,
        advPos,
        toolResultsBlock,
        toolCtx,
        budget,
        { onStep: (e) => onAgentStep("Advocate", e) }
      );
    } else {
      const advocateReserved = budget.tryReserve(1);
      if (!advocateReserved.ok) {
        throw new Error(
          `no LLM-call budget left for the Advocate (${budget.describe()}); ` +
            `the Judge continues without adversarial arguments`
        );
      }
      advocate = await callAdvocate(llmInput, investigator, toolResultsBlock);
    }

    console.log(`[Advocate] position=${advocate.position}`);
    console.log(`[Advocate] Argument: ${advocate.argument}`);
    publish({
      escrowId,
      phase: "advocate",
      status: "ok",
      label: `Advocate: ${advocate.position}`,
      detail: advocate.argument,
      data: { position: advocate.position },
    });
  } catch (err) {
    // DEGRADE, never reject. The Advocate exists to make the hearing adversarial;
    // if it cannot argue, the hearing still has the Investigator, the evidence and
    // the Judge. Rejecting here would turn an absent steelman into a verdict
    // against the recipient, which is not what "the lawyer was silent" means.
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[Advocate] Failed (${msg}) — the Judge still runs without adversarial arguments.`);
    publish({
      escrowId,
      phase: "advocate",
      status: "fail",
      label: "Advocate failed — Judge continues without arguments",
      detail: msg,
    });
    advocate = null;
  }

  // ── Step 6d: Judge — final decision after the debate ──────────────────────
  //
  // Judge #1 is the ONLY call in the escrow that is offered the `request_evidence`
  // action. Judge #2 and any forced-ruling call in `resolveEvidenceRequest` are told
  // the option is closed, and the parser refuses it for them regardless — "once per
  // escrow" has to be enforced in code, not merely requested in a prompt.
  let judge: LLMDecision | undefined;
  let judgeOutcome: JudgeOutcome | null = null;
  const judgeReserved = budget.tryReserve(1);
  if (!judgeReserved.ok) {
    const msg = `the escrow LLM-call budget is exhausted (${budget.describe()})`;
    console.error(`[Judge]    ERROR: ${msg}`);
    const judgeFailReason = finalizeReason(
      `The AI hearing could not run its final round — ${msg}. Funds are returned to the sender as a fail-safe action.`,
      intel,
      recipientMemory
    );
    publish({
      escrowId,
      phase: "judge",
      status: "fail",
      label: "Judge could not run — budget exhausted",
      detail: msg,
    });
    publish({
      escrowId,
      phase: "final",
      status: "done",
      label: "REJECTED (fail-safe)",
      detail: judgeFailReason,
      data: { eligible: false, decidedBy: "fail_safe" },
    });
    return failSafe(judgeFailReason, "FAIL_LLM_ERROR", security, intel, ruleEngineContext);
  }

  /**
   * Fail-safe REJECT for a hearing that has a request but no ruling.
   *
   * "The Judge asked for more evidence" is not a decision and is never a release: an
   * escrow whose hearing ended without a ruling has not been cleared, and treating
   * the absence of a verdict as anything but "not established" is the one error this
   * pipeline must not make. Same outcome path as every other Judge failure.
   */
  const failSafeNoRuling = (msg: string): FinalDecision => {
    const reason = finalizeReason(
      `The AI hearing did not reach a decision — ${msg}. Funds are returned to the sender as a fail-safe action.`,
      intel,
      recipientMemory
    );
    publish({
      escrowId,
      phase: "final",
      status: "done",
      label: "REJECTED (fail-safe)",
      detail: reason,
      data: { eligible: false, decidedBy: "fail_safe" },
    });
    return failSafe(reason, "FAIL_LLM_ERROR", security, intel, ruleEngineContext);
  };

  // `forceJudgeRuling` (the "ruling with the evidence option closed" call, which
  // reserves its own single call) moved into `resolveEvidenceRequest` above, next to
  // the only two paths allowed to reach it.

  try {
    console.log(`[Judge]    Weighing the evidence + Investigator + Advocate...`);
    publish({
      escrowId,
      phase: "judge",
      status: "start",
      label: "Judge weighing the evidence + both opinions",
    });
    judgeOutcome = await callJudge(llmInput, investigator, advocate, toolResultsBlock, {
      allowRequestEvidence: true,
    });
    if (judgeOutcome.kind === "ruling") {
      judge = judgeOutcome;
      console.log(
        `[Judge]    eligible=${judge.eligible} ` +
          `confidence=${judge.confidence.toFixed(2)} ` +
          `riskLevel=${judge.riskLevel}`
      );
      console.log(`[Judge]    Reason: ${judge.reason}`);
      // The Judge's reason shown to the user (transcript + event) always goes
      // through finalizeReason; the raw `judge.reason` is kept for composing the
      // hold/fail-safe reasons below (so the Facts line is not embedded twice).
      const judgeReasonDisplay = finalizeReason(judge.reason, intel, recipientMemory);
      publish({
        escrowId,
        phase: "judge",
        status: "ok",
        label: `Judge: ${judge.eligible ? "RULING RELEASE" : "RULING REJECT"}`,
        detail: judgeReasonDisplay,
        data: {
          eligible: judge.eligible,
          confidence: judge.confidence,
          riskLevel: judge.riskLevel,
        },
      });
    } else {
      // The Judge declined to rule and named the question instead. Nothing is decided
      // yet — Step 6e either answers it or makes the Judge rule without it.
      console.log(`[Judge]    Requests evidence instead of ruling: ${judgeOutcome.focus}`);
      console.log(`[Judge]    Reason: ${judgeOutcome.reason}`);
      publish({
        escrowId,
        phase: "judge",
        status: "start",
        label: "Judge requests more evidence",
        detail: judgeOutcome.focus,
        data: {
          action: "request_evidence",
          focus: judgeOutcome.focus,
          reason: judgeOutcome.reason,
        },
      });
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[Judge]    ERROR: ${msg}`);
    console.log(`[Final]    REJECT (fail-safe — Judge unavailable/error)`);
    const judgeFailReason = finalizeReason(
      `The AI hearing failed (${msg}). Funds are returned to the sender as a fail-safe action.`,
      intel,
      recipientMemory
    );
    publish({
      escrowId,
      phase: "judge",
      status: "fail",
      label: "Judge failed",
      detail: msg,
    });
    publish({
      escrowId,
      phase: "final",
      status: "done",
      label: "REJECTED (fail-safe)",
      detail: judgeFailReason,
      data: { eligible: false, decidedBy: "fail_safe" },
    });
    return failSafe(judgeFailReason, "FAIL_LLM_ERROR", security, intel, ruleEngineContext);
  }

  // ── Step 6e: Judge's evidence request → focused re-pass → Judge #2 ──────────
  //
  // The one place this pipeline is allowed to change its mind. The Advocate's
  // steelman — or the evidence block itself — can leave a question the Judge is not
  // willing to rule without; the Investigator then gets one narrow, tool-enabled
  // round to close it, and the Judge rules again.
  //
  // It is a DECISION, not a pipeline step: it runs only when Judge #1 returned
  // `request_evidence`. It used to run unconditionally whenever the budget allowed,
  // which meant a fixed extra 2–3 LLM calls on every escrow that reached the debate —
  // cost and latency spent on a re-examination nobody asked for, and a
  // `leanSplitSource: "focused_repass"` in the transcript implying the Investigator
  // had revised a view when it had merely re-read the same facts.
  //
  // Gates, all of which must hold for the re-pass to run:
  //   1. Judge #1 actually asked (see above);
  //   2. native mode — the re-pass needs tools, and the legacy path's fixed
  //      two-round Investigator must stay byte-for-byte comparable;
  //   3. AGENT_MAX_FOLLOWUP_STEPS > 0 — a supported way to run without it;
  //   4. the escrow can reserve the WHOLE evidence-request path — the re-pass ledger
  //      AND Judge #2, together, up front. Reserved together because a re-pass whose
  //      conclusion nobody can judge would leave the hearing in a state no one is
  //      accountable for; reserved in FULL because reserving only the re-pass lets
  //      the last call of the escrow run for free, which is how the per-escrow ceiling
  //      stopped being a ceiling.
  //
  // When any gate fails the escrow still gets a ruling: the Judge is called again with
  // the option closed (its own reservation). If even that cannot be afforded, the
  // escrow fails safe. It is never released on an evidence request.
  //
  // The branch itself is `resolveEvidenceRequest` (defined above), extracted whole so
  // it can be tested without GoPlus, RPC or the DB — and so its two failure modes
  // stay legible: a RE-PASS failure is recovered by Judge #2, which is already paid
  // for and then rules on the ORIGINAL Investigator, while a JUDGE #2 failure ends
  // the escrow: fail-safe, after the unused reservation has been handed back, and
  // never a third Judge call.
  let focusedRepass: LLMDecision | null = null;
  let leanSplitSource: DebateTranscript["leanSplitSource"] = "investigator";
  let evidenceRequest: DebateTranscript["evidenceRequest"] | undefined;

  const evidenceRequested =
    judgeOutcome?.kind === "request_evidence" ? judgeOutcome : null;

  const repassEnabled = nativeTools && config.AGENT_MAX_FOLLOWUP_STEPS > 0;
  /** Worst case of one re-pass run: `AGENT_MAX_FOLLOWUP_STEPS` rounds + the forced final. */
  const repassLedgerSize = focusedRepassLedgerSize();
  /** …plus Judge #2, which is affordable only if reserved with it. */
  const repassReservation = evidenceRequestReservation();

  if (evidenceRequested === null) {
    if (!repassEnabled) {
      console.log(
        `[Repass]  Not applicable — the Judge ruled (${
          !nativeTools ? "legacy mode" : "AGENT_MAX_FOLLOWUP_STEPS=0"
        }, no evidence requested).`
      );
    } else {
      console.log(`[Repass]  Not requested — the Judge ruled on the first pass.`);
    }
  } else {
    const resolved = await resolveEvidenceRequest(
      {
        budget,
        repassEnabled,
        repassLedgerSize,
        repassReservation,
        runFocusedRepass,
        callJudge,
        publish,
        finalize: (reason) => finalizeReason(reason, intel, recipientMemory),
      },
      {
        escrowId,
        llmInput,
        investigator,
        advocate,
        toolCtx,
        toolResultsBlock,
        onAgentStep,
      },
      { focus: evidenceRequested.focus, reason: evidenceRequested.reason }
    );
    focusedRepass = resolved.focusedRepass;
    leanSplitSource = resolved.leanSplitSource;
    evidenceRequest = resolved.evidenceRequest;
    judge = resolved.judge ?? undefined;
    // A fail-safe is the caller's to raise: it needs the escrow's evidence + memory.
    if (resolved.failSafeReason !== null) {
      return failSafeNoRuling(resolved.failSafeReason);
    }
  }

  // Nothing above may leave the hearing undecided: every path either produced a
  // ruling or returned. This is the belt-and-braces that makes "never release on an
  // evidence request" a property of the function rather than of the branch coverage.
  if (judge === undefined) {
    return failSafeNoRuling(`the Judge produced no ruling (${budget.describe()})`);
  }

  /**
   * The Investigator verdict the Judge's final ruling is measured against.
   *
   * After a re-pass those are two different assessments, so comparing the final
   * Judge against the ORIGINAL lean would report a disagreement the hearing never
   * had — and push a case into human review for the wrong reason.
   */
  const effectiveInvestigator = focusedRepass ?? investigator;


  const debate: DebateTranscript = {
    investigator: {
      eligible: investigator.eligible,
      confidence: investigator.confidence,
      riskLevel: investigator.riskLevel,
      reason: investigator.reason,
    },
    advocate,
    /** The Advocate's steelman, when it ran. */
    judge: {
      eligible: judge.eligible,
      confidence: judge.confidence,
      riskLevel: judge.riskLevel,
      reason: finalizeReason(judge.reason, intel, recipientMemory),
    },
    leanSplitSource,
    /**
     * The rule verdict that opened this hearing, stored inside the transcript JSON.
     *
     * This is what makes `decided_by = 'hard_rule'` rows readable later: the `decisions`
     * table has no rule column, so without this the memory layer would have to guess
     * whether an old REJECT was evidence of malice or a fail-safe.
     */
    ruleEngine: ruleEngineContext,
    /** Present only when a focused re-pass actually revised the assessment. */
    ...(focusedRepass !== null ? { focusedRepass } : {}),
    /**
     * Present whenever Judge #1 asked for evidence — including when the request
     * could not be granted, so a hearing that was left undecided on a request is
     * visible in the transcript instead of looking like a clean first-round ruling.
     */
    ...(evidenceRequest !== undefined ? { evidenceRequest } : {}),
  };

  // ── Step 7–9: Final guards (+ human-in-the-loop) ──────────────────────────────
  // `evaluateFinalOutcome` is the ONLY thing that decides the outcome, and it is
  // fed the FINAL judge ruling. `effectiveInvestigator` is the assessment that
  // ruling belongs to — after a re-pass that is the re-pass, not the original lean.
  const guard = evaluateFinalOutcome({
    judgeEligible: judge.eligible,
    judgeConfidence: judge.confidence,
    investigatorEligible: effectiveInvestigator.eligible,
    securityStatus: security.status,
    senderSecurityStatus: senderSecurity.status,
    threshold: config.LLM_CONFIDENCE_THRESHOLD,
    humanMin: config.HUMAN_CONF_MIN,
    humanEscalationEnabled: config.HUMAN_ESCALATION_ENABLED,
  });

  if (guard.kind === "fail_low_confidence") {
    console.log(
      `[Final]   REJECT (fail-safe — Judge confidence ${judge.confidence.toFixed(2)} < min ${config.HUMAN_CONF_MIN})`
    );
    const lowConfReason =
      `The AI judge confidence (${(judge.confidence * 100).toFixed(0)}%) is below ` +
      `the minimum limit (${(config.HUMAN_CONF_MIN * 100).toFixed(0)}%). ` +
      `Funds are returned to the sender as a fail-safe action. Judge analysis: ${judge.reason}`;
    const finalReason = finalizeReason(lowConfReason, intel, recipientMemory);
    publish({
      escrowId,
      phase: "final",
      status: "done",
      label: "REJECTED (low confidence)",
      detail: finalReason,
      data: { eligible: false, decidedBy: "fail_safe", confidence: judge.confidence },
    });
    return failSafe(finalReason, "FAIL_LOW_CONFIDENCE", security, intel, ruleEngineContext);
  }

  // ── Step 8: Hard override check ───────────────────────────────────────────
  // GoPlus malicious ALWAYS wins, on either side of the transfer. The debate
  // cannot beat the security intel.
  if (guard.kind === "override_malicious") {
    const flaggedSide = guard.side === "sender" ? senderSecurity : security;
    const flaggedAddress = guard.side === "sender" ? sender : recipient;
    console.log(
      `[Final]   REJECT (hard override — GoPlus malicious on the ${guard.side.toUpperCase()} ` +
        `overrides Judge eligible=${judge.eligible})`
    );
    const overrideExplanation = await generateHardRuleExplanation({
      recipient,
      amountBNB,
      security,
      intel,
      memoryContext,
      triggeredRule:
        guard.side === "sender" ? "OVERRIDE_GOPLUS_MALICIOUS_SENDER" : "OVERRIDE_GOPLUS_MALICIOUS",
      ruleContext:
        guard.side === "sender"
          ? `GoPlus detected malicious signals [${flaggedSide.riskFlags.join(", ")}] on the SENDER (${flaggedAddress}). Routing flagged funds through the escrow is a laundering pattern; the hard security rule overrides the AI debate decision regardless of how clean the recipient looks.`
          : `GoPlus detected malicious signals [${flaggedSide.riskFlags.join(", ")}] on the RECIPIENT (${flaggedAddress}). The hard security rule overrides the AI debate decision.`,
    });
    const finalReason = finalizeReason(overrideExplanation, intel, recipientMemory);
    publish({
      escrowId,
      phase: "final",
      status: "done",
      label: `REJECTED (GoPlus ${guard.side} override)`,
      detail: finalReason,
      data: { eligible: false, decidedBy: "hard_rule", flaggedSide: guard.side },
    });
    return {
      eligible: false,
      confidence: 1.0,
      riskLevel: "CRITICAL",
      reason: finalReason,
      decidedBy: "hard_rule",
      triggeredRule:
        guard.side === "sender" ? "OVERRIDE_GOPLUS_MALICIOUS_SENDER" : "OVERRIDE_GOPLUS_MALICIOUS",
      // The post-debate override is its own finding: the rule engine passed this
      // escrow (that is why a debate ran at all) and the debounced verdict is what
      // identifies the address. `getAddressMemory` reads this id to confirm malice.
      ruleEngine: {
        decision: "REJECT",
        triggeredRule:
          guard.side === "sender"
            ? "OVERRIDE_GOPLUS_MALICIOUS_SENDER"
            : "OVERRIDE_GOPLUS_MALICIOUS",
        signals: [],
      },
      toolsUsed,
      debate,
      agentTrace,
      evidence: { security, intel },
    };
  }

  // ── Step 8b: Human-in-the-loop HOLD (do NOT submit on-chain) ───────────────
  if (guard.kind === "needs_human") {
    console.log(`[Final]   HOLD (human review — ${guard.reason})`);
    const finalReason = finalizeReason(
      `${guard.reason} AI recommendation: ${judge.eligible ? "RELEASE" : "REJECT"}. ${judge.reason}`,
      intel,
      recipientMemory
    );
    publish({
      escrowId,
      phase: "human",
      status: "start",
      label: "Waiting for human veto",
      detail: guard.reason,
      data: {
        aiRecommendation: judge.eligible,
        confidence: judge.confidence,
        riskLevel: judge.riskLevel,
      },
    });
    publish({
      escrowId,
      phase: "final",
      status: "start",
      label: "HOLD — not a final ruling",
      detail: finalReason,
      data: {
        needsHuman: true,
        aiRecommendation: judge.eligible,
        confidence: judge.confidence,
      },
    });
    return {
      eligible: judge.eligible,
      confidence: judge.confidence,
      riskLevel: judge.riskLevel,
      reason: finalReason,
      decidedBy: "human_review",
      needsHuman: true,
      humanReason: guard.reason,
      // Not a verdict yet — but the signals that produced the HOLD are persisted, so
      // the human (and a later audit) can see why it was escalated. `countConfirmedMaliciousRejects`
      // only counts `status = 'final'` rows, so this HOLD can never confirm malice.
      ruleEngine: ruleEngineContext,
      toolsUsed,
      debate,
      agentTrace,
      evidence: { security, intel },
    };
  }

  // ── Step 9: Accept Judge decision ─────────────────────────────────────────
  const outcome = judge.eligible ? "RELEASE" : "REJECT";
  const finalReason = finalizeReason(judge.reason, intel, recipientMemory);
  console.log(
    `[Final]   ${outcome} (Judge/debate — confidence=${judge.confidence.toFixed(2)} risk=${judge.riskLevel})`
  );
  publish({
    escrowId,
    phase: "final",
    status: "done",
    label: judge.eligible ? "RELEASED" : "RETURNED",
    detail: finalReason,
    data: {
      eligible: judge.eligible,
      confidence: judge.confidence,
      riskLevel: judge.riskLevel,
      decidedBy: "llm",
    },
  });

  return {
    eligible: judge.eligible,
    confidence: judge.confidence,
    riskLevel: judge.riskLevel,
    reason: finalReason,
    decidedBy: "llm",
    // Carried so a later LLM rejection of the same address is auditable against the
    // signals the hearing was given. It is NEVER read as a malicious confirmation:
    // `countConfirmedMaliciousRejects` only counts confirmed hard rules, the GoPlus
    // override and human vetoes.
    ruleEngine: ruleEngineContext,
    toolsUsed,
    debate,
    agentTrace,
    evidence: { security, intel },
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────────
/**
 * Finalize the reason shown to the user: (1) deterministically correct phrases
 * that contradict the data, (2) insert a "Facts" line from CODE (not from
 * the model) — guaranteed to contain the transaction count (with its source)
 * plus the AEGIS history, whatever the LLM outputs. The reason is still sent
 * on-chain (truncated when over the limit).
 *
 * Exported for the same reason `resolveEvidenceRequest` is: the string that goes
 * on-chain has to be verifiable without a live chain, a warm DB and a model.
 */
export function finalizeReason(
  reason: string,
  intel: OnChainIntel,
  memory: AddressMemory | null
): string {
  const txPart =
    intel.txCount === null
      ? "transaction count = unknown"
      : intel.txCountSource === "explorer"
        ? `on-chain transactions for the account = ${intel.txCount} (explorer, in+out)`
        : `outgoing transactions = ${intel.txCount} (RPC nonce — incoming transactions are not counted)`;
  const vaultPart = intel.aegisLogsUnavailable
    ? "AEGIS vault history = unknown"
    : `AEGIS vault escrows = ${intel.aegisEscrowIn}` +
      (intel.aegisWindowLimited ? " (partial window, lower bound)" : "");
  // An unreadable history is reported as unreadable. The empty-memory fallback exists so
  // the *rules* skip their history checks; reusing it here would write "never before
  // (first evaluation)" on-chain for an address whose history simply could not be read.
  const memori =
    memory === null
      ? "unavailable (database read failed)"
      : formatMemoryFacts(memory);
  const body = normalizeReasonFacts(reason, intel, memory);
  // The Facts line is placed at the START: the reason is sent on-chain via
  // truncateReason() (MAX_REASON_BYTES limit ~1 KB) — if it were at the end,
  // the first part would be the one truncated. This function is idempotent
  // (an old Facts line is discarded first).
  return `Facts: ${txPart} · ${vaultPart} · AEGIS history = ${memori}\n${body}`;
}

/**
 * Deterministic correction of reason phrases that CONTRADICT the data
 * (the 8B model sometimes still violates the prompt rules). Only patterns that
 * are objectively wrong are touched:
 *  - a txCount sourced from the RPC nonce (outgoing transactions) must not be
 *    written as "N on-chain transactions";
 *  - AEGIS memory with N>0 must not be written as "first evaluation".
 * An old "Facts" line (if the reason was already finalized) is discarded too, so
 * finalizeReason is safe to call repeatedly.
 */
function normalizeReasonFacts(
  reason: string,
  intel: OnChainIntel,
  memory: AddressMemory | null
): string {
  let out = reason.replace(/[ \t]*Facts: [^\n]*/g, " ");

  if (intel.txCountSource === "rpc_nonce" && intel.txCount !== null) {
    const n = intel.txCount;
    out = out.replace(
      new RegExp(`\\b${n}\\s+on-chain transactions\\b`, "gi"),
      `${n} outgoing transactions (RPC nonce)`
    );
    // The 8B model also reaches for the wording our own novelty label uses
    // ("nonce 0", "never sent an outgoing transaction") and then contradicts the
    // Facts line when the nonce is not actually 0. Observed live: a 4166-nonce
    // address explained as "never sent an outgoing transaction (nonce 0)".
    if (n > 0) {
      out = out
        .replace(/\bnonce\s*0\b/gi, `nonce ${n}`)
        .replace(
          /\b(?:has\s+)?never sent an outgoing transaction\b/gi,
          `has sent ${n} outgoing transactions`
        )
        .replace(
          /\bhas never made an outgoing transaction\b/gi,
          `has made ${n} outgoing transactions`
        )
        .replace(
          /\bno outgoing transactions\b/gi,
          `${n} outgoing transactions (RPC nonce)`
        );
    }
    out = out.replace(
      new RegExp(`\\btransaction history\\s+${n}\\b`, "gi"),
      `${n} outgoing transactions`
    );
    // Any total BELOW the nonce is arithmetically impossible — the nonce is the
    // number of transactions this account has actually sent. Observed live: the
    // second-round Investigator described a 4166-nonce address as having
    // "0 on-chain transactions".
    if (n > 0) {
      out = out.replace(/\b(\d+)\s+on-chain transactions\b/gi, (m, numStr: string) =>
        Number(numStr) < n ? `at least ${n} outgoing transactions (RPC nonce)` : m
      );
      out = out.replace(
        /\bno on-chain transactions\b/gi,
        `at least ${n} outgoing transactions (RPC nonce)`
      );
    } else {
      out = out.replace(
        /\bno on-chain transactions\b/gi,
        "no outgoing transactions (RPC nonce)"
      );
    }
  } else if (intel.txCount === null) {
    out = out.replace(
      /\b\d+\s+on-chain transactions\b/gi,
      "transaction count unknown"
    );
  }

  if (memory !== null && memory.totalSeen > 0) {
    const seen = memory.totalSeen;
    out = out.replace(
      /(^|[\s.,;:)])(?:and\s+)?(?:has\s+)?never (?:transacted(?:\s+via\s+AEGIS)?|been evaluated)(?:\s*\(?\s*first evaluation\s*\)?)?/gi,
      (_m, pre: string) => `${pre}has transacted via AEGIS ${seen}x`
    );
    out = out.replace(
      /(^|[\s.,;:)])(?:and\s+)?never been evaluated/gi,
      (_m, pre: string) => `${pre}has been evaluated ${seen}x`
    );
    out = out.replace(
      /([ \t]*)\(?\s*first evaluation\s*\)?/gi,
      (_m, sp: string) => `${sp}AEGIS evaluation #${seen}`
    );
  }

  return out
    // Cosmetic but observed live: the 8B model writes "0.0005 B0NB".
    .replace(/\bB(\d+[.,]?\d*)NB\b/g, "B$1NB")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{2,}/g, "\n")
    .trim();
}

/**
 * The fail-safe decision: "we could not establish this, so the money goes back".
 *
 * `triggeredRule` records WHY the analysis failed, not what the recipient did. The
 * accompanying `ruleEngine` verdict is stored so the audit trail is complete, and the
 * memory layer deliberately treats a fail-safe row as a NON-confirmation — otherwise
 * one Ollama outage would blacklist the recipient forever.
 */
function failSafe(
  reason: string,
  triggeredRule: string,
  security?: SecurityCheckResult,
  intel?: OnChainIntel,
  ruleEngine?: RuleEngineContext
): FinalDecision {
  return {
    eligible: false,
    confidence: 1.0,
    riskLevel: "CRITICAL",
    reason,
    decidedBy: "fail_safe",
    triggeredRule,
    ...(ruleEngine ? { ruleEngine } : {}),
    toolsUsed: [],
    evidence: {
      security: security ?? unavailableSecurity(),
      intel: intel ?? unknownIntel(),
    },
  };
}

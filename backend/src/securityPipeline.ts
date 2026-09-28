import { isAddress } from "viem";
import { config } from "./config.js";
import { checkAddressSecurity, type SecurityCheckResult } from "./goplusChecker.js";
import { getOnChainIntel, type OnChainIntel } from "./bscscanChecker.js";
import { runRules } from "./ruleEngine.js";
import {
  callLLM,
  callAdvocate,
  callJudge,
  generateHardRuleExplanation,
  type LLMDecision,
  type AdvocateResult,
  type DebateTranscript,
} from "./aiAnalyzer.js";
import {
  getAddressMemory,
  formatMemoryForPrompt,
  formatMemoryFacts,
  type AddressMemory,
} from "./agentMemory.js";
import { executeTools, sanitizeNeedsData } from "./tools.js";
import { publish } from "./streamBus.js";

// ── Types ─────────────────────────────────────────────────────────────────────
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
export type FinalGuard =
  | { kind: "fail_low_confidence" }
  | { kind: "override_malicious" }
  | { kind: "needs_human"; reason: string }
  | { kind: "judge"; eligible: boolean };

/**
 * The final guard that DETERMINES the outcome after the Judge.
 * Order (HUMAN_ESCALATION_ENABLED=true, default):
 *   1) conf < humanMin → fail-safe REJECT (conf too low to be worth a vote)
 *   2) GoPlus malicious → hard override REJECT (no vote)
 *   3) conf < threshold → HOLD for human (grey zone)
 *   4) Investigator vs Judge lean differently → HOLD for human (hearing flipped)
 *   5) otherwise → follow the Judge
 * With escalation disabled: the old behaviour — conf < threshold → fail-safe first.
 * The red-team calls this function directly.
 */
export function evaluateFinalOutcome(input: {
  judgeEligible: boolean;
  judgeConfidence: number;
  investigatorEligible?: boolean | undefined;
  securityStatus: SecurityCheckResult["status"];
  threshold: number;
  humanMin: number;
  humanEscalationEnabled: boolean;
}): FinalGuard {
  const { humanEscalationEnabled, humanMin, threshold } = input;

  if (!humanEscalationEnabled) {
    if (input.judgeConfidence < threshold) {
      return { kind: "fail_low_confidence" };
    }
    if (input.securityStatus === "malicious") {
      return { kind: "override_malicious" };
    }
    return { kind: "judge", eligible: input.judgeEligible };
  }

  if (input.judgeConfidence < humanMin) {
    return { kind: "fail_low_confidence" };
  }
  if (input.securityStatus === "malicious") {
    return { kind: "override_malicious" };
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
 * - Maximum LLM calls: Investigator (≤2) + Advocate (1) + Judge (1) = ≤4
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
  console.log(`[Security] Querying GoPlus + BscScan in parallel...`);
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
      return { status: "unavailable", riskFlags: [], source: "unavailable" };
    }),
    getOnChainIntel(recipient).catch((err): OnChainIntel => {
      console.warn(`[BscScan] Unexpected error:`, err);
      return {
        txCount: null,
        txCountSource: "none",
        walletAgeInDays: null,
        isNewWallet: false,
        isContract: false,
        balanceBNB: null,
        unavailable: true,
      };
    }),
  ]);

  // ── Log evidence ──────────────────────────────────────────────────────────
  console.log(
    `[GoPlus]  status=${security.status} flags=[${security.riskFlags.join(", ")}]`
  );
  console.log(
    `[BscScan] txCount=${intel.txCount ?? "?"}(${intel.txCountSource}) ` +
    `age=${intel.walletAgeInDays !== null ? `${intel.walletAgeInDays.toFixed(1)}d` : "?"} ` +
    `isNew=${intel.isNewWallet} ` +
    `isContract=${intel.isContract} ` +
    `balance=${intel.balanceBNB !== null ? `${intel.balanceBNB.toFixed(4)}BNB` : "?"}`
  );
  publish({
    escrowId,
    phase: "evidence",
    status: "ok",
    label: `GoPlus ${security.status}`,
    detail:
      `txCount=${intel.txCount ?? "?"}(${intel.txCountSource}), age=${intel.walletAgeInDays !== null ? intel.walletAgeInDays.toFixed(1) + "d" : "?"}, ` +
      `balance=${intel.balanceBNB !== null ? intel.balanceBNB.toFixed(4) + " BNB" : "?"}` +
      (security.riskFlags.length > 0 ? `, flags=[${security.riskFlags.join(", ")}]` : ""),
    data: { goplus: security.status, flags: security.riskFlags },
  });

  // ── Step 3: Run rule engine ───────────────────────────────────────────────
  const ruleResult = runRules(security, intel, amountBNB);
  console.log(`[Rules]   decision=${ruleResult.decision} rule=${ruleResult.triggeredRule}`);
  publish({
    escrowId,
    phase: "rules",
    status: ruleResult.decision === "REJECT" ? "fail" : "ok",
    label:
      ruleResult.decision === "REJECT"
        ? `Hard rule REJECT — ${ruleResult.triggeredRule}`
        : `Rules passed → AI hearing (${ruleResult.triggeredRule})`,
    detail: ruleResult.reason,
    data: { decision: ruleResult.decision, rule: ruleResult.triggeredRule },
  });

  // ── Step 4: Load agent memory (used for the hard rule explanation & AI hearing)
  const memory = getAddressMemory(recipient);
  const memoryContext = formatMemoryForPrompt(memory);

  if (memory.totalSeen > 0) {
    console.log(
      `[Memory]  Recipient seen before: ${memory.totalSeen}x | ` +
      `approved=${memory.totalApproved} rejected=${memory.totalRejected} | ` +
      `hadHardRule=${memory.hadHardRuleReject}`
    );
  } else {
    console.log(`[Memory]  First time seeing this recipient — no history.`);
  }

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
    const finalReason = finalizeReason(explanation, intel, memory);

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
      toolsUsed: [],
      evidence: { security, intel },
    };
  }

  // ── Step 6: Call Investigator (with memory context) ──────────────────────────
  console.log(`[LLM]     Investigator: ${config.OLLAMA_MODEL} via Ollama (with memory)...`);
  publish({
    escrowId,
    phase: "investigator",
    status: "start",
    label: "Investigator assessing the case",
    detail: `Model ${config.OLLAMA_MODEL}`,
  });

  let investigator: LLMDecision;
  try {
    investigator = await callLLM({ sender, recipient, amountBNB, security, intel, memoryContext });
    // The Facts line is also injected into the Investigator's reason — the hearing
    // transcript read by users stays consistent even when the model violates the
    // formatting rules.
    investigator = { ...investigator, reason: finalizeReason(investigator.reason, intel, memory) };
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
    // ── LLM failure → fail-safe REJECT ──────────────────────────────────────
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[LLM]     ERROR: ${msg}`);
    console.log(`[Final]   REJECT (fail-safe — Investigator unavailable/error)`);
    const llmFailReason = finalizeReason(
      `The Investigator analysis failed (${msg}). Funds are returned to the sender as a fail-safe action.`,
      intel,
      memory
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
    return failSafe(
      llmFailReason,
      "FAIL_LLM_ERROR",
      security,
      intel
    );
  }

  // ── Step 6b: Agentic tool loop (at most 1 round) ─────────────────────────
  // The Investigator judges the evidence insufficient → requests data via needsData.
  // Tools are executed purely by code (0 Ollama cost), then the Investigator is
  // called ONCE MORE with the extra evidence. After this the debate hearing runs.
  let toolsUsed: string[] = [];
  let toolResultsBlock: string | undefined;

  if (investigator.needsData.length > 0) {
    const { requested, dropped } = sanitizeNeedsData(investigator.needsData);

    if (dropped.length > 0) {
      console.warn(`[Agent]   Unknown tools ignored: ${dropped.join(", ")}`);
    }

    if (requested.length > 0) {
      console.log(`[Agent]   Investigator requests data: ${requested.join(", ")}`);
      publish({
        escrowId,
        phase: "tools",
        status: "start",
        label: `Tool calling: ${requested.join(", ")}`,
      });

      const exec = await executeTools(requested, { sender, recipient });
      console.log(
        `[Agent]   Tools finished: ${exec.succeeded.length} succeeded, ` +
        `${exec.failed.length} failed` +
        (exec.failed.length > 0 ? ` (${exec.failed.join(", ")})` : "")
      );
      publish({
        escrowId,
        phase: "tools",
        status: exec.failed.length > 0 && exec.succeeded.length === 0 ? "fail" : "ok",
        label:
          exec.succeeded.length > 0
            ? `Tool OK: ${exec.succeeded.join(", ")}`
            : "All tools failed",
        detail: exec.failed.length > 0 ? `failed: ${exec.failed.join(", ")}` : undefined,
        data: { succeeded: exec.succeeded, failed: exec.failed },
      });

      if (exec.succeeded.length > 0) {
        toolResultsBlock = exec.block;
        console.log(`[Agent]   Investigator second round with additional data...`);
        publish({
          escrowId,
          phase: "investigator",
          status: "start",
          label: "Investigator second round (additional evidence)",
        });
        try {
          const followUp = await callLLM({
            sender,
            recipient,
            amountBNB,
            security,
            intel,
            memoryContext,
            toolResults: exec.block,
            followUp: true,
          });
          investigator = {
            ...followUp,
            needsData: [],
            reason: finalizeReason(followUp.reason, intel, memory),
          };
          toolsUsed = exec.succeeded;
          console.log(
            `[Investigator] Updated: eligible=${investigator.eligible} ` +
            `confidence=${investigator.confidence.toFixed(2)}`
          );
          console.log(`[Investigator] Reason: ${investigator.reason}`);
          publish({
            escrowId,
            phase: "investigator",
            status: "ok",
            label: `Investigator (update): ${investigator.eligible ? "supports RELEASE" : "supports REJECT"}`,
            detail: investigator.reason,
            data: {
              eligible: investigator.eligible,
              confidence: investigator.confidence,
              riskLevel: investigator.riskLevel,
            },
          });
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
        }
      } else {
        console.warn(`[Agent]   All tools failed — using the first-round assessment.`);
      }
    }
  }

  // ── Step 6c: MULTI-AGENT DEBATE — Advocate (steelman of the opposite position) ─
  const llmInput = { sender, recipient, amountBNB, security, intel, memoryContext };
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
    advocate = await callAdvocate(llmInput, investigator, toolResultsBlock);
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
  let judge: LLMDecision;
  try {
    console.log(`[Judge]    Weighing the evidence + Investigator + Advocate...`);
    publish({
      escrowId,
      phase: "judge",
      status: "start",
      label: "Judge weighing the evidence + both opinions",
    });
    judge = await callJudge(llmInput, investigator, advocate, toolResultsBlock);
    console.log(
      `[Judge]    eligible=${judge.eligible} ` +
      `confidence=${judge.confidence.toFixed(2)} ` +
      `riskLevel=${judge.riskLevel}`
    );
    console.log(`[Judge]    Reason: ${judge.reason}`);
    // The Judge's reason shown to the user (transcript + event) always goes
    // through finalizeReason; the raw `judge.reason` is kept for composing the
    // hold/fail-safe reasons below (so the Facts line is not embedded twice).
    const judgeReasonDisplay = finalizeReason(judge.reason, intel, memory);
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
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[Judge]    ERROR: ${msg}`);
    console.log(`[Final]    REJECT (fail-safe — Judge unavailable/error)`);
    const judgeFailReason = finalizeReason(
      `The AI hearing failed (${msg}). Funds are returned to the sender as a fail-safe action.`,
      intel,
      memory
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
    return failSafe(
      judgeFailReason,
      "FAIL_LLM_ERROR",
      security,
      intel
    );
  }

  const debate: DebateTranscript = {
    investigator: {
      eligible: investigator.eligible,
      confidence: investigator.confidence,
      riskLevel: investigator.riskLevel,
      reason: investigator.reason,
    },
    advocate,
    judge: {
      eligible: judge.eligible,
      confidence: judge.confidence,
      riskLevel: judge.riskLevel,
      reason: finalizeReason(judge.reason, intel, memory),
    },
  };

  // ── Step 7–9: Final guards (+ human-in-the-loop) ──────────────────────────────
  const guard = evaluateFinalOutcome({
    judgeEligible: judge.eligible,
    judgeConfidence: judge.confidence,
    investigatorEligible: investigator.eligible,
    securityStatus: security.status,
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
    const finalReason = finalizeReason(lowConfReason, intel, memory);
    publish({
      escrowId,
      phase: "final",
      status: "done",
      label: "REJECTED (low confidence)",
      detail: finalReason,
      data: { eligible: false, decidedBy: "fail_safe", confidence: judge.confidence },
    });
    return failSafe(finalReason, "FAIL_LOW_CONFIDENCE", security, intel);
  }

  // ── Step 8: Hard override check ───────────────────────────────────────────
  // GoPlus malicious ALWAYS wins. The debate cannot beat the security intel.
  if (guard.kind === "override_malicious") {
    console.log(
      `[Final]   REJECT (hard override — GoPlus malicious overrides Judge eligible=${judge.eligible})`
    );
    const overrideExplanation = await generateHardRuleExplanation({
      recipient,
      amountBNB,
      security,
      intel,
      memoryContext,
      triggeredRule: "OVERRIDE_GOPLUS_MALICIOUS",
      ruleContext: `GoPlus detected malicious signals [${security.riskFlags.join(", ")}] on this address. The hard security rule overrides the AI debate decision.`,
    });
    const finalReason = finalizeReason(overrideExplanation, intel, memory);
    publish({
      escrowId,
      phase: "final",
      status: "done",
      label: "REJECTED (GoPlus override)",
      detail: finalReason,
      data: { eligible: false, decidedBy: "hard_rule" },
    });
    return {
      eligible: false,
      confidence: 1.0,
      riskLevel: "CRITICAL",
      reason: finalReason,
      decidedBy: "hard_rule",
      triggeredRule: "OVERRIDE_GOPLUS_MALICIOUS",
      toolsUsed,
      debate,
      evidence: { security, intel },
    };
  }

  // ── Step 8b: Human-in-the-loop HOLD (do NOT submit on-chain) ───────────────
  if (guard.kind === "needs_human") {
    console.log(`[Final]   HOLD (human review — ${guard.reason})`);
    const finalReason = finalizeReason(
      `${guard.reason} AI recommendation: ${judge.eligible ? "RELEASE" : "REJECT"}. ${judge.reason}`,
      intel,
      memory
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
      toolsUsed,
      debate,
      evidence: { security, intel },
    };
  }

  // ── Step 9: Accept Judge decision ─────────────────────────────────────────
  const outcome = judge.eligible ? "RELEASE" : "REJECT";
  const finalReason = finalizeReason(judge.reason, intel, memory);
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
    toolsUsed,
    debate,
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
 * Exported so it can be tested directly (smoke test) without running the full pipeline.
 */
export function finalizeReason(
  reason: string,
  intel: OnChainIntel,
  memory: AddressMemory
): string {
  const txPart =
    intel.txCount === null
      ? "transaction count = unknown"
      : intel.txCountSource === "explorer"
        ? `on-chain transactions for the account = ${intel.txCount} (explorer, in+out)`
        : `outgoing transactions = ${intel.txCount} (RPC nonce — incoming transactions are not counted; the explorer is unavailable)`;
  const memori = formatMemoryFacts(memory);
  const body = normalizeReasonFacts(reason, intel, memory);
  // The Facts line is placed at the START: the reason is sent on-chain via
  // truncateReason() (MAX_REASON_BYTES limit ~1 KB) — if it were at the end,
  // the first part would be the one truncated. This function is idempotent
  // (an old Facts line is discarded first).
  return `Facts: ${txPart} · AEGIS history = ${memori}\n${body}`;
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
  memory: AddressMemory
): string {
  let out = reason.replace(/[ \t]*Facts: [^\n]*/g, " ");

  if (intel.txCountSource === "rpc_nonce" && intel.txCount !== null) {
    const n = intel.txCount;
    out = out.replace(
      new RegExp(`\\b${n}\\s+on-chain transactions\\b`, "gi"),
      `${n} outgoing transactions (RPC nonce)`
    );
    out = out.replace(
      new RegExp(`\\btransaction history\\s+${n}\\b`, "gi"),
      `${n} outgoing transactions`
    );
    out = out.replace(
      /\bno on-chain transactions\b/gi,
      "no outgoing transactions (RPC nonce)"
    );
  } else if (intel.txCount === null) {
    out = out.replace(
      /\b\d+\s+on-chain transactions\b/gi,
      "transaction count unknown"
    );
  }

  if (memory.totalSeen > 0) {
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
    .replace(/[ \t]{2,}/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{2,}/g, "\n")
    .trim();
}

function failSafe(
  reason: string,
  triggeredRule: string,
  security?: SecurityCheckResult,
  intel?: OnChainIntel
): FinalDecision {
  return {
    eligible: false,
    confidence: 1.0,
    riskLevel: "CRITICAL",
    reason,
    decidedBy: "fail_safe",
    triggeredRule,
    toolsUsed: [],
    evidence: {
      security: security ?? { status: "unavailable", riskFlags: [], source: "unavailable" },
      intel: intel ?? {
        txCount: null,
        txCountSource: "none",
        walletAgeInDays: null,
        isNewWallet: false,
        isContract: false,
        balanceBNB: null,
        unavailable: true,
      },
    },
  };
}

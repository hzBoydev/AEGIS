import { isAddress } from "viem";
import { config } from "./config.js";
import { checkAddressSecurity, type SecurityCheckResult } from "./goplusChecker.js";
import { getOnChainIntel, unknownIntel, type OnChainIntel } from "./bscscanChecker.js";
import { runRules } from "./ruleEngine.js";
import {
  callLLM,
  callAdvocate,
  callJudge,
  generateHardRuleExplanation,
  type LLMInput,
  type LLMDecision,
  type AdvocateResult,
  type DebateTranscript,
} from "./aiAnalyzer.js";
import {
  getAddressMemory,
  getSenderMemory,
  formatMemoryForPrompt,
  formatMemoryFacts,
  formatSenderMemoryForPrompt,
  type AddressMemory,
} from "./agentMemory.js";
import { executeTools, sanitizeNeedsData, buildAdvocateEvidence } from "./tools.js";
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
      return { status: "unavailable", riskFlags: [], source: "unavailable" };
    }),
    getOnChainIntel(recipient).catch((err) => {
      console.warn(`[OnChain] Unexpected error:`, err);
      return unknownIntel();
    }),
  ]);

  // ── Log evidence ──────────────────────────────────────────────────────────
  console.log(
    `[GoPlus]  status=${security.status} flags=[${security.riskFlags.join(", ")}]` +
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
    data: { goplus: security.status, flags: security.riskFlags, simulated: security.simulated === true },
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

  // ── Step 4: Load agent memory (recipient AND sender) ──────────────────────
  // Both sides matter: the recipient's history says "has this account ever been
  // blocked", the sender's says "is this someone who was already blocked trying
  // again". Previously only the recipient was loaded.
  const memory = getAddressMemory(recipient);
  const memoryContext = formatMemoryForPrompt(memory);
  const senderMemory = getSenderMemory(sender);
  const senderContext = formatSenderMemoryForPrompt(senderMemory);

  if (memory.totalSeen > 0) {
    console.log(
      `[Memory]  Recipient seen before: ${memory.totalSeen}x | ` +
      `approved=${memory.totalApproved} rejected=${memory.totalRejected} | ` +
      `humanRej=${memory.humanRejections} strongReject=${memory.hadHardRuleReject}` +
      (memory.pendingHuman > 0 ? ` | pendingHuman=${memory.pendingHuman}` : "")
    );
  } else {
    console.log(`[Memory]  First finalized AEGIS decision for this recipient.`);
  }
  console.log(
    `[Memory]  Sender escrows=${senderMemory.totalSent} ` +
    `approved=${senderMemory.approved} rejected=${senderMemory.rejected} ` +
    `strongRejections=${senderMemory.strongRejections}`
  );

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
    investigator = await callLLM({
      sender, recipient, amountBNB, security, intel, memoryContext, senderContext,
    });
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
            senderContext,
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
        console.warn(
          `[Agent]   No usable tool evidence (all requested tools failed) — using the first-round assessment.`
        );
      }
    }
  }

  // ── Step 6c: MULTI-AGENT DEBATE — Advocate (steelman of the opposite position) ─
  // The Advocate collects its OWN side evidence in code first. It used to argue
  // with less information than the Investigator (no sender profile, no sender
  // history), which made the adversarial round weak.
  const advocateEvidence = await buildAdvocateEvidence({ sender, recipient });
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
    const finalReason = finalizeReason(overrideExplanation, intel, memory);
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
 */
function finalizeReason(
  reason: string,
  intel: OnChainIntel,
  memory: AddressMemory
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
  const memori = formatMemoryFacts(memory);
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
  memory: AddressMemory
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
    // Cosmetic but observed live: the 8B model writes "0.0005 B0NB".
    .replace(/\bB(\d+[.,]?\d*)NB\b/g, "B$1NB")
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
      intel: intel ?? unknownIntel(),
    },
  };
}

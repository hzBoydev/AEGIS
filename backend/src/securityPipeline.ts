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
import { getAddressMemory, formatMemoryForPrompt } from "./agentMemory.js";
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
   * Nama tool yang dieksekusi AI sebelum keputusan final (tool calling).
   * Kosong [] jika LLM tidak meminta data tambahan.
   */
  toolsUsed: string[];
  /**
   * Transkrip sidang multi-agent (Investigator → Advocate → Judge).
   * Hanya ada pada jalur LLM/debate; hard rule & fail-safe tidak berdebat.
   */
  debate?: DebateTranscript;
  /**
   * True → JANGAN submit on-chain. Tahan escrow, minta 1 suara manusia.
   * `eligible` = rekomendasi AI (untuk ditampilkan), bukan keputusan final.
   */
  needsHuman?: boolean;
  /** Alasan eskalasi (Bahasa Indonesia). */
  humanReason?: string;
  /** Evidence collected during pipeline. */
  evidence: {
    security: SecurityCheckResult;
    intel: OnChainIntel;
  };
}

// ── Final guards (diekspor & diuji red-team — jangan duplikasi logika) ────────
export type FinalGuard =
  | { kind: "fail_low_confidence" }
  | { kind: "override_malicious" }
  | { kind: "needs_human"; reason: string }
  | { kind: "judge"; eligible: boolean };

/**
 * Guard final yang MENENTUKAN outcome setelah Judge.
 * Urutan (HUMAN_ESCALATION_ENABLED=true, default):
 *   1) conf < humanMin → fail-safe REJECT (conf terlalu sampah untuk vote)
 *   2) GoPlus malicious → hard override REJECT (tanpa vote)
 *   3) conf < threshold → HOLD human (zona abu-abu)
 *   4) Investigator vs Judge berbeda lean → HOLD human (sidang berbalik)
 *   5) selain itu → ikut Judge
 * Jika eskalasi dimatikan: perilaku lama — conf < threshold → fail-safe dulu.
 * Red-team memanggil fungsi ini langsung.
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
        `Confidence hakim AI (${(input.judgeConfidence * 100).toFixed(0)}%) berada di zona abu-abu ` +
        `(${(humanMin * 100).toFixed(0)}–${(threshold * 100).toFixed(0)}%). ` +
        `AI tidak cukup yakin untuk memutus sendiri — menunggu 1 suara manusia.`,
    };
  }
  if (
    input.investigatorEligible !== undefined &&
    input.investigatorEligible !== input.judgeEligible
  ) {
    return {
      kind: "needs_human",
      reason:
        `Sidang berbalik: Investigator cenderung ${input.investigatorEligible ? "RELEASE" : "REJECT"}, ` +
        `Judge memutus ${input.judgeEligible ? "RELEASE" : "REJECT"} ` +
        `(confidence ${(input.judgeConfidence * 100).toFixed(0)}%). ` +
        `Opini agen tidak selaras — menunggu veto manusia.`,
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
 *  4. If REJECT → stop, return REJECT (hard rule wins — debate tidak dijalankan)
 *  5. If NEEDS_LLM → Investigator (Qwen3:8b via Ollama)
 *  5b. Tool calling (AGENTIC LOOP, maksimal 1 putaran):
 *      jika Investigator mengisi needsData → eksekusi tool (murni kode, 0 beban LLM)
 *      → panggil Investigator putaran ke-2 dengan bukti tambahan.
 *  5c. MULTI-AGENT DEBATE:
 *      Advocate membangun steelman untuk posisi BERKEBALIKAN dari lean Investigator
 *      → Judge menimbang bukti + kedua opini → keputusan final.
 *  6. Validate LLM JSON output
 *  7. Apply confidence threshold (pada keputusan Judge)
 *  8. Hard rule override: GoPlus malicious ALWAYS wins over any agent
 *  9. Return structured FinalDecision (termasuk debate transcript)
 *
 * HARD GUARANTEES:
 * - GoPlus malicious → REJECT regardless of LLM/Judge output
 * - LLM error / timeout / malformed → fail-safe REJECT
 * - LLM low confidence → fail-safe REJECT
 * - API unavailable ≠ clean (berlaku juga untuk kegagalan tool)
 * - Tool HANYA menambah bukti; tool tidak pernah menentukan eligible/confidence
 * - Advocate TIDAK menghasilkan keputusan — hanya argumen; Judge yang final
 * - Jika Advocate gagal → Judge jalan tanpa argumen (lebih hati-hati)
 * - Jika Judge gagal → fail-safe REJECT
 * - Maksimal LLM call: Investigator (≤2) + Advocate (1) + Judge (1) = ≤4
 *
 * @param sender      EVM address pengirim escrow (0x...)
 * @param recipient   EVM address penerima (0x...)
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
      label: "Alamat tidak valid",
      detail: recipient,
    });
    return failSafe(
      `Format alamat EVM tidak valid: ${recipient}`,
      "FAIL_INVALID_ADDRESS"
    );
  }

  // ── Step 2: Query GoPlus + BscScan in parallel ────────────────────────────
  console.log(`[Security] Querying GoPlus + BscScan in parallel...`);
  publish({
    escrowId,
    phase: "evidence",
    status: "start",
    label: "Mengumpulkan bukti GoPlus + BscScan",
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
    `[BscScan] txCount=${intel.txCount ?? "?"} ` +
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
      `txCount=${intel.txCount ?? "?"}, umur=${intel.walletAgeInDays !== null ? intel.walletAgeInDays.toFixed(1) + "d" : "?"}, ` +
      `saldo=${intel.balanceBNB !== null ? intel.balanceBNB.toFixed(4) + " BNB" : "?"}` +
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
        ? `Hard rule TOLAK — ${ruleResult.triggeredRule}`
        : `Lolos rules → sidang AI (${ruleResult.triggeredRule})`,
    detail: ruleResult.reason,
    data: { decision: ruleResult.decision, rule: ruleResult.triggeredRule },
  });

  // ── Step 4: Hard REJECT from rules → generate AI explanation, then stop ────
  if (ruleResult.decision === "REJECT") {
    console.log(`[Final]   TOLAK (hard rule — ${ruleResult.triggeredRule})`);
    console.log(`[LLM]     Generating AI explanation for hard rule rejection...`);
    publish({
      escrowId,
      phase: "final",
      status: "start",
      label: "Menjelaskan penolakan hard rule",
    });

    // Decision is FINAL (REJECT). Only the explanation is AI-generated.
    const explanation = await generateHardRuleExplanation({
      recipient,
      amountBNB,
      security,
      intel,
      triggeredRule: ruleResult.triggeredRule,
      ruleContext: ruleResult.reason,
    });

    console.log(`[Final]   Alasan: ${explanation}`);
    publish({
      escrowId,
      phase: "final",
      status: "done",
      label: "DITOLAK (hard rule)",
      detail: explanation,
      data: { eligible: false, decidedBy: "hard_rule" },
    });
    return {
      eligible: false,
      confidence: 1.0,
      riskLevel: "CRITICAL",
      reason: explanation,
      decidedBy: "hard_rule",
      triggeredRule: ruleResult.triggeredRule,
      toolsUsed: [],
      evidence: { security, intel },
    };
  }

  // ── Step 5: Load agent memory for recipient ─────────────────────────────
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

  // ── Step 6: Call Investigator (with memory context) ──────────────────────────
  console.log(`[LLM]     Investigator: ${config.OLLAMA_MODEL} via Ollama (dengan memori)...`);
  publish({
    escrowId,
    phase: "investigator",
    status: "start",
    label: "Investigator menilai kasus",
    detail: `Model ${config.OLLAMA_MODEL}`,
  });

  let investigator: LLMDecision;
  try {
    investigator = await callLLM({ sender, recipient, amountBNB, security, intel, memoryContext });
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
      label: `Investigator: ${investigator.eligible ? "dukung RELEASE" : "dukung REJECT"}`,
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
    publish({
      escrowId,
      phase: "investigator",
      status: "fail",
      label: "Investigator gagal",
      detail: msg,
    });
    publish({
      escrowId,
      phase: "final",
      status: "done",
      label: "DITOLAK (fail-safe)",
      detail: `Analisis Investigator gagal (${msg}).`,
      data: { eligible: false, decidedBy: "fail_safe" },
    });
    return failSafe(
      `Analisis Investigator gagal (${msg}). Dana dikembalikan ke pengirim sebagai tindakan fail-safe.`,
      "FAIL_LLM_ERROR",
      security,
      intel
    );
  }

  // ── Step 6b: Agentic tool loop (maksimal 1 putaran) ───────────────────────
  // Investigator menilai bukti belum cukup → meminta data lewat needsData.
  // Tool dieksekusi murni oleh kode (0 beban Ollama), lalu Investigator dipanggil
  // SEKALI LAGI dengan bukti tambahan. Setelah ini sidang debate berjalan.
  let toolsUsed: string[] = [];
  let toolResultsBlock: string | undefined;

  if (investigator.needsData.length > 0) {
    const { requested, dropped } = sanitizeNeedsData(investigator.needsData);

    if (dropped.length > 0) {
      console.warn(`[Agent]   Tool tidak dikenal diabaikan: ${dropped.join(", ")}`);
    }

    if (requested.length > 0) {
      console.log(`[Agent]   Investigator meminta data: ${requested.join(", ")}`);
      publish({
        escrowId,
        phase: "tools",
        status: "start",
        label: `Tool calling: ${requested.join(", ")}`,
      });

      const exec = await executeTools(requested, { sender, recipient });
      console.log(
        `[Agent]   Tool selesai: ${exec.succeeded.length} sukses, ` +
        `${exec.failed.length} gagal` +
        (exec.failed.length > 0 ? ` (${exec.failed.join(", ")})` : "")
      );
      publish({
        escrowId,
        phase: "tools",
        status: exec.failed.length > 0 && exec.succeeded.length === 0 ? "fail" : "ok",
        label:
          exec.succeeded.length > 0
            ? `Tool OK: ${exec.succeeded.join(", ")}`
            : "Semua tool gagal",
        detail: exec.failed.length > 0 ? `gagal: ${exec.failed.join(", ")}` : undefined,
        data: { succeeded: exec.succeeded, failed: exec.failed },
      });

      if (exec.succeeded.length > 0) {
        toolResultsBlock = exec.block;
        console.log(`[Agent]   Investigator putaran ke-2 dengan data tambahan...`);
        publish({
          escrowId,
          phase: "investigator",
          status: "start",
          label: "Investigator putaran ke-2 (bukti tambahan)",
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
          investigator = { ...followUp, needsData: [] };
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
            label: `Investigator (update): ${investigator.eligible ? "dukung RELEASE" : "dukung REJECT"}`,
            detail: investigator.reason,
            data: {
              eligible: investigator.eligible,
              confidence: investigator.confidence,
              riskLevel: investigator.riskLevel,
            },
          });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.warn(`[Agent]   Putaran ke-2 gagal (${msg}) — memakai penilaian putaran ke-1.`);
          publish({
            escrowId,
            phase: "investigator",
            status: "fail",
            label: "Putaran ke-2 gagal — pakai penilaian awal",
            detail: msg,
          });
        }
      } else {
        console.warn(`[Agent]   Semua tool gagal — memakai penilaian putaran ke-1.`);
      }
    }
  }

  // ── Step 6c: MULTI-AGENT DEBATE — Advocate (steelman posisi berkebalikan) ─
  const llmInput = { sender, recipient, amountBNB, security, intel, memoryContext };
  let advocate: AdvocateResult | null = null;

  try {
    const advPos = investigator.eligible ? "REJECT" : "RELEASE";
    console.log(
      `[Advocate] Membangun argumen untuk posisi ` +
      `${advPos} (berkebalikan dari Investigator)...`
    );
    publish({
      escrowId,
      phase: "advocate",
      status: "start",
      label: `Advocate membela posisi ${advPos}`,
      detail: "Steelman adversarial sedang disusun…",
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
    console.warn(`[Advocate] Gagal (${msg}) — Judge tetap jalan tanpa argumen adversarial.`);
    publish({
      escrowId,
      phase: "advocate",
      status: "fail",
      label: "Advocate gagal — Judge lanjut tanpa argumen",
      detail: msg,
    });
    advocate = null;
  }

  // ── Step 6d: Judge — keputusan final setelah debate ───────────────────────
  let judge: LLMDecision;
  try {
    console.log(`[Judge]    Menimbang bukti + Investigator + Advocate...`);
    publish({
      escrowId,
      phase: "judge",
      status: "start",
      label: "Judge menimbang bukti + kedua opini",
    });
    judge = await callJudge(llmInput, investigator, advocate, toolResultsBlock);
    console.log(
      `[Judge]    eligible=${judge.eligible} ` +
      `confidence=${judge.confidence.toFixed(2)} ` +
      `riskLevel=${judge.riskLevel}`
    );
    console.log(`[Judge]    Reason: ${judge.reason}`);
    publish({
      escrowId,
      phase: "judge",
      status: "ok",
      label: `Judge: ${judge.eligible ? "PUTUS RELEASE" : "PUTUS REJECT"}`,
      detail: judge.reason,
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
    publish({
      escrowId,
      phase: "judge",
      status: "fail",
      label: "Judge gagal",
      detail: msg,
    });
    publish({
      escrowId,
      phase: "final",
      status: "done",
      label: "DITOLAK (fail-safe)",
      detail: `Sidang AI gagal (${msg}).`,
      data: { eligible: false, decidedBy: "fail_safe" },
    });
    return failSafe(
      `Sidang AI gagal (${msg}). Dana dikembalikan ke pengirim sebagai tindakan fail-safe.`,
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
      reason: judge.reason,
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
      `Confidence hakim AI (${(judge.confidence * 100).toFixed(0)}%) di bawah ` +
      `batas minimum (${(config.HUMAN_CONF_MIN * 100).toFixed(0)}%). ` +
      `Dana dikembalikan ke pengirim sebagai tindakan fail-safe. Analisis Judge: ${judge.reason}`;
    publish({
      escrowId,
      phase: "final",
      status: "done",
      label: "DITOLAK (confidence rendah)",
      detail: lowConfReason,
      data: { eligible: false, decidedBy: "fail_safe", confidence: judge.confidence },
    });
    return failSafe(lowConfReason, "FAIL_LOW_CONFIDENCE", security, intel);
  }

  // ── Step 8: Hard override check ───────────────────────────────────────────
  // GoPlus malicious ALWAYS wins. Debate tidak bisa mengalahkan security intel.
  if (guard.kind === "override_malicious") {
    console.log(
      `[Final]   REJECT (hard override — GoPlus malicious overrides Judge eligible=${judge.eligible})`
    );
    const overrideExplanation = await generateHardRuleExplanation({
      recipient,
      amountBNB,
      security,
      intel,
      triggeredRule: "OVERRIDE_GOPLUS_MALICIOUS",
      ruleContext: `GoPlus mendeteksi sinyal berbahaya [${security.riskFlags.join(", ")}] pada alamat ini. Hard security rule mengalahkan keputusan debate AI.`,
    });
    publish({
      escrowId,
      phase: "final",
      status: "done",
      label: "DITOLAK (override GoPlus)",
      detail: overrideExplanation,
      data: { eligible: false, decidedBy: "hard_rule" },
    });
    return {
      eligible: false,
      confidence: 1.0,
      riskLevel: "CRITICAL",
      reason: overrideExplanation,
      decidedBy: "hard_rule",
      triggeredRule: "OVERRIDE_GOPLUS_MALICIOUS",
      toolsUsed,
      debate,
      evidence: { security, intel },
    };
  }

  // ── Step 8b: Human-in-the-loop HOLD (jangan submit on-chain) ──────────────
  if (guard.kind === "needs_human") {
    console.log(`[Final]   HOLD (human review — ${guard.reason})`);
    publish({
      escrowId,
      phase: "human",
      status: "start",
      label: "Menunggu veto manusia",
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
      label: "HOLD — bukan putusan final",
      detail: guard.reason,
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
      reason: `${guard.reason} Rekomendasi AI: ${judge.eligible ? "RELEASE" : "REJECT"}. ${judge.reason}`,
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
  console.log(
    `[Final]   ${outcome} (Judge/debate — confidence=${judge.confidence.toFixed(2)} risk=${judge.riskLevel})`
  );
  publish({
    escrowId,
    phase: "final",
    status: "done",
    label: judge.eligible ? "DITERUSKAN" : "DIKEMBALIKAN",
    detail: judge.reason,
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
    reason: judge.reason,
    decidedBy: "llm",
    toolsUsed,
    debate,
    evidence: { security, intel },
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────────
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
        walletAgeInDays: null,
        isNewWallet: false,
        isContract: false,
        balanceBNB: null,
        unavailable: true,
      },
    },
  };
}

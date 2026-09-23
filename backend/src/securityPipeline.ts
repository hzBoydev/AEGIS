import { isAddress } from "viem";
import { config } from "./config.js";
import { checkAddressSecurity, type SecurityCheckResult } from "./goplusChecker.js";
import { getOnChainIntel, type OnChainIntel } from "./bscscanChecker.js";
import { runRules } from "./ruleEngine.js";
import { callLLM, generateHardRuleExplanation, type LLMDecision } from "./aiAnalyzer.js";
import { getAddressMemory, formatMemoryForPrompt } from "./agentMemory.js";
import { executeTools, TOOL_NAMES } from "./tools.js";

// ── Types ─────────────────────────────────────────────────────────────────────
export interface FinalDecision {
  eligible: boolean;
  confidence: number;
  riskLevel: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
  reason: string;
  /** What produced the final decision. */
  decidedBy: "hard_rule" | "llm" | "fail_safe";
  /** Which rule triggered (if hard_rule or fail_safe). */
  triggeredRule?: string;
  /**
   * Nama tool yang dieksekusi AI sebelum keputusan final (tool calling).
   * Kosong [] jika LLM tidak meminta data tambahan.
   */
  toolsUsed: string[];
  /** Evidence collected during pipeline. */
  evidence: {
    security: SecurityCheckResult;
    intel: OnChainIntel;
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
 *  4. If REJECT → stop, return REJECT (hard rule wins)
 *  5. If NEEDS_LLM → call Qwen3:8b via Ollama (putaran ke-1)
 *  5b. Tool calling (AGENTIC LOOP, maksimal 1 putaran):
 *      jika LLM mengisi needsData → eksekusi tool (murni kode, 0 beban LLM)
 *      → panggil LLM putaran ke-2 dengan bukti tambahan → keputusan final.
 *  6. Validate LLM JSON output
 *  7. Apply confidence threshold
 *  8. Hard rule override: GoPlus malicious ALWAYS wins over LLM
 *  9. Return structured FinalDecision
 *
 * HARD GUARANTEES:
 * - GoPlus malicious → REJECT regardless of LLM output
 * - LLM error / timeout / malformed → fail-safe REJECT
 * - LLM low confidence → fail-safe REJECT
 * - API unavailable ≠ clean (berlaku juga untuk kegagalan tool)
 * - Maksimal 2 LLM call per keputusan (putaran ke-2 = final, needsData dipaksa [])
 * - Tool HANYA menambah bukti; tool tidak pernah menentukan eligible/confidence
 *
 * @param sender      EVM address pengirim escrow (0x...)
 * @param recipient   EVM address penerima (0x...)
 * @param amountBNB   Transfer amount in BNB (as number)
 */
export async function runSecurityPipeline(
  sender: string,
  recipient: string,
  amountBNB: number
): Promise<FinalDecision> {

  console.log(`\n[Security] ─────────────────────────────────────────────`);
  console.log(`[Security] Checking recipient: ${recipient}`);
  console.log(`[Security] Sender: ${sender}`);
  console.log(`[Security] Amount: ${amountBNB} BNB`);

  // ── Step 1: Validate EVM address ──────────────────────────────────────────
  if (!isAddress(recipient)) {
    console.warn(`[Security] REJECT — invalid EVM address: ${recipient}`);
    return failSafe(
      `Format alamat EVM tidak valid: ${recipient}`,
      "FAIL_INVALID_ADDRESS"
    );
  }

  // ── Step 2: Query GoPlus + BscScan in parallel ────────────────────────────
  console.log(`[Security] Querying GoPlus + BscScan in parallel...`);

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

  // ── Step 3: Run rule engine ───────────────────────────────────────────────
  const ruleResult = runRules(security, intel, amountBNB);
  console.log(`[Rules]   decision=${ruleResult.decision} rule=${ruleResult.triggeredRule}`);

  // ── Step 4: Hard REJECT from rules → generate AI explanation, then stop ────
  if (ruleResult.decision === "REJECT") {
    console.log(`[Final]   TOLAK (hard rule — ${ruleResult.triggeredRule})`);
    console.log(`[LLM]     Generating AI explanation for hard rule rejection...`);

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

  // ── Step 6: Call LLM (with memory context) ────────────────────────────────
  console.log(`[LLM]     Calling ${config.OLLAMA_MODEL} via Ollama (with memory context)...`);

  let llmDecision: LLMDecision;
  try {
    llmDecision = await callLLM({ sender, recipient, amountBNB, security, intel, memoryContext });
    console.log(
      `[LLM]     eligible=${llmDecision.eligible} ` +
      `confidence=${llmDecision.confidence.toFixed(2)} ` +
      `riskLevel=${llmDecision.riskLevel}`
    );
    console.log(`[LLM]     Reason: ${llmDecision.reason}`);
  } catch (err) {
    // ── LLM failure → fail-safe REJECT ──────────────────────────────────────
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[LLM]     ERROR: ${msg}`);
    console.log(`[Final]   REJECT (fail-safe — LLM unavailable/error)`);
    return failSafe(
      `Analisis LLM gagal (${msg}). Dana dikembalikan ke pengirim sebagai tindakan fail-safe.`,
      "FAIL_LLM_ERROR",
      security,
      intel
    );
  }

  // ── Step 6b: Agentic tool loop (maksimal 1 putaran) ───────────────────────
  // LLM menilai bukti belum cukup → meminta data sendiri lewat needsData.
  // Tool dieksekusi murni oleh kode (0 beban Ollama), lalu LLM dipanggil
  // SEKALI LAGI dengan bukti tambahan. Putaran ke-2 adalah FINAL:
  // needsData hasil putaran ke-2 dipaksa [] — total LLM call maksimal 2.
  let toolsUsed: string[] = [];

  if (llmDecision.needsData.length > 0) {
    const requested = llmDecision.needsData.filter((n) => TOOL_NAMES.has(n));
    const dropped = llmDecision.needsData.filter((n) => !TOOL_NAMES.has(n));

    if (dropped.length > 0) {
      console.warn(`[Agent]   Tool tidak dikenal diabaikan: ${dropped.join(", ")}`);
    }

    if (requested.length > 0) {
      console.log(`[Agent]   AI meminta data tambahan: ${requested.join(", ")}`);

      const exec = await executeTools(requested, { sender, recipient });
      console.log(
        `[Agent]   Tool selesai: ${exec.succeeded.length} sukses, ` +
        `${exec.failed.length} gagal` +
        (exec.failed.length > 0 ? ` (${exec.failed.join(", ")})` : "")
      );

      if (exec.succeeded.length > 0) {
        console.log(`[Agent]   Putaran ke-2 LLM dengan data tambahan (keputusan final)...`);
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
          // Putaran ke-2 FINAL — paksakan needsData=[] (tanpa putaran ke-3).
          llmDecision = { ...followUp, needsData: [] };
          toolsUsed = exec.succeeded;
          console.log(
            `[Agent]   Keputusan final: eligible=${llmDecision.eligible} ` +
            `confidence=${llmDecision.confidence.toFixed(2)}`
          );
          console.log(`[LLM]     Reason: ${llmDecision.reason}`);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.warn(`[Agent]   Putaran ke-2 gagal (${msg}) — memakai keputusan putaran ke-1.`);
        }
      } else {
        console.warn(`[Agent]   Semua tool gagal — memakai keputusan putaran ke-1.`);
      }
    }
  }

  // ── Step 7: Apply confidence threshold ───────────────────────────────────
  if (llmDecision.confidence < config.LLM_CONFIDENCE_THRESHOLD) {
    console.log(
      `[Final]   REJECT (fail-safe — LLM confidence ${llmDecision.confidence.toFixed(2)} < threshold ${config.LLM_CONFIDENCE_THRESHOLD})`
    );
    return failSafe(
      `LLM confidence (${(llmDecision.confidence * 100).toFixed(0)}%) di bawah ` +
      `batas yang dipersyaratkan (${(config.LLM_CONFIDENCE_THRESHOLD * 100).toFixed(0)}%). ` +
      `Dana dikembalikan ke pengirim sebagai tindakan fail-safe. Analisis LLM: ${llmDecision.reason}`,
      "FAIL_LOW_CONFIDENCE",
      security,
      intel
    );
  }

  // ── Step 8: Hard override check ───────────────────────────────────────────
  // GoPlus malicious ALWAYS wins. LLM cannot override security intelligence.
  if (security.status === "malicious") {
    console.log(
      `[Final]   REJECT (hard override — GoPlus malicious overrides LLM eligible=${llmDecision.eligible})`
    );
    const overrideExplanation = await generateHardRuleExplanation({
      recipient,
      amountBNB,
      security,
      intel,
      triggeredRule: "OVERRIDE_GOPLUS_MALICIOUS",
      ruleContext: `GoPlus mendeteksi sinyal berbahaya [${security.riskFlags.join(", ")}] pada alamat ini. Hard security rule mengalahkan keputusan LLM.`,
    });
    return {
      eligible: false,
      confidence: 1.0,
      riskLevel: "CRITICAL",
      reason: overrideExplanation,
      decidedBy: "hard_rule",
      triggeredRule: "OVERRIDE_GOPLUS_MALICIOUS",
      toolsUsed,
      evidence: { security, intel },
    };
  }

  // ── Step 9: Accept LLM decision ───────────────────────────────────────────
  const outcome = llmDecision.eligible ? "RELEASE" : "REJECT";
  console.log(
    `[Final]   ${outcome} (LLM — confidence=${llmDecision.confidence.toFixed(2)} risk=${llmDecision.riskLevel})`
  );

  return {
    eligible: llmDecision.eligible,
    confidence: llmDecision.confidence,
    riskLevel: llmDecision.riskLevel,
    reason: llmDecision.reason,
    decidedBy: "llm",
    toolsUsed,
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

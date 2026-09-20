import { config } from "./config.js";
import type { SecurityCheckResult } from "./goplusChecker.js";
import type { OnChainIntel } from "./bscscanChecker.js";

// ── Types ─────────────────────────────────────────────────────────────────────
export interface HardRuleResult {
  /**
   * REJECT    – clear malicious signal found; stop pipeline, no LLM.
   * NEEDS_LLM – ambiguous or insufficient data; forward to LLM.
   *
   * NOTE: Rule engine NEVER produces APPROVE.
   * APPROVE is exclusively produced by LLM + confidence threshold.
   */
  decision: "REJECT" | "NEEDS_LLM";
  reason: string;
  triggeredRule: string;
}

// ── Rule Engine ───────────────────────────────────────────────────────────────
/**
 * Deterministic, explainable rule engine.
 * Purpose: handle clearly malicious cases WITHOUT calling LLM,
 * and act as an independent security guardrail that LLM cannot override.
 *
 * Priority (high → low):
 *   Rule 1: GoPlus malicious signal         → REJECT
 *   Rule 2: New wallet + low-tx + sig.amount → REJECT
 *   Rule 3: New wallet + low-tx (small amt)  → NEEDS_LLM (escalate, not reject)
 *   Rule 4: Any other case                   → NEEDS_LLM
 */
export function runRules(
  security: SecurityCheckResult,
  intel: OnChainIntel,
  amountBNB: number
): HardRuleResult {

  // ── Rule 1: GoPlus hard malicious signal ─────────────────────────────────
  // This rule is the PRIMARY hard rule. It can never be overridden by LLM.
  if (security.status === "malicious" && security.riskFlags.length > 0) {
    const flagList = security.riskFlags.join(", ");
    return {
      decision: "REJECT",
      reason: `Alamat ini terdeteksi berbahaya oleh GoPlus Security Intelligence. Flag yang ditemukan: ${flagList}.`,
      triggeredRule: "RULE_1_GOPLUS_MALICIOUS",
    };
  }

  // ── Rule 1b: GoPlus malicious but no specific flags (edge case) ───────────
  if (security.status === "malicious") {
    return {
      decision: "REJECT",
      reason: "Alamat ini terdeteksi berbahaya oleh GoPlus Security Intelligence.",
      triggeredRule: "RULE_1B_GOPLUS_MALICIOUS_NO_FLAGS",
    };
  }

  // ── Rule 2: New wallet + very low activity + significant transfer → REJECT ─
  // Rationale: combination of all three factors indicates high-risk scenario.
  // No single factor alone is sufficient.
  // Thresholds are configurable MVP parameters (see .env.example).
  const isNewWallet = intel.isNewWallet;
  const txCount = intel.txCount ?? 0;
  const isLowActivity = txCount <= config.LOW_TX_COUNT_THRESHOLD;
  const isSignificantAmount = amountBNB >= config.SIGNIFICANT_TRANSFER_BNB;

  if (isNewWallet && isLowActivity && isSignificantAmount) {
    return {
      decision: "REJECT",
      reason: [
        `Wallet sangat baru (umur: ${formatAge(intel.walletAgeInDays)},`,
        `batas: < ${config.NEW_WALLET_DAYS} hari),`,
        `aktivitas on-chain sangat rendah (${txCount} transaksi,`,
        `batas: ≤ ${config.LOW_TX_COUNT_THRESHOLD}),`,
        `dan menerima transfer dalam jumlah cukup besar sebesar ${amountBNB} BNB`,
        `(batas: ≥ ${config.SIGNIFICANT_TRANSFER_BNB} BNB).`,
        `Kombinasi ini menunjukkan profil risiko tinggi.`,
      ].join(" "),
      triggeredRule: "RULE_2_NEW_WALLET_SIGNIFICANT_AMOUNT",
    };
  }

  // ── Rule 3: New wallet + low activity, but small amount → escalate to LLM ─
  // We don't REJECT because amount is small, but still needs LLM reasoning.
  if (isNewWallet && isLowActivity) {
    return {
      decision: "NEEDS_LLM",
      reason: [
        `Wallet baru (umur: ${formatAge(intel.walletAgeInDays)})`,
        `dengan aktivitas on-chain rendah (${txCount} transaksi).`,
        `Jumlah transfer di bawah batas signifikan (${amountBNB} BNB < ${config.SIGNIFICANT_TRANSFER_BNB} BNB).`,
        `Diteruskan ke LLM untuk penilaian kontekstual.`,
      ].join(" "),
      triggeredRule: "RULE_3_NEW_WALLET_SMALL_AMOUNT",
    };
  }

  // ── Rule 4: GoPlus unavailable → escalate, do not APPROVE ────────────────
  // API unavailable ≠ clean. We forward to LLM with explicit unavailability context.
  if (security.status === "unavailable") {
    return {
      decision: "NEEDS_LLM",
      reason:
        "Layanan keamanan GoPlus sedang tidak tersedia. " +
        "Status keamanan tidak dapat dikonfirmasi. Diteruskan ke LLM dengan informasi ketidaktersediaan ini.",
      triggeredRule: "RULE_4_GOPLUS_UNAVAILABLE",
    };
  }

  // ── Rule 5: BscScan fully unavailable ────────────────────────────────────
  if (intel.unavailable) {
    return {
      decision: "NEEDS_LLM",
      reason:
        "Layanan on-chain BscScan sedang tidak tersedia. " +
        "Data on-chain tidak dapat diverifikasi. Diteruskan ke LLM.",
      triggeredRule: "RULE_5_BSCSCAN_UNAVAILABLE",
    };
  }

  // ── Default: all other cases → NEEDS_LLM ─────────────────────────────────
  // IMPORTANT: We never produce APPROVE from rule engine.
  // Only LLM + confidence threshold can produce APPROVE.
  return {
    decision: "NEEDS_LLM",
    reason:
      "No deterministic rejection criteria met. Forwarding to LLM for contextual risk reasoning.",
    triggeredRule: "RULE_DEFAULT",
  };
}

function formatAge(days: number | null): string {
  if (days === null) return "unknown";
  if (days < 1) return `${Math.round(days * 24)}h`;
  return `${days.toFixed(1)}d`;
}

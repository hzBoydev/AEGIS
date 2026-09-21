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
 * Priority (high -> low):
 *   Rule 1:   GoPlus malicious signal + flags          -> REJECT
 *   Rule 1b:  GoPlus malicious (no flags)              -> REJECT
 *   Rule 2:   New wallet + low-tx + sig. amount        -> REJECT
 *   Rule 3:   New wallet + low-tx (small amount)       -> NEEDS_LLM
 *   Rule 4:   GoPlus unavailable                       -> NEEDS_LLM
 *   Rule 5:   BscScan unavailable                      -> NEEDS_LLM
 *   Rule 6:   Smart contract receiver                  -> REJECT
 *   Rule 7:   Zero-balance wallet + significant amount -> REJECT
 *   Rule 8:   GoPlus explicit phishing/drainer flags   -> REJECT
 *   Rule 9:   Very large transfer (any wallet)         -> NEEDS_LLM
 *   Rule 10:  Medium-age wallet + low-activity + sig.  -> NEEDS_LLM
 *   Default:  All other cases                          -> NEEDS_LLM
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

  // ── Rule 8: GoPlus explicit phishing / drainer flags (from rawData) ───────
  // Checked BEFORE on-chain rules so explicit GoPlus labels are always caught.
  // rawData fields: phishing_activities, honeypot_related_address,
  //                 stealing_attack, fake_token_attack.
  if (security.rawData) {
    const raw = security.rawData as Record<string, unknown>;
    const phishingFlags: string[] = [];
    if (raw["phishing_activities"] === "1") phishingFlags.push("phishing_activities");
    if (raw["honeypot_related_address"] === "1") phishingFlags.push("honeypot_related_address");
    if (raw["stealing_attack"] === "1") phishingFlags.push("stealing_attack");
    if (raw["fake_token_attack"] === "1") phishingFlags.push("fake_token_attack");

    if (phishingFlags.length > 0) {
      return {
        decision: "REJECT",
        reason: `Alamat ini memiliki label aktivitas berbahaya eksplisit dari GoPlus: ${phishingFlags.join(", ")}. Transfer dibatalkan.`,
        triggeredRule: "RULE_8_GOPLUS_PHISHING_FLAGS",
      };
    }
  }

  // ── Rule 6: Smart contract receiver ──────────────────────────────────────
  // Transfer BNB langsung ke contract address sangat jarang untuk use case
  // normal. Bisa jadi contract jebakan (honeypot), drainer, atau scam contract.
  if (intel.isContract) {
    return {
      decision: "REJECT",
      reason:
        "Alamat tujuan adalah smart contract, bukan wallet EOA. " +
        "Transfer BNB langsung ke contract tidak lazim dan berisiko tinggi " +
        "(potensi honeypot, drainer, atau scam contract).",
      triggeredRule: "RULE_6_CONTRACT_RECEIVER",
    };
  }

  // ── Rule 7: Zero-balance wallet + significant amount → REJECT ─────────────
  // Wallet dengan saldo 0 BNB yang langsung menerima transfer signifikan
  // merupakan indikator dompet baru yang dibuat spesifik untuk fraud/scam.
  // Berbeda dengan Rule 2 (fokus umur); Rule 7 fokus pada saldo nol.
  const isSignificantAmount = amountBNB >= config.SIGNIFICANT_TRANSFER_BNB;
  if (intel.balanceBNB !== null && intel.balanceBNB === 0 && isSignificantAmount) {
    return {
      decision: "REJECT",
      reason: [
        `Wallet tujuan memiliki saldo 0 BNB`,
        `dan akan menerima transfer sebesar ${amountBNB} BNB`,
        `(batas signifikan: >= ${config.SIGNIFICANT_TRANSFER_BNB} BNB).`,
        `Wallet berisi nol yang langsung menerima transfer besar adalah`,
        `indikator kuat dompet baru yang disiapkan untuk fraud.`,
      ].join(" "),
      triggeredRule: "RULE_7_ZERO_BALANCE_SIGNIFICANT_AMOUNT",
    };
  }

  // ── Rule 2: New wallet + very low activity + significant transfer → REJECT ─
  // Rationale: combination of all three factors indicates high-risk scenario.
  // No single factor alone is sufficient.
  // Thresholds are configurable MVP parameters (see .env.example).
  const isNewWallet = intel.isNewWallet;
  const txCount = intel.txCount ?? 0;
  const isLowActivity = txCount <= config.LOW_TX_COUNT_THRESHOLD;

  if (isNewWallet && isLowActivity && isSignificantAmount) {
    return {
      decision: "REJECT",
      reason: [
        `Wallet sangat baru (umur: ${formatAge(intel.walletAgeInDays)},`,
        `batas: < ${config.NEW_WALLET_DAYS} hari),`,
        `aktivitas on-chain sangat rendah (${txCount} transaksi,`,
        `batas: <= ${config.LOW_TX_COUNT_THRESHOLD}),`,
        `dan menerima transfer dalam jumlah cukup besar sebesar ${amountBNB} BNB`,
        `(batas: >= ${config.SIGNIFICANT_TRANSFER_BNB} BNB).`,
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
  // API unavailable != clean. We forward to LLM with explicit unavailability context.
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

  // ── Rule 9: Very large transfer (any wallet) → escalate to LLM ───────────
  // Bahkan ke wallet "bersih" sekalipun, transfer sangat besar perlu validasi
  // kontekstual dari LLM. Threshold dikonfigurasi via VERY_LARGE_TRANSFER_BNB.
  if (amountBNB >= config.VERY_LARGE_TRANSFER_BNB) {
    return {
      decision: "NEEDS_LLM",
      reason: [
        `Transfer sebesar ${amountBNB} BNB melampaui batas transfer sangat besar`,
        `(${config.VERY_LARGE_TRANSFER_BNB} BNB).`,
        `Meskipun tidak ada sinyal berbahaya eksplisit, jumlah ini memerlukan`,
        `validasi kontekstual tambahan dari LLM.`,
      ].join(" "),
      triggeredRule: "RULE_9_VERY_LARGE_TRANSFER",
    };
  }

  // ── Rule 10: Medium-age wallet + low activity + significant amount → LLM ──
  // Wallet berumur antara NEW_WALLET_DAYS dan MEDIUM_WALLET_DAYS dengan
  // transaksi sedikit tetap suspicious meskipun tidak cukup untuk hard REJECT.
  const walletAge = intel.walletAgeInDays;
  const isMediumAgeWallet =
    walletAge !== null &&
    walletAge >= config.NEW_WALLET_DAYS &&
    walletAge < config.MEDIUM_WALLET_DAYS;
  const isMediumLowActivity = txCount <= config.MEDIUM_TX_THRESHOLD;

  if (isMediumAgeWallet && isMediumLowActivity && isSignificantAmount) {
    return {
      decision: "NEEDS_LLM",
      reason: [
        `Wallet berumur ${formatAge(walletAge)} (kategori menengah:`,
        `${config.NEW_WALLET_DAYS}–${config.MEDIUM_WALLET_DAYS} hari)`,
        `dengan aktivitas rendah (${txCount} transaksi, batas <= ${config.MEDIUM_TX_THRESHOLD})`,
        `dan menerima transfer ${amountBNB} BNB (>= ${config.SIGNIFICANT_TRANSFER_BNB} BNB).`,
        `Profil semi-baru dengan aktivitas minimal memerlukan evaluasi LLM.`,
      ].join(" "),
      triggeredRule: "RULE_10_MEDIUM_WALLET_LOW_ACTIVITY",
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

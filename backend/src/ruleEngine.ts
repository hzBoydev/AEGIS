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

/**
 * Description of the transaction count that is HONEST about its source.
 * The RPC nonce only counts outgoing transactions — describing it as
 * "N on-chain transactions" is misleading for receive-only accounts.
 */
function describeActivity(intel: OnChainIntel, txCount: number): string {
  if (intel.txCount === null) return "transaction count unknown";
  if (intel.txCountSource === "rpc_nonce") {
    return `${txCount} outgoing transactions (nonce; incoming transactions not counted)`;
  }
  return `${txCount} transactions (explorer)`;
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
      reason: `This address was flagged as malicious by GoPlus Security Intelligence. Flags found: ${flagList}.`,
      triggeredRule: "RULE_1_GOPLUS_MALICIOUS",
    };
  }

  // ── Rule 1b: GoPlus malicious but no specific flags (edge case) ───────────
  if (security.status === "malicious") {
    return {
      decision: "REJECT",
      reason: "This address was flagged as malicious by GoPlus Security Intelligence.",
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
        reason: `This address carries explicit malicious activity labels from GoPlus: ${phishingFlags.join(", ")}. The transfer is cancelled.`,
        triggeredRule: "RULE_8_GOPLUS_PHISHING_FLAGS",
      };
    }
  }

  // ── Rule 6: Smart contract receiver ──────────────────────────────────────
  // Sending BNB directly to a contract address is extremely rare for a normal
  // use case. It could be a honeypot contract, a drainer, or a scam contract.
  if (intel.isContract) {
    return {
      decision: "REJECT",
      reason:
        "The destination address is a smart contract, not an EOA wallet. " +
        "A direct BNB transfer to a contract is unusual and highly risky " +
        "(potential honeypot, drainer, or scam contract).",
      triggeredRule: "RULE_6_CONTRACT_RECEIVER",
    };
  }

  // ── Rule 7: Zero-balance wallet + significant amount → REJECT ─────────────
  // A wallet with a 0 BNB balance that directly receives a significant transfer
  // is an indicator of a wallet created specifically for fraud/scam.
  // Unlike Rule 2 (which focuses on age); Rule 7 focuses on a zero balance.
  const isSignificantAmount = amountBNB >= config.SIGNIFICANT_TRANSFER_BNB;
  if (intel.balanceBNB !== null && intel.balanceBNB === 0 && isSignificantAmount) {
    return {
      decision: "REJECT",
      reason: [
        `The destination wallet has a balance of 0 BNB`,
        `and is about to receive a transfer of ${amountBNB} BNB`,
        `(significant threshold: >= ${config.SIGNIFICANT_TRANSFER_BNB} BNB).`,
        `An empty wallet directly receiving a large transfer is a`,
        `strong indicator of a new wallet prepared for fraud.`,
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
        `Very new wallet (age: ${formatAge(intel.walletAgeInDays)},`,
        `threshold: < ${config.NEW_WALLET_DAYS} days),`,
        `very low recorded activity (${describeActivity(intel, txCount)},`,
        `threshold: <= ${config.LOW_TX_COUNT_THRESHOLD}),`,
        `receiving a fairly large transfer of ${amountBNB} BNB`,
        `(threshold: >= ${config.SIGNIFICANT_TRANSFER_BNB} BNB).`,
        `This combination indicates a high-risk profile.`,
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
        `New wallet (age: ${formatAge(intel.walletAgeInDays)})`,
        `with low recorded activity (${describeActivity(intel, txCount)}).`,
        `The transfer amount is below the significant threshold (${amountBNB} BNB < ${config.SIGNIFICANT_TRANSFER_BNB} BNB).`,
        `Forwarded to the LLM for contextual assessment.`,
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
        "The GoPlus security service is currently unavailable. " +
        "The security status could not be confirmed. Forwarded to the LLM with this unavailability information.",
      triggeredRule: "RULE_4_GOPLUS_UNAVAILABLE",
    };
  }

  // ── Rule 5: BscScan fully unavailable ────────────────────────────────────
  if (intel.unavailable) {
    return {
      decision: "NEEDS_LLM",
      reason:
        "The BscScan on-chain service is currently unavailable. " +
        "The on-chain data could not be verified. Forwarded to the LLM.",
      triggeredRule: "RULE_5_BSCSCAN_UNAVAILABLE",
    };
  }

  // ── Rule 9: Very large transfer (any wallet) → escalate to LLM ───────────
  // Even for a "clean" wallet, a very large transfer needs contextual
  // validation from the LLM. Threshold configured via VERY_LARGE_TRANSFER_BNB.
  if (amountBNB >= config.VERY_LARGE_TRANSFER_BNB) {
    return {
      decision: "NEEDS_LLM",
      reason: [
        `A transfer of ${amountBNB} BNB exceeds the very large transfer threshold`,
        `(${config.VERY_LARGE_TRANSFER_BNB} BNB).`,
        `Although there is no explicit malicious signal, this amount requires`,
        `additional contextual validation from the LLM.`,
      ].join(" "),
      triggeredRule: "RULE_9_VERY_LARGE_TRANSFER",
    };
  }

  // ── Rule 10: Medium-age wallet + low activity + significant amount → LLM ──
  // A wallet aged between NEW_WALLET_DAYS and MEDIUM_WALLET_DAYS with few
  // transactions stays suspicious even though it is not enough for a hard REJECT.
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
        `Wallet aged ${formatAge(walletAge)} (medium category:`,
        `${config.NEW_WALLET_DAYS}–${config.MEDIUM_WALLET_DAYS} days)`,
        `with low recorded activity (${describeActivity(intel, txCount)}, threshold <= ${config.MEDIUM_TX_THRESHOLD})`,
        `and receiving a transfer of ${amountBNB} BNB (>= ${config.SIGNIFICANT_TRANSFER_BNB} BNB).`,
        `A semi-new profile with minimal activity requires an LLM evaluation.`,
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

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
 * Every branch below runs on a field that is actually populated on BSC Testnet.
 * There is NO branch on `walletAgeInDays`: that field needs an indexer, the
 * BSC testnet explorer is deprecated, and a previous version of this engine
 * silently substituted the outgoing nonce for it — which mislabelled ordinary
 * receive-only wallets as brand new and hard-rejected them.
 *
 * Priority (high -> low):
 *   Rule 1:   GoPlus malicious signal + flags          -> REJECT
 *   Rule 1b:  GoPlus malicious (no flags)              -> REJECT
 *   Rule 8:   GoPlus explicit phishing/drainer labels  -> REJECT
 *   Rule 6:   Smart contract receiver                  -> REJECT
 *   Rule 2:   Brand-new empty account + significant amt -> REJECT
 *   Rule 7:   Zero-balance wallet + significant amount  -> REJECT
 *   Rule 3:   Brand-new account, small amount           -> NEEDS_LLM
 *   Rule 4:   GoPlus unavailable                        -> NEEDS_LLM
 *   Rule 5:   All on-chain intel unavailable            -> NEEDS_LLM
 *   Rule 9:   Very large transfer (any wallet)          -> NEEDS_LLM
 *   Rule 10:  Pooling hub (many on-chain senders) + significant amount -> NEEDS_LLM
 *   Default:  All other cases                           -> NEEDS_LLM
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

  // ── Rule 8: GoPlus explicit phishing / drainer labels (from rawData) ───────
  // Defence in depth: Rule 1 already rejects on any extracted flag, so this rule
  // only adds value if a label is present in rawData but was NOT in MALICIOUS_FLAGS.
  // It therefore reports the label it actually found instead of re-listing the
  // generic flag set.
  //
  // Field names below are the real GoPlus keys (verified against live responses);
  // the previous `fake_token_attack` key does not exist in the GoPlus schema.
  if (security.rawData) {
    const raw = security.rawData as Record<string, unknown>;
    const phishingLabels: string[] = [];
    for (const label of [
      "phishing_activities",
      "honeypot_related_address",
      "stealing_attack",
      "fake_token",
      "number_of_malicious_contracts_created",
      "reinit",
    ]) {
      if (raw[label] === "1" || raw[label] === 1) phishingLabels.push(label);
    }

    if (phishingLabels.length > 0) {
      return {
        decision: "REJECT",
        reason: `This address carries explicit malicious activity labels from GoPlus: ${phishingLabels.join(", ")}. The transfer is cancelled.`,
        triggeredRule: "RULE_8_GOPLUS_PHISHING_FLAGS",
      };
    }
  }

  // ── Rule 6: Smart contract receiver ──────────────────────────────────────
  // Sending BNB directly to a contract address is extremely rare for a normal
  // use case. It could be a honeypot contract, a drainer, or a scam contract.
  //
  // An EIP-7702 delegation is NOT a contract: it is an EOA that points its code
  // at a delegate contract (see classifyCode). Without that carve-out this rule
  // hard-REJECTED ordinary wallets — on BSC testnet every standard Hardhat
  // account reports a delegation designator.
  if (intel.isContract && !intel.eip7702Delegated) {
    return {
      decision: "REJECT",
      reason:
        "The destination address is a smart contract, not an EOA wallet. " +
        "A direct BNB transfer to a contract is unusual and highly risky " +
        "(potential honeypot, drainer, or scam contract).",
      triggeredRule: "RULE_6_CONTRACT_RECEIVER",
    };
  }

  const isSignificantAmount = amountBNB >= config.SIGNIFICANT_TRANSFER_BNB;

  // ── Rule 2: Brand-new empty account + significant transfer → REJECT ────────
  // Rebuilt on REAL data. The previous version branched on `isNewWallet`, which
  // was derived from the outgoing nonce (`nonce === 0`) because the explorer that
  // supplies real wallet age is dead on chain 97. That mislabelled every
  // receive-only wallet as brand new and hard-rejected ordinary users.
  //
  // The new condition requires all three facts to be positively observed:
  //   - the account has never SENT a transaction (nonce 0, a real RPC fact),
  //   - it holds zero BNB (real RPC fact),
  //   - it has never appeared in the AEGIS vault (real eth_getLogs result).
  // Any "unknown" degrades to the LLM instead of a hard REJECT.
  const txCount = intel.txCount;
  const isNovel = intel.isNovelAccount;

  if (isNovel && isSignificantAmount) {
    return {
      decision: "REJECT",
      reason: [
        `The destination account shows no history on any available source:`,
        `it has never sent an outgoing transaction (nonce 0),`,
        `its balance is 0 BNB, and it has never appeared in the AEGIS vault on-chain`,
        `(0 escrows found in the contract's event log).`,
        `It is about to receive ${amountBNB} BNB (threshold: >= ${config.SIGNIFICANT_TRANSFER_BNB} BNB).`,
        `Funding a completely fresh, empty account with a significant amount is`,
        `the signature of a throwaway wallet prepared to collect and disappear.`,
      ].join(" "),
      triggeredRule: "RULE_2_NOVEL_EMPTY_ACCOUNT_SIGNIFICANT_AMOUNT",
    };
  }

  // ── Rule 3: Brand-new account with a SMALL amount → LLM ───────────────────
  // Not a REJECT: the amount is small, so the LLM weighs the context.
  if (isNovel) {
    return {
      decision: "NEEDS_LLM",
      reason: [
        `The destination account is brand new: never sent an outgoing transaction`,
        `(nonce 0), balance 0 BNB, no AEGIS vault history.`,
        `The transfer amount is below the significant threshold (${amountBNB} BNB < ${config.SIGNIFICANT_TRANSFER_BNB} BNB).`,
        `Forwarded to the LLM for contextual assessment.`,
      ].join(" "),
      triggeredRule: "RULE_3_NOVEL_ACCOUNT_SMALL_AMOUNT",
    };
  }

  // ── Rule 7: Zero-balance wallet + significant amount → REJECT ─────────────
  // A wallet that holds nothing and is about to receive a significant transfer
  // is a strong collection-wallet signal. (Rule 2 above already covers the
  // strictly stronger case where such a wallet is also brand new.)
  if (intel.balanceBNB !== null && intel.balanceBNB === 0 && isSignificantAmount) {
    return {
      decision: "REJECT",
      reason: [
        `The destination wallet has a balance of 0 BNB`,
        `and is about to receive a transfer of ${amountBNB} BNB`,
        `(significant threshold: >= ${config.SIGNIFICANT_TRANSFER_BNB} BNB).`,
        `An empty wallet directly receiving a large transfer is a`,
        `strong indicator of a collection wallet prepared for fraud.`,
      ].join(" "),
      triggeredRule: "RULE_7_ZERO_BALANCE_SIGNIFICANT_AMOUNT",
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

  // ── Rule 5: all on-chain intel unavailable ────────────────────────────────
  if (intel.unavailable) {
    return {
      decision: "NEEDS_LLM",
      reason:
        "The on-chain data sources are currently unavailable. " +
        "The on-chain data could not be verified. Forwarded to the LLM.",
      triggeredRule: "RULE_5_ONCHAIN_UNAVAILABLE",
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

  // ── Rule 10: Fund-pooling hub + significant amount → LLM ──────────────────
  // The previous Rule 10 branched on `walletAgeInDays`, which is permanently
  // null on chain 97 (the explorer that supplies it is deprecated), so the rule
  // could never fire — dead code that read as protection.
  //
  // It is rebuilt on the real signal that IS available: the AegisVault event
  // log. Many distinct senders converging on one recipient is the on-chain
  // signature of a collection/pooling hub, which is worth a contextual review.
  if (
    !intel.aegisLogsUnavailable &&
    intel.aegisDistinctSenders >= config.POOLING_HUB_MIN_SENDERS &&
    isSignificantAmount
  ) {
    return {
      decision: "NEEDS_LLM",
      reason: [
        `On-chain (AegisVault event log): ${intel.aegisDistinctSenders} distinct senders`,
        `have already funded this recipient (threshold: >= ${config.POOLING_HUB_MIN_SENDERS}).`,
        `The recipient is now receiving ${amountBNB} BNB (>= ${config.SIGNIFICANT_TRANSFER_BNB} BNB).`,
        `Many-to-one funding is the signature of a collection or pooling hub,`,
        `so this needs a contextual LLM evaluation.`,
      ].join(" "),
      triggeredRule: "RULE_10_POOLING_HUB_SIGNIFICANT_AMOUNT",
    };
  }

  // ── Rule 11 (removed) ─────────────────────────────────────────────────────
  // The old Rule 10 (medium-age wallet) was deleted: it branched on
  // `walletAgeInDays`, permanently null on chain 97, so it could never fire.
  // There is deliberately no third branch on wallet age anywhere in this file.

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

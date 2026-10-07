import { config } from "./config.js";
import type { SecurityCheckResult } from "./goplusChecker.js";
import type { OnChainIntel } from "./bscscanChecker.js";
import type { AddressMemory, SenderMemory } from "./agentMemory.js";

// ── Types ─────────────────────────────────────────────────────────────────────
/**
 * Everything the rule engine is allowed to know about one transfer.
 *
 * It is an OBJECT, not three positional arguments, on purpose: the engine used to
 * take `(security, intel, amountBNB)` and silently had no access to the sender, the
 * memory or the denylist, so every rule it could express was a rule about the
 * recipient alone — which is exactly the half of a transfer where a competent
 * attacker looks clean.
 *
 * Purity is a contract, not an accident: `runRules` performs NO I/O, no network call
 * and no database read. Everything it needs is fetched by the pipeline beforehand and
 * handed over here, which is what makes the whole rule set testable with `node:test`
 * and no network, and what makes "unknown" expressible at all (`null` memory, `null`
 * counterparty list, `null` delegate check).
 */
export interface RuleInput {
  security: SecurityCheckResult;
  intel: OnChainIntel;
  amountBNB: number;
  sender: `0x${string}`;
  recipient: `0x${string}`;
  /** null = DB unavailable → treat as unknown. */
  recipientMemory: AddressMemory | null;
  /** null = DB unavailable → treat as unknown. */
  senderMemory: SenderMemory | null;
  /** Recipients this sender has paid before (AEGIS DB), lowercase. null = unknown. */
  senderCounterparties: string[] | null;
  /** GoPlus result for the EIP-7702 delegate contract, when the recipient is delegated. */
  delegateSecurity: SecurityCheckResult | null;
  /** Hit from the local denylist, or null. */
  localDenylistHit: { list: string; label: string } | null;
}

/** One NEEDS_LLM observation, handed to the Investigator so nothing is lost. */
export interface RuleSignal {
  rule: string;
  severity: "high" | "medium" | "info";
  reason: string;
}

export interface HardRuleResult {
  /**
   * REJECT    – a positively observed fact (a flag, an exact address match, a
   *             confirmed malicious history); stop the pipeline, no LLM.
   * NEEDS_LLM – ambiguous, contextual or missing data; forward to the LLM.
   *
   * NOTE: Rule engine NEVER produces APPROVE.
   * APPROVE is exclusively produced by LLM + confidence threshold.
   */
  decision: "REJECT" | "NEEDS_LLM";
  reason: string;
  /** First REJECT rule, or the highest-severity NEEDS_LLM rule, or RULE_DEFAULT. */
  triggeredRule: string;
  /** Every NEEDS_LLM signal that matched, high → medium → info. Empty for REJECT. */
  signals: RuleSignal[];
}

/**
 * The rule-engine verdict as it is PERSISTED in the transcript JSON.
 *
 * Separate from {@link HardRuleResult} because the transcript must not carry the
 * human-readable `reason` blob: `reason` is re-rendered from the current thresholds on
 * every run, so storing it would make old rows describe today's thresholds. `rule` and
 * `signals` are the parts a later audit actually needs — they are what
 * `getAddressMemory` reads back to decide whether a past rejection was evidence of
 * malice.
 */
export interface RuleEngineContext {
  decision: "REJECT" | "NEEDS_LLM";
  triggeredRule: string;
  signals: RuleSignal[];
}

// ── Fund-loss addresses ───────────────────────────────────────────────────────
/**
 * Addresses where transferred native coin is destroyed, unreachable, or makes the
 * escrow meaningless. A REJECT here needs no threat intelligence at all: the funds are
 * provably not deliverable.
 *
 *  - the zero address: a burn, and the classic mis-parse of an empty field;
 *  - `0x…dEaD`: the canonical burn address, deliberately NOT a valid payable account;
 *  - `0xdead0000…069420694206942069`: a vanity burn address used by contracts that
 *    must never receive funds;
 *  - the AegisVault itself: paying the escrow contract with a plain transfer either
 *    reverts or credits nobody, so the escrow would never release;
 *  - precompiles `0x00…01`–`0x…ff`: they execute in the context of the CALLER and hold
 *    no balance, so coin sent to one is burned;
 *  - the sender itself, checked separately in the rule: a self-payment is either a
 *    mis-wired address or a way to launder a round trip through the escrow.
 *
 * NOT a fund-loss address, deliberately: `0x000…0100` and anything above `0x…00ff`.
 * A long run of leading zeros is not itself evidence — plenty of legitimate addresses
 * are vanity or counter-truncated — so the precompile range is a hard boundary
 * (`0x01..0xff`) rather than "lots of zeros".
 */
export const FUND_LOSS_ADDRESSES: readonly string[] = [
  "0x0000000000000000000000000000000000000000",
  "0x000000000000000000000000000000000000dEaD",
  "0xdead000000000000000042069420694206942069",
];

/** EIP-1809: precompiles live at 0x01..0x0ff and hold no balance. */
const PRECOMPILE_MIN = 1n;
const PRECOMPILE_MAX = 0xffn;

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

function normalize(address: string | null | undefined): string | null {
  if (typeof address !== "string") return null;
  const trimmed = address.trim().toLowerCase();
  return ADDRESS_RE.test(trimmed) ? trimmed : null;
}

/** True for 0x00..01 .. 0x00..ff (precompiles). The zero address is handled separately. */
function isPrecompile(address: string): boolean {
  let value: bigint;
  try {
    value = BigInt(address);
  } catch {
    return false;
  }
  return value >= PRECOMPILE_MIN && value <= PRECOMPILE_MAX;
}

/**
 * Which fund-loss condition this recipient matches, or null.
 *
 * Kept separate from the rule so the reason text and the classification cannot drift
 * apart — the rule and the explanation read the same answer.
 */
function fundLossKind(
  recipient: string,
  sender: string
): "zero" | "burn" | "vault" | "precompile" | "self" | null {
  const r = normalize(recipient);
  if (r === null) return null;
  const s = normalize(sender);

  if (s !== null && r === s) return "self";
  if (r === normalize(FUND_LOSS_ADDRESSES[0]!)) return "zero";
  if (FUND_LOSS_ADDRESSES.slice(1).some((a) => r === normalize(a))) return "burn";
  if (config.CONTRACT_ADDRESS && r === normalize(config.CONTRACT_ADDRESS)) return "vault";
  if (isPrecompile(r)) return "precompile";
  return null;
}

// ── Address poisoning (rule 14) ───────────────────────────────────────────────
/**
 * Is `candidate` a lookalike of `genuine`?
 *
 * A poisoned address is generated to match the part of the real address a human or an
 * explorer actually sees: the first N hex chars and the last M (wallets and block
 * explorers truncate the middle). The middle 32 hex chars are the attacker's.
 *
 * Both halves are required. Matching only the prefix is what a vanity-import or a
 * legitimate freshly-minted key would do, and matching only the suffix is a 1-in-65536
 * coincidence that would block honest users.
 */
function isPoisoningLookalike(
  candidate: string,
  genuine: string,
  prefixChars: number,
  suffixChars: number
): boolean {
  if (candidate.length !== 2 + 40 || genuine.length !== 2 + 40) return false;
  const c = candidate.toLowerCase().slice(2);
  const g = genuine.toLowerCase().slice(2);
  return (
    c.slice(0, prefixChars) === g.slice(0, prefixChars) &&
    c.slice(c.length - suffixChars) === g.slice(g.length - suffixChars)
  );
}

const SEVERITY_RANK: Record<RuleSignal["severity"], number> = {
  high: 0,
  medium: 1,
  info: 2,
};

// ── Rule Engine ───────────────────────────────────────────────────────────────
/**
 * Deterministic, explainable rule engine.
 *
 * Purpose: block the cases where a fact has ALREADY been observed — a threat-intel
 * flag, a published denylist, a confirmed malicious history, an address that steals by
 * looking like one you already paid — and hand everything contextual to the LLM.
 *
 * Two invariants hold for every rule below, and they are the reason the rules were
 * reworked rather than extended:
 *
 *   1. The engine NEVER returns APPROVE. Only the LLM plus the confidence threshold
 *      can release funds.
 *   2. UNKNOWN is not a verdict. Missing data (no memory, no delegate check, an
 *      unreachable node) never produces a REJECT and is never described as safe — it
 *      degrades to NEEDS_LLM. A REJECT always rests on a POSITIVELY OBSERVED fact, so
 *      one outage cannot block or condemn an address.
 *
 * Evaluation model:
 *   Phase A — REJECT rules, first match wins, in the order listed below.
 *   Phase B — NEEDS_LLM signals, ALL evaluated and collected, then sorted high →
 *            medium → info (stable within a severity, so the order below is the tie
 *            -break). Every signal reaches the Investigator; only the first one is
 *            reported as `triggeredRule`.
 *
 * Phase A order (the order is the policy: cheapest and most absolute first, so the
 * recorded rule ID always names the strongest reason):
 *   RULE_0  fund-loss address (zero/burn/precompile/vault/self) -> REJECT
 *           No intelligence needed: the funds provably cannot arrive.
 *   RULE_1  GoPlus malicious WITH a hard flag                -> REJECT
 *   RULE_1B GoPlus malicious, no flags listed               -> REJECT
 *   RULE_8  GoPlus phishing/drainer labels in rawData        -> REJECT (defence in depth)
 *   RULE_12 local denylist hit                              -> REJECT (works with GoPlus down)
 *   RULE_13 confirmed malicious history in AEGIS             -> REJECT
 *   RULE_14 address poisoning lookalike                     -> REJECT
 *   RULE_15 malicious EIP-7702 delegate                     -> REJECT
 *
 * Phase B signals:
 *   RULE_6  contract receiver                                -> high
 *   RULE_16 7702 delegation, delegate NOT positively cleared  -> high
 *   RULE_2  novel empty account + significant amount         -> high
 *   RULE_18 sender drain pattern (burst / repeat offender)   -> high
 *   RULE_9  very large transfer                              -> high
 *   RULE_3  novel account, small amount                      -> medium
 *   RULE_7  zero balance + significant amount (not novel)    -> medium
 *   RULE_17 GoPlus soft flags only                           -> medium
 *   RULE_4  GoPlus unavailable                               -> medium
 *   RULE_5  all on-chain intel unavailable                   -> medium
 *   RULE_10 pooling hub + significant amount                 -> medium
 *   RULE_19 recipient has prior non-confirmed rejections    -> info
 *   Default  nothing matched                                 -> RULE_DEFAULT
 *
 * Why rules 2, 6 and 7 were DOWNGRADED from REJECT to signals (they used to block
 * escrows outright):
 *   - 6 fired on any contract, but a Safe multisig, an ERC-4337 account, a DAO
 *     treasury and every deposit/payment contract legitimately receive native coin —
 *     and GoPlus reports NO contract flags, so the "evidence" was the shape alone;
 *   - 2 fired on a fresh wallet, but fresh wallets are how new users, CEX withdrawals
 *     and per-payment addresses are born — that is the normal case, not the fraud case;
 *   - 7 fired on a zero balance, but that is also just an unfunded account, and on the
 *     escrow's own timeline a wallet can be empty and still be the right payee.
 * All three are SHAPE, not EVIDENCE. They stay in the rule set because they are real
 * risk context; they lost the power to deny because they cannot support that verdict.
 *
 * Why RULE_13 (confirmed malicious history) deliberately EXCLUDES fail-safe rows:
 *   A `fail_safe` decision means "the judge could not analyse this escrow", not "this
 *   address is dangerous". Treating it as a malicious confirmation is how a single
 *   Ollama outage becomes a permanent blacklist: the first outage rejects, the memory
 *   reads "previously hit a hard rule", the next hearing is primed to reject again,
 *   and the address never recovers. Same reason LLM-only rejections and the downgraded
 *   shape rules are excluded — only a rule that positively identified the address, a
 *   GoPlus override, or a human veto may confirm malice.
 *
 * Purity: no network, no DB, no clock beyond what the caller passes in.
 */
export function runRules(input: RuleInput): HardRuleResult {
  const reject = phaseA(input);
  if (reject !== null) return reject;

  return phaseB(input);
}

// ── Phase A: REJECT ────────────────────────────────────────────────────────────
/**
 * The hard rules, in policy order. Returns the first match, or null.
 *
 * Kept as a separate function so the "first match wins" behaviour is structural: the
 * list cannot accidentally accumulate hits and it is obvious by reading it that nothing
 * after the return is reachable.
 */
function phaseA(input: RuleInput): HardRuleResult | null {
  const { security, intel, sender, recipient, recipientMemory, delegateSecurity } = input;

  // ── Rule 0: fund-loss / meaningless destination ───────────────────────────
  const fundLoss = fundLossKind(recipient, sender);
  if (fundLoss !== null) {
    const detail: Record<typeof fundLoss, string> = {
      zero:
        "The recipient is the zero address. Any native coin sent there is burned and " +
        "can never be delivered — this is what a truncated or mis-parsed address field " +
        "looks like.",
      burn:
        "The recipient is a known burn address. Funds sent to it are destroyed by design.",
      vault:
        `The recipient is the AegisVault contract itself (${config.CONTRACT_ADDRESS}). ` +
        "A plain transfer into the escrow contract credits no escrow, so the funds would " +
        "be locked until expiry and returned to the sender — the payment can never complete.",
      precompile:
        `The recipient is an EIP-1809 precompile (${recipient}). Precompiles execute in ` +
        "the caller's context and hold no balance, so coin sent to one is destroyed.",
      self:
        "The recipient is the SENDER itself. A self-payment through an escrow moves no " +
        "value to anyone: it is either a mis-wired address or a way to launder a round trip " +
        "through the escrow.",
    };
    return {
      decision: "REJECT",
      reason:
        `${detail[fundLoss]} The transfer is cancelled before the hearing — no amount makes ` +
        `this destination deliverable.`,
      triggeredRule: "RULE_0_FUND_LOSS_ADDRESS",
      signals: [],
    };
  }

  // ── Rule 1: GoPlus hard malicious signal ──────────────────────────────────
  // PRIMARY hard rule. `hardFlags` only: a SOFT flag (suspected, gas spam, mining
  // abuse) is not a theft verdict and must not block an escrow — it is rule 17.
  if (security.status === "malicious" && security.hardFlags.length > 0) {
    return {
      decision: "REJECT",
      reason: `This address was flagged as malicious by GoPlus Security Intelligence. Hard flags found: ${security.hardFlags.join(", ")}.`,
      triggeredRule: "RULE_1_GOPLUS_MALICIOUS",
      signals: [],
    };
  }

  // ── Rule 1b: GoPlus malicious but no specific flags (edge case) ───────────
  if (security.status === "malicious") {
    return {
      decision: "REJECT",
      reason: "This address was flagged as malicious by GoPlus Security Intelligence.",
      triggeredRule: "RULE_1B_GOPLUS_MALICIOUS_NO_FLAGS",
      signals: [],
    };
  }

  // ── Rule 8: GoPlus explicit phishing / drainer labels (from rawData) ───────
  // Defence in depth: rule 1 already rejects on any hard flag, so this rule only adds
  // value if a label is present in rawData but was NOT extracted into hardFlags — e.g.
  // a chain answered with a field this build does not classify. It therefore reports
  // the label it actually found instead of re-listing the generic flag set.
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
        signals: [],
      };
    }
  }

  // ── Rule 12: local denylist (GoPlus-independent) ──────────────────────────
  // This is the rule that survives an outage: it reads a local file, so a sanctioned or
  // known-drainer address is still blocked when the API is down. The hit is an exact
  // address match against a published list — an observed fact, not an inference.
  if (input.localDenylistHit !== null) {
    const hit = input.localDenylistHit;
    return {
      decision: "REJECT",
      reason: `The recipient is on the AEGIS local denylist (list: ${hit.list}). ${hit.label}. This check does not depend on GoPlus, so it holds even when external threat intelligence is unavailable.`,
      triggeredRule: "RULE_12_LOCAL_DENYLIST",
      signals: [],
    };
  }

  // ── Rule 13: confirmed malicious history in AEGIS ──────────────────────────
  // Reuse of a past verdict, so it is only as good as the memory query behind it:
  // `confirmedMaliciousRejects` counts hard rules that identify the address, the GoPlus
  // override and human vetoes — and explicitly NOT fail-safe rows, LLM-only
  // rejections, or the downgraded shape rules. See the docblock above.
  // `null` memory (DB unavailable) means unknown, so the rule does not fire.
  if (recipientMemory !== null && recipientMemory.confirmedMaliciousRejects > 0) {
    const rules = recipientMemory.confirmedMaliciousRules.length
      ? recipientMemory.confirmedMaliciousRules
      : ["unknown"];
    return {
      decision: "REJECT",
      reason: `This recipient was already confirmed malicious ${recipientMemory.confirmedMaliciousRejects} time(s) in AEGIS history (by: ${rules.join(", ")}). Those were positive identifications — a hard security rule, the GoPlus override, or a human operator — not merely an unreviewed or low-confidence escrow. The address is not re-tried.`,
      triggeredRule: "RULE_13_AEGIS_CONFIRMED_MALICIOUS",
      signals: [],
    };
  }

  // ── Rule 14: address poisoning ────────────────────────────────────────────
  // A lookalike of a counterparty this sender already paid is the "same address!"
  // deception: the attacker matches the visible head and tail and owns the middle.
  // `senderCounterparties === null` means the history is UNKNOWN, so the rule is
  // skipped rather than assumed absent.
  const counterparties = input.senderCounterparties;
  if (counterparties !== null) {
    const r = normalize(recipient);
    if (r !== null) {
      const prefixChars = config.POISONING_PREFIX_CHARS;
      const suffixChars = config.POISONING_SUFFIX_CHARS;
      for (const raw of counterparties) {
        const genuine = normalize(raw);
        if (genuine === null || genuine === r) continue; // a known payee is not a lookalike
        if (!isPoisoningLookalike(r, genuine, prefixChars, suffixChars)) continue;
        return {
          decision: "REJECT",
          reason: `Address-poisoning pattern: the recipient ${r} is NOT the address this sender has paid before, but it copies the first ${prefixChars} and last ${suffixChars} hex characters of the genuine counterparty ${genuine}. A wallet or explorer that truncates the middle shows two nearly identical addresses, so this transfer is built to be verified against the wrong one. Both addresses are shown above on purpose — compare the middle, not the edges.`,
          triggeredRule: "RULE_14_ADDRESS_POISONING",
          signals: [],
        };
      }
    }
  }

  // ── Rule 15: malicious EIP-7702 delegate ──────────────────────────────────
  // A 7702 delegation means the EOA runs someone ELSE's code on every call. A sweeper
  // delegation therefore does not steal the escrow balance — it steals the transfer at
  // the moment it lands, and the recipient's own address looks perfectly innocent in
  // every threat-intel lookup. The delegate is the address that must be screened, so
  // that is what the pipeline screens and what is named in the reason.
  //
  // A delegate found in the LOCAL DENYLIST is caught by rule 12 above (both REJECT;
  // only the attribution differs), because the pipeline folds the delegate hit into
  // the same `localDenylistHit` field.
  if (intel.eip7702Delegated && delegateSecurity?.status === "malicious") {
    const delegate = intel.delegateAddress ?? "unknown";
    return {
      decision: "REJECT",
      reason: `The recipient is an EIP-7702 account whose code is delegated to ${delegate}, and GoPlus reports that delegate as malicious (hard flags: ${delegateSecurity.hardFlags.join(", ")}). Money sent to this recipient is executed by the delegate, not by the recipient's owner, so the funds are stolen on arrival even though the recipient address itself is unremarkable.`,
      triggeredRule: "RULE_15_EIP7702_MALICIOUS_DELEGATE",
      signals: [],
    };
  }

  return null;
}

// ── Phase B: NEEDS_LLM signals ─────────────────────────────────────────────────
/**
 * Every contextual observation, collected rather than short-circuited.
 *
 * Collecting them is the point: an early `return` on the first match meant a transfer
 * that was simultaneously a contract receiver, had no on-chain data AND carried a very
 * large amount reached the Investigator knowing exactly one of those three things.
 */
function phaseB(input: RuleInput): HardRuleResult {
  const {
    security,
    intel,
    amountBNB,
    recipientMemory,
    senderMemory,
    delegateSecurity,
  } = input;
  const signals: RuleSignal[] = [];
  const isSignificantAmount = amountBNB >= config.SIGNIFICANT_TRANSFER_BNB;
  const novel = intel.isNovelAccount;

  // ── Rule 6: smart contract receiver ───────────────────────────────────────
  // Downgraded from REJECT: a contract receiving native coin is NORMAL (Safe multisig,
  // ERC-4337 account, DAO treasury, deposit/payment contract). And GoPlus returns no
  // contract flags, so there is no threat evidence here at all — only a shape. The
  // signal therefore tells the LLM explicitly that the usual contract screening is
  // absent, instead of hiding that gap behind a rejection.
  //
  // An EIP-7702 delegation is NOT a contract (see classifyCode); it is an EOA with
  // delegate code and is handled by rules 15/16.
  if (intel.isContract && !intel.eip7702Delegated) {
    signals.push({
      rule: "RULE_6_CONTRACT_RECEIVER",
      severity: "high",
      reason: `The recipient is a smart contract, not an externally owned wallet. This is NOT evidence of fraud by itself — multisig wallets (Safe), ERC-4337 smart accounts, DAO treasuries and payment/deposit contracts all legitimately receive native coin. Weigh it against the contract's actual purpose. Important limitation: GoPlus reports no flags for contract addresses, so a clean GoPlus verdict here carries LESS assurance than it does for an EOA — there is no contract-specific screening behind this "clean".`,
    });
  }

  // ── Rule 16: EIP-7702 delegation with an uncleared delegate ───────────────
  // 7702 delegations are ordinary on a modern chain (every standard Hardhat account
  // has one), so the delegation itself is not a signal. What matters is whether the
  // DELEGATE was screened: a sweeper delegation is invisible to every lookup on the
  // EOA, so "we could not check the delegate" has to be visible rather than assumed
  // benign. A delegate positively cleared (clean, full coverage, not on the denylist)
  // produces no signal.
  if (intel.eip7702Delegated) {
    const delegate = intel.delegateAddress;
    const delegateCleared =
      delegateSecurity !== null &&
      delegateSecurity.status === "clean" &&
      delegateSecurity.hardFlags.length === 0 &&
      delegateSecurity.softFlags.length === 0 &&
      (delegateSecurity.failedChains?.length ?? 0) === 0;
    if (!delegateCleared && delegateSecurity?.status !== "malicious") {
      const failedChains = delegateSecurity?.failedChains ?? [];
      const why =
        delegateSecurity === null
          ? "the delegate could not be checked at all"
          : delegateSecurity.status === "unavailable"
            ? "GoPlus was unavailable for the delegate"
            : failedChains.length > 0
              ? `GoPlus could only reach chain(s) ${failedChains.join(", ")} for the delegate`
              : "the delegate returned an inconclusive verdict";
      signals.push({
        rule: "RULE_16_EIP7702_UNKNOWN_DELEGATE",
        severity: "high",
        reason: `The recipient is an EIP-7702 account: its code executes from the delegate contract ${delegate ?? "(delegate address unavailable)"}, not from the recipient's own code. That delegation is a normal mechanism, but a sweeper delegation silently forwards anything the account receives, and the recipient's own address stays clean in every threat-intelligence lookup. ${why}, so the delegate ${delegate ?? "is unknown"} remains unverified. If the transfer goes ahead, this is the component to think hardest about.`,
      });
    }
  }

  // ── Rule 2: brand-new empty account + significant transfer ─────────────────
  // Downgraded from REJECT: "no outgoing transaction, zero balance, no AEGIS history"
  // is also the profile of every brand-new user, every CEX withdrawal address and
  // every per-payment address. It is real context (a throwaway wallet collects and
  // disappears), so it stays a high-severity signal, but it cannot deny on its own.
  //
  // All three facts are positively observed RPC/chain facts — `novel` is never
  // inferred from a missing data source, so an unreachable node cannot reach here.
  if (novel && isSignificantAmount) {
    signals.push({
      rule: "RULE_2_NOVEL_EMPTY_ACCOUNT_SIGNIFICANT_AMOUNT",
      severity: "high",
      reason: `The destination account is brand new on every available source: it has never sent an outgoing transaction (nonce 0), it holds 0 BNB, and it has never appeared in the AEGIS vault on-chain (0 escrows in the contract's event log). It is about to receive ${amountBNB} BNB (threshold: >= ${config.SIGNIFICANT_TRANSFER_BNB} BNB). A throwaway wallet funded with a significant amount is a real fraud pattern — but so is a new user, a fresh exchange withdrawal address and a per-payment address, so this is context, not a verdict.`,
    });
  }

  // ── Rule 3: brand-new account, SMALL amount ───────────────────────────────
  if (novel) {
    signals.push({
      rule: "RULE_3_NOVEL_ACCOUNT_SMALL_AMOUNT",
      severity: "medium",
      reason: `The destination account is brand new (nonce 0, balance 0 BNB, no AEGIS vault history), but the transfer amount (${amountBNB} BNB) is below the significant threshold (${config.SIGNIFICANT_TRANSFER_BNB} BNB), so there is little at stake even if the wallet turns out to be disposable.`,
    });
  }

  // ── Rule 7: zero-balance wallet + significant amount ──────────────────────
  // Downgraded from REJECT: an unfunded account is the normal state of most wallets.
  // Rule 2 already covers the strictly stronger case (zero balance AND brand new).
  if (
    intel.balanceBNB !== null &&
    intel.balanceBNB === 0 &&
    isSignificantAmount &&
    !novel
  ) {
    signals.push({
      rule: "RULE_7_ZERO_BALANCE_SIGNIFICANT_AMOUNT",
      severity: "medium",
      reason: `The destination wallet currently holds 0 BNB and is about to receive ${amountBNB} BNB (significant threshold: >= ${config.SIGNIFICANT_TRANSFER_BNB} BNB). An empty account receiving a large transfer is consistent with a collection wallet prepared for fraud, and equally with a wallet that simply spends everything it receives. Check whether the account has any other activity before treating this as decisive.`,
    });
  }

  // ── Rule 17: GoPlus soft flags only ───────────────────────────────────────
  // `blacklist_doubt` is GoPlus saying "suspected, unconfirmed"; `gas_abuse` and
  // `malicious_mining_activities` are spam and mining abuse. None of them is a theft
  // finding, so none of them may block an escrow — but they are exactly the kind of
  // detail a human reviewer wants to see, so they are surfaced with the flag names.
  if (security.softFlags.length > 0) {
    signals.push({
      rule: "RULE_17_GOPLUS_SOFT_FLAGS",
      severity: "medium",
      reason: `GoPlus returned only SOFT flags for this address: ${security.softFlags.join(", ")}. These mean "suspected or unconfirmed" (blacklist_doubt) or abusive-but-not-theft behaviour (gas spam, mining abuse) — deliberately NOT enough to reject on their own. Give them weight as corroborating detail, and confirm with the transaction context rather than treating them as a verdict.`,
    });
  }

  // ── Rule 18: sender drain pattern ─────────────────────────────────────────
  // The recipient is the half an attacker controls; the SENDER is the half that
  // usually gives a compromise away. A burst of escrows in minutes is what a drained
  // key does, and a sender who was already rejected once is trying again.
  // `senderMemory === null` (DB unavailable) means unknown → no signal.
  if (senderMemory !== null) {
    const reasons: string[] = [];
    if (senderMemory.recentEscrowCount >= config.SENDER_BURST_COUNT) {
      reasons.push(
        `the sender opened ${senderMemory.recentEscrowCount} escrows in the last ${config.SENDER_BURST_WINDOW_MIN} minutes ` +
          `(threshold: >= ${config.SENDER_BURST_COUNT}), which is the shape of a compromised key draining funds`
      );
    }
    if (senderMemory.strongRejections > 0) {
      reasons.push(
        `${senderMemory.strongRejections} of the sender's previous escrows were rejected by something stronger than an AI release (a hard rule, the GoPlus override, or a human veto)`
      );
    }
    if (senderMemory.rejectedRecipients.length > 0) {
      reasons.push(
        `the sender was previously rejected for ${senderMemory.rejectedRecipients.length} recipient(s): ` +
          senderMemory.rejectedRecipients.slice(0, 3).join(", ")
      );
    }
    if (reasons.length > 0) {
      signals.push({
        rule: "RULE_18_SENDER_DRAIN_PATTERN",
        severity: "high",
        reason: `The SENDER, not the recipient, carries the risk history here: ${reasons.join("; ")}. A compromised or repeat-offending sender routes funds through the escrow exactly like a legitimate one, so the recipient's clean profile is not reassurance.`,
      });
    }
  }

  // ── Rule 4: GoPlus unavailable → escalate, do not APPROVE ────────────────
  // API unavailable != clean. Forwarded with the unavailability stated explicitly.
  if (security.status === "unavailable") {
    signals.push({
      rule: "RULE_4_GOPLUS_UNAVAILABLE",
      severity: "medium",
      reason:
        "The GoPlus security service is currently unavailable, so the security status of this address could not be confirmed. This is missing information, not a clean bill of health: weigh the on-chain evidence alone and lower your confidence accordingly.",
    });
  }

  // ── Rule 5: all on-chain intel unavailable ────────────────────────────────
  if (intel.unavailable) {
    signals.push({
      rule: "RULE_5_ONCHAIN_UNAVAILABLE",
      severity: "medium",
      reason:
        "The on-chain data sources (RPC node and the AegisVault event log) are currently unavailable, so the recipient's activity, balance and escrow history could not be verified. Treat every on-chain field as unknown rather than as zero.",
    });
  }

  // ── Rule 9: very large transfer (any wallet) → escalate to LLM ────────────
  if (amountBNB >= config.VERY_LARGE_TRANSFER_BNB) {
    signals.push({
      rule: "RULE_9_VERY_LARGE_TRANSFER",
      severity: "high",
      reason: `A transfer of ${amountBNB} BNB exceeds the very large transfer threshold (${config.VERY_LARGE_TRANSFER_BNB} BNB). There is no malicious signal attached to the amount itself, but an amount of this size needs contextual validation — in particular, who the sender is and why now.`,
    });
  }

  // ── Rule 10: fund-pooling hub + significant amount ────────────────────────
  // The old rule 10 branched on `walletAgeInDays`, permanently null on chain 97 (the
  // explorer that supplies it is deprecated), so it could never fire — dead code that
  // read as protection. It is rebuilt on the real signal that IS available: the
  // AegisVault event log. Many distinct senders converging on one recipient is the
  // on-chain signature of a collection/pooling hub.
  if (
    !intel.aegisLogsUnavailable &&
    intel.aegisDistinctSenders >= config.POOLING_HUB_MIN_SENDERS &&
    isSignificantAmount
  ) {
    signals.push({
      rule: "RULE_10_POOLING_HUB_SIGNIFICANT_AMOUNT",
      severity: "medium",
      reason: `On-chain (AegisVault event log): ${intel.aegisDistinctSenders} distinct senders have already funded this recipient through AEGIS (threshold: >= ${config.POOLING_HUB_MIN_SENDERS}), and it is now receiving ${amountBNB} BNB (>= ${config.SIGNIFICANT_TRANSFER_BNB} BNB). Many-to-one funding is the signature of a collection or pooling hub.`,
    });
  }

  // ── Rule 19: recipient has prior NON-confirmed rejections ────────────────
  // Info only. History that stopped short of a malicious confirmation (a fail-safe, an
  // LLM-only rejection, or a shape rule that has since been downgraded) is not
  // evidence — but it is context the Investigator should not have to dig for.
  if (
    recipientMemory !== null &&
    recipientMemory.totalRejected > recipientMemory.confirmedMaliciousRejects
  ) {
    const unconfirmed = recipientMemory.totalRejected - recipientMemory.confirmedMaliciousRejects;
    signals.push({
      rule: "RULE_19_RECIPIENT_PRIOR_SOFT_REJECT",
      severity: "info",
      reason: `AEGIS history: this recipient was rejected ${recipientMemory.totalRejected} time(s) in total, but only ${recipientMemory.confirmedMaliciousRejects} of those were confirmed malicious. The remaining ${unconfirmed} were rejections WITHOUT a malicious finding (a fail-safe because the case could not be analysed, an LLM-only rejection, or a shape-based rule that has since been downgraded). Treat this as a reason to look carefully, not as a verdict against the address.`,
    });
  }

  if (signals.length === 0) {
    // IMPORTANT: We never produce APPROVE from the rule engine.
    // Only LLM + confidence threshold can produce APPROVE.
    return {
      decision: "NEEDS_LLM",
      reason:
        "No deterministic rejection criteria met. Forwarding to LLM for contextual risk reasoning.",
      triggeredRule: "RULE_DEFAULT",
      signals: [],
    };
  }

  // Stable sort: within one severity the evaluation order above is preserved, so the
  // reported rule ID is deterministic and a tied pair always reports the same one.
  const ordered = [...signals].sort(
    (a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]
  );
  const primary = ordered[0]!;

  return {
    decision: "NEEDS_LLM",
    reason: ordered.map((s) => s.reason).join(" "),
    triggeredRule: primary.rule,
    signals: ordered,
  };
}

/**
 * The subset of a rule verdict that is written to the decision transcript.
 *
 * Kept in one place so the persisted shape cannot drift from what
 * `getAddressMemory` reads back when it decides whether a past rejection was a
 * malicious confirmation.
 */
export function toRuleContext(result: HardRuleResult): RuleEngineContext {
  return {
    decision: result.decision,
    triggeredRule: result.triggeredRule,
    signals: result.signals,
  };
}
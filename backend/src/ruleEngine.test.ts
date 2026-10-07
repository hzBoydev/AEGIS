// ── Rule engine: the deterministic contract ───────────────────────────────────
// WHY THIS SUITE EXISTS
// ──────────────────────
// The rule engine is the only part of AEGIS that can deny a transfer without asking a
// model, so its two invariants are worth pinning down with tests rather than with a
// comment: it never says APPROVE, and it never REJECTs on missing data. Every case
// below is one of those two promises being broken in the past.
//
// `runRules` is pure — no network, no database, no clock — so the entire matrix runs in
// milliseconds. That is the point of passing everything in as one `RuleInput` object.

import { test } from "node:test";
import assert from "node:assert/strict";
import { runRules, toRuleContext, FUND_LOSS_ADDRESSES } from "./ruleEngine.js";
import type { RuleInput, HardRuleResult } from "./ruleEngine.js";
import type { SecurityCheckResult } from "./goplusChecker.js";
import type { OnChainIntel } from "./bscscanChecker.js";
import type { AddressMemory, SenderMemory } from "./agentMemory.js";
import { config } from "./config.js";

// ── Fixtures ──────────────────────────────────────────────────────────────────
const ADDR_SENDER = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
const ADDR_RECIPIENT = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC";
const ADDR_DELEGATE = "0x6bd9b71559e3b2013596726a4e2ca1ee97189606";

const SEC_CLEAN: SecurityCheckResult = {
  status: "clean",
  riskFlags: [],
  hardFlags: [],
  softFlags: [],
  source: "goplus",
};
const SEC_UNAVAILABLE: SecurityCheckResult = {
  status: "unavailable",
  riskFlags: [],
  hardFlags: [],
  softFlags: [],
  source: "unavailable",
};
const SEC_HARD: SecurityCheckResult = {
  status: "malicious",
  riskFlags: ["stealing_attack"],
  hardFlags: ["stealing_attack"],
  softFlags: [],
  source: "goplus",
};
const SEC_SOFT: SecurityCheckResult = {
  status: "clean",
  riskFlags: ["blacklist_doubt"],
  hardFlags: [],
  softFlags: ["blacklist_doubt"],
  source: "goplus",
};

const INTEL_ESTABLISHED: OnChainIntel = {
  txCount: 40,
  txCountSource: "explorer",
  walletAgeInDays: null,
  novelty: "established",
  isNovelAccount: false,
  isContract: false,
  eip7702Delegated: false,
  delegateAddress: null,
  balanceBNB: 12,
  aegisEscrowIn: 1,
  aegisEscrowOut: 0,
  aegisDistinctSenders: 1,
  aegisFirstSeenBlock: 1000n,
  aegisLastSeenBlock: 2000n,
  aegisLogsUnavailable: false,
  aegisWindowLimited: false,
  unavailable: false,
};
const INTEL_NOVEL: OnChainIntel = {
  ...INTEL_ESTABLISHED,
  txCount: 0,
  txCountSource: "rpc_nonce",
  novelty: "novel",
  isNovelAccount: true,
  balanceBNB: 0,
  aegisEscrowIn: 0,
};
const INTEL_DEAD: OnChainIntel = {
  ...INTEL_ESTABLISHED,
  txCount: null,
  txCountSource: "none",
  novelty: "unknown",
  balanceBNB: null,
  aegisLogsUnavailable: true,
  unavailable: true,
};

function memory(over: Partial<AddressMemory> = {}): AddressMemory {
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
    ...over,
  };
}

function senderMemory(over: Partial<SenderMemory> = {}): SenderMemory {
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
    ...over,
  };
}

/** A fully known, entirely unremarkable transfer. Each test overrides one field. */
function input(over: Partial<RuleInput> = {}): RuleInput {
  return {
    security: SEC_CLEAN,
    intel: INTEL_ESTABLISHED,
    amountBNB: 0.05,
    sender: ADDR_SENDER as `0x${string}`,
    recipient: ADDR_RECIPIENT as `0x${string}`,
    recipientMemory: memory(),
    senderMemory: null,
    senderCounterparties: [],
    delegateSecurity: null,
    localDenylistHit: null,
    ...over,
  };
}

const rules = (over: Partial<RuleInput> = {}): HardRuleResult => runRules(input(over));
/** Addresses are built by template, which widens to `string`; this keeps the literal type. */
const asAddr = (a: string): `0x${string}` => a as `0x${string}`;
const rulesOf = (over: Partial<RuleInput>, amountBNB: number) =>
  runRules(input({ amountBNB, ...over }));

// ── The two invariants ────────────────────────────────────────────────────────
test("runRules: only REJECT or NEEDS_LLM, across the whole evidence matrix", () => {
  const securities: SecurityCheckResult[] = [
    SEC_CLEAN,
    SEC_HARD,
    SEC_SOFT,
    SEC_UNAVAILABLE,
  ];
  const intels: OnChainIntel[] = [
    INTEL_ESTABLISHED,
    INTEL_NOVEL,
    INTEL_DEAD,
    { ...INTEL_ESTABLISHED, isContract: true },
    { ...INTEL_ESTABLISHED, eip7702Delegated: true, delegateAddress: ADDR_DELEGATE },
  ];
  const amounts = [0.0001, config.SIGNIFICANT_TRANSFER_BNB, config.VERY_LARGE_TRANSFER_BNB + 1];
  let n = 0;
  for (const security of securities) {
    for (const intel of intels) {
      for (const amountBNB of amounts) {
        for (const denylistHit of [null, { list: "ofac", label: "listed" }]) {
          for (const confirmed of [0, 2]) {
            const r = runRules(
              input({
                security,
                intel,
                amountBNB,
                localDenylistHit: denylistHit,
                recipientMemory: memory({
                  totalSeen: confirmed,
                  totalRejected: confirmed,
                  confirmedMaliciousRejects: confirmed,
                  confirmedMaliciousRules: confirmed > 0 ? ["RULE_1_GOPLUS_MALICIOUS"] : [],
                }),
              })
            );
            assert.ok(
              r.decision === "REJECT" || r.decision === "NEEDS_LLM",
              `invalid decision ${r.decision}`
            );
            // A REJECT is a finding, so it must never carry escalation noise.
            if (r.decision === "REJECT") {
              assert.equal(r.signals.length, 0, "REJECT must carry no signals");
            } else {
              assert.ok(r.triggeredRule.length > 0, "NEEDS_LLM must name a rule");
            }
            n += 1;
          }
        }
      }
    }
  }
  assert.ok(n >= 200, `matrix too small: ${n}`);
});

test("runRules: nothing observable at all is still NEEDS_LLM, never APPROVE", () => {
  const r = runRules(
    input({
      security: SEC_UNAVAILABLE,
      intel: INTEL_DEAD,
      recipientMemory: null,
      senderMemory: null,
      senderCounterparties: null,
      localDenylistHit: null,
    })
  );
  assert.equal(r.decision, "NEEDS_LLM");
  const ids = r.signals.map((x) => x.rule);
  assert.ok(ids.includes("RULE_4_GOPLUS_UNAVAILABLE"), ids.join(","));
  assert.ok(ids.includes("RULE_5_ONCHAIN_UNAVAILABLE"), ids.join(","));
  // Both are medium, so the stable sort keeps evaluation order and rule 4 leads.
  assert.equal(r.triggeredRule, "RULE_4_GOPLUS_UNAVAILABLE");
  assert.ok(!("APPROVE" in r));
});

// ── RULE_0: fund-loss destinations ────────────────────────────────────────────
test("RULE_0: zero address is rejected even with every data source down", () => {
  const r = runRules(
    input({
      security: SEC_UNAVAILABLE,
      intel: INTEL_DEAD,
      recipient: FUND_LOSS_ADDRESSES[0] as `0x${string}`,
      recipientMemory: null,
      senderCounterparties: null,
    })
  );
  assert.equal(r.decision, "REJECT");
  assert.equal(r.triggeredRule, "RULE_0_FUND_LOSS_ADDRESS");
});

test("RULE_0: burn addresses are rejected, case-insensitively", () => {
  for (const addr of FUND_LOSS_ADDRESSES) {
    for (const variant of [addr, addr.toUpperCase().replace("0X", "0x")]) {
      const r = runRules(input({ recipient: variant as `0x${string}` }));
      assert.equal(
        r.triggeredRule,
        "RULE_0_FUND_LOSS_ADDRESS",
        `${variant} was not rejected as a fund-loss address`
      );
    }
  }
});

test("RULE_0: EIP-1809 precompiles 0x01..0xff are rejected", () => {
  for (const hex of ["01", "02", "0a", "7f", "ff"]) {
    const addr = `0x${hex.padStart(40, "0")}`;
    const r = runRules(input({ recipient: addr as `0x${string}` }));
    assert.equal(r.triggeredRule, "RULE_0_FUND_LOSS_ADDRESS", `${addr} not rejected`);
  }
});

test("RULE_0: the precompile range has a hard boundary — 0x100 is a payable address", () => {
  const r = rules({ recipient: `0x${"0100".padStart(40, "0")}` as `0x${string}` });
  assert.notEqual(r.triggeredRule, "RULE_0_FUND_LOSS_ADDRESS");
});

test("RULE_0: a long run of leading zeros is vanity, not evidence", () => {
  const r = rules({ recipient: `0x${"0".repeat(30)}${"a".repeat(10)}` as `0x${string}` });
  assert.notEqual(r.triggeredRule, "RULE_0_FUND_LOSS_ADDRESS");
});

test("RULE_0: paying the escrow contract itself is rejected", () => {
  const r = rules({ recipient: config.CONTRACT_ADDRESS as `0x${string}` });
  assert.equal(r.decision, "REJECT");
  assert.equal(r.triggeredRule, "RULE_0_FUND_LOSS_ADDRESS");
  assert.match(r.reason, /vault/i);
});

test("RULE_0: a self-payment moves no value to anyone", () => {
  const r = rules({ recipient: ADDR_SENDER as `0x${string}` });
  assert.equal(r.decision, "REJECT");
  assert.equal(r.triggeredRule, "RULE_0_FUND_LOSS_ADDRESS");
  assert.match(r.reason, /sender itself/i);
});

test("RULE_0: a malformed recipient is not silently treated as a fund-loss address", () => {
  // The pipeline validates the address before this point; the rules must not invent a
  // verdict for something they cannot parse.
  const r = rules({ recipient: "0xnope" as `0x${string}` });
  assert.notEqual(r.triggeredRule, "RULE_0_FUND_LOSS_ADDRESS");
  assert.equal(r.decision, "NEEDS_LLM");
});

// ── RULE_1 / 1B / 8: GoPlus ────────────────────────────────────────────────────
test("RULE_1: a hard flag rejects and the flag names are in the reason", () => {
  const r = rules({ security: SEC_HARD });
  assert.equal(r.decision, "REJECT");
  assert.equal(r.triggeredRule, "RULE_1_GOPLUS_MALICIOUS");
  assert.match(r.reason, /stealing_attack/);
});

test("RULE_1B: malicious with no flag list still rejects", () => {
  const r = rules({
    security: { status: "malicious", riskFlags: [], hardFlags: [], softFlags: [], source: "goplus" },
  });
  assert.equal(r.decision, "REJECT");
  assert.equal(r.triggeredRule, "RULE_1B_GOPLUS_MALICIOUS_NO_FLAGS");
});

test("RULE_8: a phishing label in rawData rejects even when status is clean", () => {
  const r = rules({
    security: {
      ...SEC_CLEAN,
      rawData: { phishing_activities: "1", honeypot_related_address: 1 },
    },
  });
  assert.equal(r.decision, "REJECT");
  assert.equal(r.triggeredRule, "RULE_8_GOPLUS_PHISHING_FLAGS");
  assert.match(r.reason, /phishing_activities/);
});

test("RULE_8: an unset label in rawData does nothing", () => {
  const r = rules({
    security: { ...SEC_CLEAN, rawData: { phishing_activities: "0", is_blacklisted: "0" } },
  });
  assert.notEqual(r.triggeredRule, "RULE_8_GOPLUS_PHISHING_FLAGS");
});

// ── RULE_12: local denylist ───────────────────────────────────────────────────
test("RULE_12: a denylist hit rejects while GoPlus says clean", () => {
  const r = rules({ localDenylistHit: { list: "ofac", label: "SDN listed" } });
  assert.equal(r.decision, "REJECT");
  assert.equal(r.triggeredRule, "RULE_12_LOCAL_DENYLIST");
  assert.match(r.reason, /SDN listed/);
});

test("RULE_12: no hit means no rule 12", () => {
  const r = rules({ localDenylistHit: null });
  assert.notEqual(r.triggeredRule, "RULE_12_LOCAL_DENYLIST");
});

// ── RULE_13: confirmed malicious history ───────────────────────────────────────
test("RULE_13: a confirmed malicious history rejects and names the rules", () => {
  const r = rules({
    recipientMemory: memory({
      totalSeen: 3,
      totalRejected: 3,
      hadHardRuleReject: true,
      confirmedMaliciousRejects: 3,
      confirmedMaliciousRules: ["RULE_1_GOPLUS_MALICIOUS", "RULE_12_LOCAL_DENYLIST"],
    }),
  });
  assert.equal(r.decision, "REJECT");
  assert.equal(r.triggeredRule, "RULE_13_AEGIS_CONFIRMED_MALICIOUS");
  assert.match(r.reason, /RULE_1_GOPLUS_MALICIOUS/);
});

test("RULE_13: unreadable memory is UNKNOWN, not a confirmation and not a clean slate", () => {
  const r = rules({ recipientMemory: null });
  assert.equal(r.decision, "NEEDS_LLM");
  assert.notEqual(r.triggeredRule, "RULE_13_AEGIS_CONFIRMED_MALICIOUS");
});

// ── RULE_14: address poisoning ────────────────────────────────────────────────
test("RULE_14: a lookalike of a paid counterparty rejects and shows both addresses", () => {
  const genuineHex = "1a2b3c4d5e6f708192a3b4c5d6e7f80912a3b4c5";
  const head = genuineHex.slice(0, config.POISONING_PREFIX_CHARS);
  const tail = genuineHex.slice(-config.POISONING_SUFFIX_CHARS);
  const midLen = genuineHex.length - head.length - tail.length;
  const genuine = `0x${genuineHex}`;
  const lookalike = `0x${head}${"ab".repeat(midLen / 2).slice(0, midLen)}${tail}`;

  const r = rules({ recipient: asAddr(lookalike), senderCounterparties: [genuine] });
  assert.equal(r.decision, "REJECT");
  assert.equal(r.triggeredRule, "RULE_14_ADDRESS_POISONING");
  assert.ok(r.reason.includes(genuine), "the genuine address must be shown for comparison");
});

test("RULE_14: a repeat payment to a KNOWN payee is not poisoning", () => {
  const genuine = "0x1a2b3c4d5e6f708192a3b4c5d6e7f80912a3b4c5";
  const r = rules({ recipient: asAddr(genuine), senderCounterparties: [genuine] });
  assert.notEqual(r.triggeredRule, "RULE_14_ADDRESS_POISONING");
});

test("RULE_14: matching only the visible head is a coincidence, not an attack", () => {
  const genuineHex = "1a2b3c4d5e6f708192a3b4c5d6e7f80912a3b4c5";
  const head = genuineHex.slice(0, config.POISONING_PREFIX_CHARS);
  const midLen =
    genuineHex.length - head.length - config.POISONING_SUFFIX_CHARS;
  const coincidence = `0x${head}${"cd".repeat(midLen / 2).slice(0, midLen)}ffff`;
  const r = rules({
    recipient: asAddr(coincidence),
    senderCounterparties: [`0x${genuineHex}`],
  });
  assert.notEqual(r.triggeredRule, "RULE_14_ADDRESS_POISONING");
});

test("RULE_14: counterparty history must match on BOTH ends", () => {
  const genuineHex = "1a2b3c4d5e6f708192a3b4c5d6e7f80912a3b4c5";
  const head = genuineHex.slice(0, config.POISONING_PREFIX_CHARS);
  const tail = genuineHex.slice(-config.POISONING_SUFFIX_CHARS);
  const midLen = genuineHex.length - head.length - tail.length;
  const lookalike = `0x${head}${"ab".repeat(midLen / 2).slice(0, midLen)}${tail}`;
  const r = rules({ recipient: asAddr(lookalike), senderCounterparties: [] });
  assert.notEqual(r.triggeredRule, "RULE_14_ADDRESS_POISONING");
});

test("RULE_14: unknown counterparty history produces no poisoning claim", () => {
  const r = rules({ senderCounterparties: null });
  assert.equal(r.decision, "NEEDS_LLM");
  assert.ok(!r.reason.toLowerCase().includes("poisoning"));
});

test("RULE_14: a poisoned address in mixed case is still caught", () => {
  const genuineHex = "1a2b3c4d5e6f708192a3b4c5d6e7f80912a3b4c5";
  const head = genuineHex.slice(0, config.POISONING_PREFIX_CHARS);
  const tail = genuineHex.slice(-config.POISONING_SUFFIX_CHARS);
  const midLen = genuineHex.length - head.length - tail.length;
  const lookalike = `0x${head}${"ab".repeat(midLen / 2).slice(0, midLen)}${tail}`.toUpperCase();
  const r = rules({ recipient: asAddr(lookalike), senderCounterparties: [`0x${genuineHex}`] });
  assert.equal(r.triggeredRule, "RULE_14_ADDRESS_POISONING");
});

// ── RULE_15 / 16: EIP-7702 ────────────────────────────────────────────────────
const DELEGATED_INTEL: OnChainIntel = {
  ...INTEL_ESTABLISHED,
  eip7702Delegated: true,
  delegateAddress: ADDR_DELEGATE as `0x${string}`,
};

test("RULE_15: a malicious delegate rejects and the reason names the DELEGATE", () => {
  const r = rules({ intel: DELEGATED_INTEL, delegateSecurity: SEC_HARD });
  assert.equal(r.decision, "REJECT");
  assert.equal(r.triggeredRule, "RULE_15_EIP7702_MALICIOUS_DELEGATE");
  assert.ok(r.reason.includes(ADDR_DELEGATE), "the delegate must be named, not the EOA");
});

test("RULE_15: a malicious delegate is rejected even if the EOA itself looks established", () => {
  const r = rules({
    intel: DELEGATED_INTEL,
    delegateSecurity: SEC_HARD,
    recipientMemory: memory({ totalSeen: 5, totalApproved: 5 }),
  });
  assert.equal(r.decision, "REJECT");
});

test("RULE_16: an unchecked delegate escalates as a high-severity signal", () => {
  for (const delegateSecurity of [
    null,
    { ...SEC_CLEAN, status: "unavailable" as const, source: "unavailable" as const },
    { ...SEC_CLEAN, failedChains: ["56"] },
  ]) {
    const r = rules({ intel: DELEGATED_INTEL, delegateSecurity });
    assert.equal(r.decision, "NEEDS_LLM");
    const sig = r.signals.find((x) => x.rule === "RULE_16_EIP7702_UNKNOWN_DELEGATE");
    assert.ok(sig, `rule 16 missing for ${JSON.stringify(delegateSecurity?.status)}`);
    assert.equal(sig!.severity, "high");
  }
});

test("RULE_16: a fully cleared delegate produces no signal", () => {
  const r = rules({ intel: DELEGATED_INTEL, delegateSecurity: SEC_CLEAN });
  assert.ok(!r.signals.some((x) => x.rule === "RULE_16_EIP7702_UNKNOWN_DELEGATE"));
});

test("RULE_16: a delegate with soft flags is not 'cleared'", () => {
  const r = rules({
    intel: DELEGATED_INTEL,
    delegateSecurity: { ...SEC_CLEAN, riskFlags: ["blacklist_doubt"], softFlags: ["blacklist_doubt"] },
  });
  assert.ok(r.signals.some((x) => x.rule === "RULE_16_EIP7702_UNKNOWN_DELEGATE"));
});

test("RULE_6 never fires for a delegated EOA, even with a stale isContract flag", () => {
  const r = rules({
    intel: { ...DELEGATED_INTEL, isContract: true },
    delegateSecurity: SEC_CLEAN,
  });
  assert.ok(!r.signals.some((x) => x.rule === "RULE_6_CONTRACT_RECEIVER"));
});

// ── Downgraded shape rules ────────────────────────────────────────────────────
test("RULE_6: a contract receiver is escalated, never rejected", () => {
  const r = rules({ intel: { ...INTEL_ESTABLISHED, isContract: true } });
  assert.equal(r.decision, "NEEDS_LLM");
  assert.ok(r.signals.some((x) => x.rule === "RULE_6_CONTRACT_RECEIVER"));
  assert.match(
    r.signals.find((x) => x.rule === "RULE_6_CONTRACT_RECEIVER")!.reason,
    /not evidence of fraud by itself/i
  );
});

test("RULE_2: a novel empty account at a significant amount is escalated, never rejected", () => {
  const r = rulesOf({ intel: INTEL_NOVEL }, config.SIGNIFICANT_TRANSFER_BNB);
  assert.equal(r.decision, "NEEDS_LLM");
  assert.ok(r.signals.some((x) => x.rule === "RULE_2_NOVEL_EMPTY_ACCOUNT_SIGNIFICANT_AMOUNT"));
});

test("RULE_2: below the significant threshold only rule 3 fires", () => {
  const r = rulesOf({ intel: INTEL_NOVEL }, config.SIGNIFICANT_TRANSFER_BNB / 10);
  assert.equal(r.decision, "NEEDS_LLM");
  assert.ok(!r.signals.some((x) => x.rule === "RULE_2_NOVEL_EMPTY_ACCOUNT_SIGNIFICANT_AMOUNT"));
  assert.ok(r.signals.some((x) => x.rule === "RULE_3_NOVEL_ACCOUNT_SMALL_AMOUNT"));
});

test("RULE_2: unknown novelty is never treated as novel", () => {
  const r = rulesOf({ intel: INTEL_DEAD }, config.SIGNIFICANT_TRANSFER_BNB);
  assert.ok(!r.signals.some((x) => x.rule.startsWith("RULE_2_")));
  assert.ok(!r.signals.some((x) => x.rule.startsWith("RULE_3_")));
});

test("RULE_2: an unreachable vault log never becomes 'no AEGIS history' in the text", () => {
  const r = rulesOf(
    { intel: { ...INTEL_NOVEL, aegisLogsUnavailable: true } },
    config.SIGNIFICANT_TRANSFER_BNB
  );
  assert.ok(!/no AEGIS escrow/i.test(r.reason), r.reason);
});

test("RULE_7: a zero-balance wallet at a significant amount is escalated, never rejected", () => {
  const r = rules({
    intel: { ...INTEL_ESTABLISHED, balanceBNB: 0 },
    amountBNB: config.SIGNIFICANT_TRANSFER_BNB,
  });
  assert.equal(r.decision, "NEEDS_LLM");
  assert.ok(r.signals.some((x) => x.rule === "RULE_7_ZERO_BALANCE_SIGNIFICANT_AMOUNT"));
});

test("RULE_7: an unknown balance is not a zero balance", () => {
  const r = rules({
    intel: { ...INTEL_ESTABLISHED, balanceBNB: null },
    amountBNB: config.SIGNIFICANT_TRANSFER_BNB,
  });
  assert.ok(!r.signals.some((x) => x.rule === "RULE_7_ZERO_BALANCE_SIGNIFICANT_AMOUNT"));
});

// ── Signals ───────────────────────────────────────────────────────────────────
test("RULE_17: soft flags inform the hearing and never reject", () => {
  const r = rules({ security: SEC_SOFT });
  assert.equal(r.decision, "NEEDS_LLM");
  const sig = r.signals.find((x) => x.rule === "RULE_17_GOPLUS_SOFT_FLAGS");
  assert.ok(sig);
  assert.match(sig!.reason, /blacklist_doubt/);
  assert.match(sig!.reason, /not enough to reject/i);
});

test("RULE_4: an unavailable GoPlus escalates and is never called clean", () => {
  const r = rules({ security: SEC_UNAVAILABLE });
  const sig = r.signals.find((x) => x.rule === "RULE_4_GOPLUS_UNAVAILABLE");
  assert.ok(sig);
  assert.match(sig!.reason, /missing information, not a clean bill of health/i);
});

test("RULE_5: dead on-chain sources escalate", () => {
  const r = rules({ intel: INTEL_DEAD });
  const sig = r.signals.find((x) => x.rule === "RULE_5_ONCHAIN_UNAVAILABLE");
  assert.ok(sig);
});

test("RULE_9: a very large transfer escalates", () => {
  const r = rules({ amountBNB: config.VERY_LARGE_TRANSFER_BNB });
  assert.ok(r.signals.some((x) => x.rule === "RULE_9_VERY_LARGE_TRANSFER"));
});

test("RULE_9: exactly at the threshold still fires", () => {
  const r = rules({ amountBNB: config.VERY_LARGE_TRANSFER_BNB });
  assert.ok(r.signals.some((x) => x.rule === "RULE_9_VERY_LARGE_TRANSFER"));
});

test("RULE_9: below the threshold does not fire", () => {
  const r = rules({ amountBNB: config.VERY_LARGE_TRANSFER_BNB - 0.001 });
  assert.ok(!r.signals.some((x) => x.rule === "RULE_9_VERY_LARGE_TRANSFER"));
});

test("RULE_10: a pooling hub escalates and reads the real on-chain signal", () => {
  const r = rules({
    intel: { ...INTEL_ESTABLISHED, aegisEscrowIn: 40, aegisDistinctSenders: 12 },
    amountBNB: config.SIGNIFICANT_TRANSFER_BNB,
  });
  const sig = r.signals.find((x) => x.rule === "RULE_10_POOLING_HUB_SIGNIFICANT_AMOUNT");
  assert.ok(sig, `rule 10 must fire (walletAgeInDays is gone, so this must not be dead code)`);
  assert.match(sig!.reason, /12 distinct senders/);
});

test("RULE_10: an unreadable vault log cannot produce a sender count", () => {
  const r = rules({
    intel: {
      ...INTEL_ESTABLISHED,
      aegisLogsUnavailable: true,
      aegisDistinctSenders: 12,
    },
    amountBNB: config.SIGNIFICANT_TRANSFER_BNB,
  });
  assert.ok(!r.signals.some((x) => x.rule === "RULE_10_POOLING_HUB_SIGNIFICANT_AMOUNT"));
});

test("RULE_18: a sender burst escalates as a high-severity signal", () => {
  const r = rules({
    senderMemory: senderMemory({ totalSent: 4, recentEscrowCount: config.SENDER_BURST_COUNT }),
  });
  const sig = r.signals.find((x) => x.rule === "RULE_18_SENDER_DRAIN_PATTERN");
  assert.ok(sig);
  assert.equal(sig!.severity, "high");
  assert.match(sig!.reason, /compromised key/);
});

test("RULE_18: one below the burst threshold is silent", () => {
  const r = rules({
    senderMemory: senderMemory({ recentEscrowCount: config.SENDER_BURST_COUNT - 1 }),
  });
  assert.ok(!r.signals.some((x) => x.rule === "RULE_18_SENDER_DRAIN_PATTERN"));
});

test("RULE_18: a repeat-offending sender escalates even below the burst threshold", () => {
  const r = rules({
    senderMemory: senderMemory({
      totalSent: 6,
      rejected: 4,
      strongRejections: 2,
      rejectedRecipients: ["0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC"],
    }),
  });
  const sig = r.signals.find((x) => x.rule === "RULE_18_SENDER_DRAIN_PATTERN");
  assert.ok(sig);
  assert.match(sig!.reason, /stronger than an AI release/);
});

test("RULE_18: unknown sender history is silent, and never presented as clean", () => {
  const r = rules({ senderMemory: null });
  assert.ok(!r.signals.some((x) => x.rule === "RULE_18_SENDER_DRAIN_PATTERN"));
  assert.equal(r.decision, "NEEDS_LLM");
});

test("RULE_19: unconfirmed prior rejections are info, and the count is honest", () => {
  const r = rules({
    recipientMemory: memory({
      totalSeen: 4,
      totalRejected: 4,
      // A fail-safe and an LLM-only rejection leave no confirmed malice.
      confirmedMaliciousRejects: 0,
      confirmedMaliciousRules: [],
    }),
  });
  const sig = r.signals.find((x) => x.rule === "RULE_19_RECIPIENT_PRIOR_SOFT_REJECT");
  assert.ok(sig);
  assert.equal(sig!.severity, "info");
  assert.match(sig!.reason, /not as a verdict/);
});

test("RULE_19: fully confirmed rejections are rule 13's job, not an info signal", () => {
  const r = rules({
    recipientMemory: memory({
      totalSeen: 4,
      totalRejected: 4,
      confirmedMaliciousRejects: 4,
      confirmedMaliciousRules: ["RULE_1_GOPLUS_MALICIOUS"],
    }),
  });
  assert.equal(r.decision, "REJECT");
  assert.equal(r.triggeredRule, "RULE_13_AEGIS_CONFIRMED_MALICIOUS");
});

// ── Ordering and the default path ─────────────────────────────────────────────
test("Phase A: with five hard rules firing at once, RULE_0 is the one recorded", () => {
  // Malicious GoPlus + denylist + confirmed history + a poisoned destination +
  // an unspendable recipient. Five REJECT-worthy facts, one recorded id: the
  // strongest, because that is the one an auditor will read first.
  const r = runRules(
    input({
      security: SEC_HARD,
      recipient: FUND_LOSS_ADDRESSES[0] as `0x${string}`,
      localDenylistHit: { list: "ofac", label: "listed" },
      recipientMemory: memory({
        totalSeen: 2,
        totalRejected: 2,
        confirmedMaliciousRejects: 1,
        confirmedMaliciousRules: ["RULE_1_GOPLUS_MALICIOUS"],
      }),
    })
  );
  assert.equal(r.decision, "REJECT");
  assert.equal(r.triggeredRule, "RULE_0_FUND_LOSS_ADDRESS");
  assert.equal(r.signals.length, 0);
});

test("Phase A: a poisoned lookalike rejects when nothing stronger applies", () => {
  const genuineHex = "1a2b3c4d5e6f708192a3b4c5d6e7f80912a3b4c5";
  const head = genuineHex.slice(0, config.POISONING_PREFIX_CHARS);
  const tail = genuineHex.slice(-config.POISONING_SUFFIX_CHARS);
  const midLen = genuineHex.length - head.length - tail.length;
  const lookalike = `0x${head}${"ab".repeat(midLen / 2).slice(0, midLen)}${tail}`;
  const r = runRules(
    input({
      recipient: lookalike as `0x${string}`,
      localDenylistHit: { list: "ofac", label: "listed" },
    })
  );
  assert.equal(r.triggeredRule, "RULE_12_LOCAL_DENYLIST");
  const withoutDenylist = runRules(
    input({
      recipient: asAddr(lookalike),
      senderCounterparties: [`0x${genuineHex}`],
    })
  );
  assert.equal(withoutDenylist.triggeredRule, "RULE_14_ADDRESS_POISONING");
});

test("Phase A: rule order is 0 → 1 → 1B → 8 → 12 → 13 → 14 → 15", () => {
  const cases: Array<[Partial<RuleInput>, string]> = [
    [{ security: SEC_HARD, localDenylistHit: { list: "ofac", label: "x" } }, "RULE_1_GOPLUS_MALICIOUS"],
    [
      {
        security: { status: "malicious", riskFlags: [], hardFlags: [], softFlags: [], source: "goplus" },
        localDenylistHit: { list: "ofac", label: "x" },
      },
      "RULE_1B_GOPLUS_MALICIOUS_NO_FLAGS",
    ],
    [
      {
        security: { ...SEC_CLEAN, rawData: { stealing_attack: "1" } },
        localDenylistHit: { list: "ofac", label: "x" },
      },
      "RULE_8_GOPLUS_PHISHING_FLAGS",
    ],
    [
      {
        localDenylistHit: { list: "ofac", label: "x" },
        recipientMemory: memory({ totalSeen: 1, totalRejected: 1, confirmedMaliciousRejects: 1 }),
      },
      "RULE_12_LOCAL_DENYLIST",
    ],
  ];
  for (const [over, expected] of cases) {
    const r = runRules(input(over));
    assert.equal(r.triggeredRule, expected);
  }
});

test("Phase B: every signal is collected, not just the first match", () => {
  const r = rules({
    security: SEC_UNAVAILABLE,
    intel: INTEL_NOVEL,
    amountBNB: config.VERY_LARGE_TRANSFER_BNB + 1,
    senderMemory: senderMemory({ recentEscrowCount: config.SENDER_BURST_COUNT + 1 }),
    recipientMemory: memory({ totalSeen: 2, totalRejected: 1, confirmedMaliciousRejects: 0 }),
  });
  const ids = r.signals.map((x) => x.rule);
  for (const want of [
    "RULE_9_VERY_LARGE_TRANSFER",
    "RULE_2_NOVEL_EMPTY_ACCOUNT_SIGNIFICANT_AMOUNT",
    "RULE_3_NOVEL_ACCOUNT_SMALL_AMOUNT",
    "RULE_4_GOPLUS_UNAVAILABLE",
    "RULE_18_SENDER_DRAIN_PATTERN",
    "RULE_19_RECIPIENT_PRIOR_SOFT_REJECT",
  ]) {
    assert.ok(ids.includes(want), `missing ${want} in ${ids.join(", ")}`);
  }
});

test("Phase B: signals are sorted high → medium → info", () => {
  const r = rules({
    security: SEC_SOFT,
    intel: INTEL_NOVEL,
    amountBNB: config.VERY_LARGE_TRANSFER_BNB + 1,
    senderMemory: senderMemory({ recentEscrowCount: config.SENDER_BURST_COUNT }),
    recipientMemory: memory({ totalSeen: 2, totalRejected: 1, confirmedMaliciousRejects: 0 }),
  });
  const rank = { high: 0, medium: 1, info: 2 } as const;
  for (let i = 1; i < r.signals.length; i++) {
    assert.ok(
      rank[r.signals[i]!.severity] >= rank[r.signals[i - 1]!.severity],
      `out of order at ${i}: ${r.signals[i - 1]!.severity} then ${r.signals[i]!.severity}`
    );
  }
  assert.equal(r.triggeredRule, r.signals[0]!.rule);
});

test("Phase B: the sort is stable, so a tie always reports the same rule", () => {
  const build = () =>
    rules({
      security: SEC_SOFT,
      intel: INTEL_NOVEL,
      amountBNB: config.SIGNIFICANT_TRANSFER_BNB,
    });
  const first = build();
  for (let i = 0; i < 5; i++) {
    assert.equal(build().triggeredRule, first.triggeredRule);
  }
});

test("RULE_DEFAULT: a genuinely unremarkable transfer still goes to the hearing", () => {
  const r = rules();
  assert.equal(r.decision, "NEEDS_LLM");
  assert.equal(r.triggeredRule, "RULE_DEFAULT");
  assert.equal(r.signals.length, 0);
  assert.match(r.reason, /forwarding to llm/i);
});

// ── Persistence shape ─────────────────────────────────────────────────────────
test("toRuleContext: stores the decision, rule id and signals — and no prose", () => {
  const r = rules({
    security: SEC_SOFT,
    intel: INTEL_NOVEL,
    amountBNB: config.SIGNIFICANT_TRANSFER_BNB,
  });
  const ctx = toRuleContext(r);
  assert.deepEqual(Object.keys(ctx).sort(), ["decision", "signals", "triggeredRule"]);
  assert.equal(ctx.decision, "NEEDS_LLM");
  assert.equal(ctx.triggeredRule, r.triggeredRule);
  assert.equal(ctx.signals.length, r.signals.length);
  // The reason is re-rendered from the current thresholds on every run, so storing it
  // would make old rows describe today's thresholds instead of their own.
  assert.ok(!("reason" in (ctx as unknown as Record<string, unknown>)));
});

test("toRuleContext: a REJECT persists an empty signal list", () => {
  const ctx = toRuleContext(rules({ security: SEC_HARD }));
  assert.equal(ctx.decision, "REJECT");
  assert.equal(ctx.signals.length, 0);
});

test("runRules: is pure — the same input always gives the same output", () => {
  const over: Partial<RuleInput> = {
    security: SEC_UNAVAILABLE,
    intel: INTEL_NOVEL,
    amountBNB: config.SIGNIFICANT_TRANSFER_BNB,
    senderMemory: senderMemory({ recentEscrowCount: config.SENDER_BURST_COUNT }),
  };
  const a = runRules(input(over));
  const b = runRules(input(over));
  assert.deepEqual(a, b);
});

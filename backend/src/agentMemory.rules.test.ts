// ── Memory: what a past rejection is allowed to prove ─────────────────────────
// WHY THIS SUITE EXISTS
// ──────────────────────
// The rule engine rejects a recipient it has seen before (rule 13). That is only
// defensible if "seen before" means "positively identified as malicious", and the
// difference is not academic: a `fail_safe` row says the JUDGE COULD NOT ANALYSE the
// escrow, and an LLM-only rejection is an opinion with no rule behind it. Counting
// either as a malicious confirmation is how one Ollama outage becomes a permanent
// blacklist — the first outage rejects, the memory then reads "previously confirmed
// malicious", and every later hearing for that address is primed to reject it again.
//
// So the rule under test is an exclusion rule, and these tests are mostly about rows
// that must NOT count.

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { db, saveDecision } from "./db.js";
import {
  getAddressMemory,
  getSenderMemory,
  getSenderCounterparties,
  countRecentEscrowsBySender,
  readRuleContext,
  CONFIRMED_MALICIOUS_TRIGGER_RULES,
  type AddressMemory,
} from "./agentMemory.js";
import { finalizeReason } from "./securityPipeline.js";
import { unknownIntel } from "./bscscanChecker.js";
import { config } from "./config.js";

const SENDER = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
const RECIPIENT = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC";
const OTHER = "0x90F8bf6A479f320ead074411a4B0e7944Ea8c9C1";

let seq = 0;
function escrow(
  over: Partial<Parameters<typeof saveDecision>[0]> = {}
): Parameters<typeof saveDecision>[0] {
  seq += 1;
  return {
    escrowId: `0xtest${seq}`,
    sender: SENDER,
    recipient: RECIPIENT,
    amount: "1",
    eligible: false,
    confidence: 1,
    reasoning: "fixture",
    ...over,
  };
}

/** What the pipeline substitutes when a memory read fails: a shape the rules skip on. */
const emptyMemory = (): AddressMemory => ({
  totalSeen: 0,
  totalApproved: 0,
  totalRejected: 0,
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
});

/** A hard-rule rejection whose transcript records the rule that fired. */
function ruleReject(triggeredRule: string, over: Partial<Parameters<typeof saveDecision>[0]> = {}) {
  return escrow({
    decidedBy: "hard_rule",
    debate: { ruleEngine: { decision: "REJECT", triggeredRule, signals: [] } },
    ...over,
  });
}

beforeEach(() => {
  db.exec("DELETE FROM decisions");
  seq = 0;
});

// ── Rule 13: what counts as a malicious confirmation ───────────────────────────
test("memory: a hard GoPlus rejection confirms malice", () => {
  saveDecision(ruleReject("RULE_1_GOPLUS_MALICIOUS"));
  const m = getAddressMemory(RECIPIENT);
  assert.equal(m.confirmedMaliciousRejects, 1);
  assert.deepEqual(m.confirmedMaliciousRules, ["RULE_1_GOPLUS_MALICIOUS"]);
  assert.equal(m.totalRejected, 1);
});

test("memory: every rule in the confirmed set is a confirmation", () => {
  for (const rule of CONFIRMED_MALICIOUS_TRIGGER_RULES) {
    db.exec("DELETE FROM decisions");
    saveDecision(ruleReject(rule));
    assert.equal(
      getAddressMemory(RECIPIENT).confirmedMaliciousRejects,
      1,
      `${rule} must count as a confirmed malicious rejection`
    );
  }
});

test("memory: a fail_safe rejection is NOT a malicious confirmation", () => {
  // THE regression this whole field exists for: the judge could not analyse the escrow.
  saveDecision(escrow({ decidedBy: "fail_safe", debate: { ruleEngine: { triggeredRule: "FAIL_LLM_ERROR" } } }));
  const m = getAddressMemory(RECIPIENT);
  assert.equal(m.totalRejected, 1, "it is still a rejection");
  assert.equal(m.confirmedMaliciousRejects, 0, "but not a malicious confirmation");
  assert.equal(m.confirmedMaliciousRules.length, 0);
});

test("memory: an LLM-only rejection is NOT a malicious confirmation", () => {
  saveDecision(escrow({ decidedBy: "llm", confidence: 0.3 }));
  const m = getAddressMemory(RECIPIENT);
  assert.equal(m.totalRejected, 1);
  assert.equal(m.confirmedMaliciousRejects, 0);
});

test("memory: a hard rule with NO recorded rule id is NOT a confirmation", () => {
  // `decided_by = 'hard_rule'` alone cannot tell RULE_1 from a shape rule that has
  // since been downgraded. Without the recorded id there is no evidence, so no verdict.
  saveDecision(escrow({ decidedBy: "hard_rule" }));
  saveDecision(escrow({ decidedBy: "hard_rule", debate: {} }));
  saveDecision(escrow({ decidedBy: "hard_rule", debate: { ruleEngine: {} } }));
  assert.equal(getAddressMemory(RECIPIENT).confirmedMaliciousRejects, 0);
});

test("memory: a downgraded shape rule is NOT a confirmation", () => {
  // 2/6/7 reject on SHAPE. They are LLM signals now, and an old row naming one of them
  // must not be laundered into a malicious finding by the memory layer.
  for (const rule of [
    "RULE_2_NOVEL_EMPTY_ACCOUNT_SIGNIFICANT_AMOUNT",
    "RULE_6_CONTRACT_RECEIVER",
    "RULE_7_ZERO_BALANCE_SIGNIFICANT_AMOUNT",
  ]) {
    db.exec("DELETE FROM decisions");
    saveDecision(ruleReject(rule));
    const m = getAddressMemory(RECIPIENT);
    assert.equal(m.confirmedMaliciousRejects, 0, `${rule} must not confirm malice`);
    assert.equal(m.totalRejected, 1);
    assert.equal(m.hadHardRuleReject, true, "but it is still a strong rejection");
  }
});

test("memory: the GoPlus override is a confirmation", () => {
  saveDecision(escrow({ decidedBy: "override_malicious" }));
  saveDecision(ruleReject("OVERRIDE_GOPLUS_MALICIOUS"));
  assert.equal(getAddressMemory(RECIPIENT).confirmedMaliciousRejects, 2);
});

test("memory: a human veto is a confirmation", () => {
  // A person looking at the case and saying no is itself a positive finding.
  for (const decidedBy of ["human", "human_veto"]) {
    db.exec("DELETE FROM decisions");
    saveDecision(escrow({ decidedBy }));
    assert.equal(getAddressMemory(RECIPIENT).confirmedMaliciousRejects, 1, decidedBy);
  }
});

test("memory: a pending_human recommendation is neither a verdict nor a confirmation", () => {
  saveDecision(escrow({ decidedBy: "llm", status: "pending_human", eligible: false }));
  const m = getAddressMemory(RECIPIENT);
  assert.equal(m.totalSeen, 0, "a recommendation is not history");
  assert.equal(m.pendingHuman, 1);
  assert.equal(m.confirmedMaliciousRejects, 0);
});

test("memory: an approved escrow is never a rejection of any kind", () => {
  saveDecision(escrow({ eligible: true, decidedBy: "llm" }));
  const m = getAddressMemory(RECIPIENT);
  assert.equal(m.totalApproved, 1);
  assert.equal(m.totalRejected, 0);
  assert.equal(m.confirmedMaliciousRejects, 0);
  assert.equal(m.hadHardRuleReject, false);
});

test("memory: confirmations are counted per recipient, not globally", () => {
  saveDecision(ruleReject("RULE_1_GOPLUS_MALICIOUS"));
  const other = getAddressMemory(OTHER);
  assert.equal(other.totalSeen, 0);
  assert.equal(other.confirmedMaliciousRejects, 0);
});

test("memory: rule names are deduplicated for the audit trail, counts are not", () => {
  saveDecision(ruleReject("RULE_1_GOPLUS_MALICIOUS"));
  saveDecision(ruleReject("RULE_1_GOPLUS_MALICIOUS"));
  const m = getAddressMemory(RECIPIENT);
  assert.equal(m.confirmedMaliciousRejects, 2, "two events");
  assert.deepEqual(m.confirmedMaliciousRules, ["RULE_1_GOPLUS_MALICIOUS"], "one rule name");
});

test("memory: mixed history confirms only the malicious part", () => {
  saveDecision(ruleReject("RULE_12_LOCAL_DENYLIST"));
  saveDecision(escrow({ decidedBy: "fail_safe" }));
  saveDecision(escrow({ decidedBy: "llm", confidence: 0.4 }));
  saveDecision(ruleReject("RULE_6_CONTRACT_RECEIVER"));
  saveDecision(escrow({ decidedBy: "override_malicious" }));
  const m = getAddressMemory(RECIPIENT);
  assert.equal(m.totalSeen, 5);
  assert.equal(m.totalRejected, 5);
  assert.equal(m.confirmedMaliciousRejects, 2);
  assert.deepEqual(m.confirmedMaliciousRules.sort(), ["OVERRIDE_GOPLUS_MALICIOUS", "RULE_12_LOCAL_DENYLIST"]);
});

test("memory: an address with no history is all zeros, not a crash", () => {
  const m: AddressMemory = getAddressMemory(OTHER);
  assert.equal(m.totalSeen, 0);
  assert.equal(m.confirmedMaliciousRejects, 0);
  assert.equal(m.hadHardRuleReject, false);
  assert.deepEqual(m.recentDecisions, []);
});

// ── readRuleContext ───────────────────────────────────────────────────────────
test("readRuleContext: reads the rule id out of the transcript JSON", () => {
  const ctx = readRuleContext({
    ruleEngine: {
      decision: "NEEDS_LLM",
      triggeredRule: "RULE_2_NOVEL_EMPTY_ACCOUNT_SIGNIFICANT_AMOUNT",
      signals: [
        { rule: "RULE_2_NOVEL_EMPTY_ACCOUNT_SIGNIFICANT_AMOUNT", severity: "high", reason: "x" },
        { rule: "RULE_4_GOPLUS_UNAVAILABLE", severity: "medium", reason: "y" },
      ],
    },
  });
  assert.equal(ctx.triggeredRule, "RULE_2_NOVEL_EMPTY_ACCOUNT_SIGNIFICANT_AMOUNT");
  assert.deepEqual(ctx.signals, [
    "RULE_2_NOVEL_EMPTY_ACCOUNT_SIGNIFICANT_AMOUNT",
    "RULE_4_GOPLUS_UNAVAILABLE",
  ]);
});

test("readRuleContext: junk in, unknown out — never an exception", () => {
  for (const junk of [null, undefined, 42, "text", [], {}, { ruleEngine: null }, { ruleEngine: 7 }]) {
    const ctx = readRuleContext(junk);
    assert.equal(ctx.triggeredRule, null);
    assert.deepEqual(ctx.signals, []);
  }
});

test("readRuleContext: a blank rule id is no rule id", () => {
  assert.equal(readRuleContext({ ruleEngine: { triggeredRule: "   " } }).triggeredRule, null);
});

test("readRuleContext: malformed signal entries are dropped, not fatal", () => {
  const ctx = readRuleContext({
    ruleEngine: { triggeredRule: "RULE_1_GOPLUS_MALICIOUS", signals: [null, 3, "x", { rule: "RULE_4_GOPLUS_UNAVAILABLE" }] },
  });
  assert.deepEqual(ctx.signals, ["RULE_4_GOPLUS_UNAVAILABLE"]);
});

// ── Sender side ───────────────────────────────────────────────────────────────
test("sender memory: counts escrows, approvals and strong rejections", () => {
  saveDecision(escrow({ eligible: true, decidedBy: "llm" }));
  saveDecision(ruleReject("RULE_1_GOPLUS_MALICIOUS"));
  saveDecision(escrow({ decidedBy: "fail_safe" }));
  const s = getSenderMemory(SENDER);
  assert.equal(s.totalSent, 3);
  assert.equal(s.approved, 1);
  assert.equal(s.rejected, 2);
  assert.equal(s.strongRejections, 1, "only the hard rule is 'strong'");
});

test("sender memory: pending_human rows are not counted as sent", () => {
  saveDecision(escrow({ status: "pending_human", decidedBy: "llm" }));
  const s = getSenderMemory(SENDER);
  assert.equal(s.totalSent, 0);
  assert.equal(s.pendingHuman, 1);
});

test("sender memory: recentEscrowCount counts only the burst window", () => {
  saveDecision(escrow());
  saveDecision(escrow());
  saveDecision(escrow());
  assert.equal(getSenderMemory(SENDER).recentEscrowCount, 3);

  const s = getSenderMemory(SENDER);
  assert.equal(s.totalSent, 3, "the window is a subset, not the total");
});

test("sender memory: an old escrow falls out of the burst window", () => {
  // `created_at` is written by SQLite, so the window boundary has to be compared in
  // SQLite's own format. Comparing an ISO string with a "T" separator against
  // "YYYY-MM-DD HH:MM:SS" orders lexicographically and silently counts the wrong rows.
  saveDecision(escrow());
  db.prepare("UPDATE decisions SET created_at = datetime('now', '-1 day')").run();
  assert.equal(getSenderMemory(SENDER).recentEscrowCount, 0);
  assert.equal(getSenderMemory(SENDER).totalSent, 1);
});

test("sender memory: the burst window is configurable and is actually applied", () => {
  saveDecision(escrow());
  const since = new Date(Date.now() - config.SENDER_BURST_WINDOW_MIN * 60_000)
    .toISOString()
    .slice(0, 19)
    .replace("T", " ");
  assert.equal(countRecentEscrowsBySender(SENDER, since), 1);
  // A boundary in the future excludes everything: the window is a real filter, not a
  // comparison that happens to pass on rows written "now".
  const later = new Date(Date.now() + 60_000).toISOString().slice(0, 19).replace("T", " ");
  assert.equal(countRecentEscrowsBySender(SENDER, later), 0);
  assert.equal(countRecentEscrowsBySender(OTHER, since), 0, "and it is per sender");
});

test("sender memory: a sender with no history is all zeros", () => {
  const s = getSenderMemory(OTHER);
  assert.equal(s.totalSent, 0);
  assert.equal(s.recentEscrowCount, 0);
  assert.equal(s.strongRejections, 0);
  assert.deepEqual(s.rejectedRecipients, []);
});

// ── Counterparties (rule 14 needs this) ───────────────────────────────────────
test("counterparties: distinct recipients this sender has paid, lowercased", () => {
  saveDecision(escrow({ recipient: RECIPIENT }));
  saveDecision(escrow({ recipient: RECIPIENT.toUpperCase() }));
  saveDecision(escrow({ recipient: OTHER }));
  const list = getSenderCounterparties(SENDER);
  assert.equal(list.length, 2, "same address twice is one counterparty");
  assert.ok(list.includes(RECIPIENT.toLowerCase()));
  assert.ok(list.includes(OTHER.toLowerCase()));
});

test("counterparties: only this sender's history is returned", () => {
  saveDecision(escrow({ recipient: OTHER }));
  assert.deepEqual(getSenderCounterparties(SENDER), [OTHER.toLowerCase()]);
  assert.deepEqual(getSenderCounterparties(OTHER), [], "OTHER sent nothing");
});

test("counterparties: an unknown sender yields an empty list, not a throw", () => {
  assert.deepEqual(getSenderCounterparties(OTHER), []);
});

test("counterparties: the limit is clamped instead of trusted", () => {
  for (let i = 0; i < 5; i++) {
    saveDecision(escrow({ recipient: `0x${i.toString(16).padStart(2, "0")}${"0".repeat(38)}` }));
  }
  assert.equal(getSenderCounterparties(SENDER, 2).length, 2);
  assert.equal(getSenderCounterparties(SENDER, 0).length, 1, "a zero limit means at least one row");
});

// ── The on-chain Facts line: unreadable history is reported as unreadable ───────
// WHY HERE
// ───────
// The pipeline keeps an `emptyAddressMemory()` fallback so the rule engine can skip its
// history checks when a read fails. The reason string is built from the same escrow, and
// it is the one string that gets written ON-CHAIN — so if it were built from that
// fallback, a locked database would publish "AEGIS history = never before (first
// evaluation)" for an address with three prior rejections. The rules would have been
// correctly uncertain while the immutable record made a confident claim.
test("finalizeReason: an unreadable history is never written as 'first evaluation'", () => {
  const reason = finalizeReason("Recipient looks fine.", unknownIntel(), null);
  assert.match(reason, /AEGIS history = unavailable/);
  assert.doesNotMatch(reason, /never before|first evaluation/);
});

test("finalizeReason: a genuinely empty history still says first evaluation", () => {
  const reason = finalizeReason("Recipient looks fine.", unknownIntel(), emptyMemory());
  assert.match(reason, /AEGIS history = never before \(first evaluation\)/);
});

test("finalizeReason: an unreadable history does not rewrite the model's wording", () => {
  // The inverse correction needs a count to correct against. With no read there is
  // nothing to correct, so the text is left alone rather than invented.
  const reason = finalizeReason("This is the first evaluation.", unknownIntel(), null);
  assert.match(reason, /first evaluation/, "no fabricated count, no silent deletion");
  assert.match(reason, /AEGIS history = unavailable/, "but the Facts line still says so");
});

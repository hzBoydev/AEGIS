// ── Evidence-request flow: re-pass, Judge #2, and the budget around them ───────
// WHY A DEDICATE SUITE
// ─────────────────────
// `runSecurityPipeline` is wired to GoPlus, the RPC, Ollama and the DB, so the one
// part of it that has to be right under failure cannot be reached by calling it. The
// branch is therefore extracted into `resolveEvidenceRequest`, whose collaborators are
// parameters (`resolveEvidenceRequest.ts` → securityPipeline.ts). These tests are the
// contract for that branch, and they are mostly about FAILURE:
//
//   - a failed re-pass must NOT cost the escrow its ruling (Judge #2 is already paid
//     for, so it rules on the original Investigator);
//   - a failed Judge #2 must NOT buy a third Judge call (fail-safe, after the unused
//     reservation is handed back);
//   - neither may be able to push `budget.spent` past `budget.maxCalls`, or make it
//     count calls that never happened.
//
// The fakes charge the child ledger exactly as `runAgentLoop` does (one
// `tryReserve(1)` per LLM call), so the release arithmetic is exercised for real.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  resolveEvidenceRequest,
  type EvidenceCtx,
  type EvidenceDeps,
  type EvidenceStreamEvent,
} from "./securityPipeline.js";
import { parseJudgeOutcome, type LLMDecision, type LLMInput, type JudgeOutcome } from "./aiAnalyzer.js";
import { LlmBudget } from "./llmBudget.js";
import { createToolContext } from "./tools.js";
import { unknownIntel } from "./bscscanChecker.js";

const SENDER = "0x1111111111111111111111111111111111111111";
const RECIPIENT = "0x2222222222222222222222222222222222222222";
/** `focusedRepassLedgerSize(1)` — the default config's worst case for ONE re-pass. */
const REPASS_LEDGER_SIZE = 2;
/** `evidenceRequestReservation()` — the re-pass ledger AND Judge #2, as one unit. */
const RESERVATION = REPASS_LEDGER_SIZE + 1;

// ── Fixtures ──────────────────────────────────────────────────────────────────

function decision(over: Partial<LLMDecision> = {}): LLMDecision {
  return {
    eligible: false,
    confidence: 0.6,
    riskLevel: "MEDIUM",
    reason: "baseline assessment",
    needsData: [],
    ...over,
  };
}

function ruling(over: Partial<LLMDecision> = {}): JudgeOutcome {
  return { kind: "ruling", ...decision(over) };
}

interface RepassStep {
  /**
   * LLM calls this re-pass run charges the child ledger (default 1).
   *
   * Charged BEFORE the scripted outcome, exactly as `runAgentLoop` reserves before it
   * calls the model — so `spend: 1, throws` is a re-pass that failed with the call
   * already paid for, and `spend: 0, throws` is one that never reached the model.
   */
  spend?: number;
  result?: LLMDecision;
  throws?: Error;
}

interface JudgeStep {
  result?: JudgeOutcome;
  throws?: Error;
}

interface Harness {
  deps: EvidenceDeps;
  ctx: EvidenceCtx;
  events: EvidenceStreamEvent[];
  budget: LlmBudget;
  investigator: LLMDecision;
  /** Every `tryReserve(n)` the branch ATTEMPTED on the escrow budget, in order. */
  reservations: number[];
  /** The subset of those that were GRANTED (a refused reservation charges nothing). */
  granted: number[];
  /** Focus argument of each re-pass invocation. */
  repassFocus: (string | undefined)[];
  /** The Investigator argument of each Judge invocation. */
  judgeArgs: LLMDecision[];
  /** `allowRequestEvidence` of each Judge invocation (undefined = closed). */
  judgeOptions: (boolean | undefined)[];
  /** The child ledger the re-pass was given, so a test can read what it spent. */
  repassLedger: () => LlmBudget;
  /** LLM calls the fakes actually PERFORMED (ledger charges + Judge attempts). */
  llmCalls: () => number;
  labels: () => string[];
  run: () => ReturnType<typeof resolveEvidenceRequest>;
}

function harness(opts: {
  maxCalls?: number;
  usedBefore?: number;
  repassEnabled?: boolean;
  investigator?: LLMDecision;
  repass?: RepassStep[];
  judge?: JudgeStep[];
} = {}): Harness {
  const budget = new LlmBudget(opts.maxCalls ?? 12);
  const usedBefore = opts.usedBefore ?? 0;
  for (let i = 0; i < usedBefore; i++) budget.tryReserve(1);

  const events: EvidenceStreamEvent[] = [];
  const reservations: number[] = [];
  const granted: number[] = [];
  const repassFocus: (string | undefined)[] = [];
  const judgeArgs: LLMDecision[] = [];
  const judgeOptions: (boolean | undefined)[] = [];
  const repassQueue = [...(opts.repass ?? [])];
  const judgeQueue = [...(opts.judge ?? [])];
  let llmCalls = 0;
  let childLedger: LlmBudget | null = null;

  // Spy on the escrow budget's reservations: `tryReserve` is what decides whether
  // the branch can afford the pair, so "no extra reservation" is an assertable fact.
  // A REFUSED reservation still counts as an attempt — the pair being unaffordable is
  // a refusal, not an absence — so both lists are kept.
  const realTryReserve = budget.tryReserve.bind(budget);
  budget.tryReserve = (calls = 1) => {
    reservations.push(calls);
    const result = realTryReserve(calls);
    if (result.ok) granted.push(calls);
    return result;
  };

  const fakeRepass: EvidenceDeps["runFocusedRepass"] = async (
    _input,
    _investigator,
    _advocate,
    _toolCtx,
    ledger,
    _hooks,
    focus
  ) => {
    childLedger = ledger;
    repassFocus.push(focus);
    const step = repassQueue.shift();
    if (step === undefined) throw new Error("re-pass fake: no scripted step left");
    // Same charging as `runAgentLoop`: one reservation per LLM call, refused if the
    // child ledger cannot pay it.
    for (let i = 0; i < (step.spend ?? 1); i++) {
      if (!ledger.tryReserve(1).ok) throw new Error("re-pass fake: ledger refused a call");
      llmCalls += 1;
    }
    if (step.throws !== undefined) throw step.throws;
    return step.result ?? decision({ reason: "re-pass verdict", confidence: 0.55 });
  };

  const fakeJudge: EvidenceDeps["callJudge"] = async (
    _input,
    investigator,
    _advocate,
    _toolResults,
    options
  ) => {
    // Counted on entry: an ATTEMPTED Judge call is a spent call (see Bug A) — if this
    // throws, the branch must still charge the escrow for it.
    llmCalls += 1;
    judgeArgs.push(investigator);
    judgeOptions.push(options?.allowRequestEvidence);
    const step = judgeQueue.shift();
    if (step === undefined) throw new Error("judge fake: no scripted step left");
    if (step.throws !== undefined) throw step.throws;
    return step.result ?? ruling({ reason: "judge verdict", confidence: 0.7 });
  };

  const investigator = opts.investigator ?? decision();
  const llmInput: LLMInput = {
    sender: SENDER,
    recipient: RECIPIENT,
    amountBNB: 1,
    security: { status: "clean", riskFlags: [], hardFlags: [], softFlags: [], source: "goplus" },
    intel: unknownIntel(),
  };

  const deps: EvidenceDeps = {
    budget,
    repassEnabled: opts.repassEnabled ?? true,
    repassLedgerSize: REPASS_LEDGER_SIZE,
    repassReservation: RESERVATION,
    runFocusedRepass: fakeRepass,
    callJudge: fakeJudge,
    publish: (event) => {
      events.push(event);
    },
    finalize: (reason) => `finalized: ${reason}`,
  };

  const ctx: EvidenceCtx = {
    escrowId: "escrow-evidence-test",
    llmInput,
    investigator,
    advocate: null,
    toolCtx: createToolContext(SENDER, RECIPIENT),
    toolResultsBlock: "TOOL RESULTS BLOCK",
    onAgentStep: () => {},
  };

  return {
    deps,
    ctx,
    events,
    budget,
    investigator,
    reservations,
    granted,
    repassFocus,
    judgeArgs,
    judgeOptions,
    repassLedger: () => {
      assert.notEqual(childLedger, null, "the re-pass fake was never called");
      return childLedger as LlmBudget;
    },
    llmCalls: () => llmCalls,
    labels: () => events.map((e) => e.label),
    run: () =>
      resolveEvidenceRequest(deps, ctx, {
        focus: "has the recipient used AEGIS before",
        reason: "AEGIS history is missing",
      }),
  };
}

// ── 1. Judge #1 rules → the evidence branch is never entered ──────────────────

test("evidence flow: a Judge #1 RULING does not open the evidence branch", () => {
  const parsed = parseJudgeOutcome(
    JSON.stringify({ eligible: true, confidence: 0.8, riskLevel: "LOW", reason: "clean" }),
    true
  );
  assert.equal(parsed.kind, "ruling");

  // The pipeline enters `resolveEvidenceRequest` on exactly this condition, so a
  // ruling can reach neither the re-pass nor a second Judge call.
  const opensEvidenceBranch = (outcome: JudgeOutcome): boolean =>
    outcome.kind === "request_evidence";
  assert.equal(opensEvidenceBranch(parsed), false);
  const asked = parseJudgeOutcome(
    JSON.stringify({ action: "request_evidence", focus: "is it a known actor", reason: "gap" }),
    true
  );
  assert.equal(opensEvidenceBranch(asked), true, "a request MUST open the branch");

  // Fakes armed to throw if they are ever reached: on the ruling path they are not.
  const h = harness({
    repass: [{ throws: new Error("re-pass must not run on a first-round ruling") }],
    judge: [{ throws: new Error("there is no Judge #2 on a first-round ruling") }],
  });
  assert.equal(opensEvidenceBranch(parsed), false);
  assert.deepEqual(h.repassFocus, []);
  assert.deepEqual(h.judgeArgs, []);
  assert.deepEqual(h.reservations, []);
  assert.equal(h.budget.used, 0);
});

// ── 2. Happy path ─────────────────────────────────────────────────────────────

test("evidence flow: re-pass answers the focus, Judge #2 rules on it", async () => {
  const second = ruling({ eligible: true, confidence: 0.82, reason: "the re-pass cleared it" });
  const h = harness({
    repass: [{ spend: 1, result: decision({ eligible: true, confidence: 0.78 }) }],
    judge: [{ result: second }],
  });

  const res = await h.run();

  assert.deepEqual(h.repassFocus, ["has the recipient used AEGIS before"], "focus must reach the re-pass");
  assert.equal(h.judgeArgs.length, 1);
  assert.equal(h.judgeOptions[0], undefined, "Judge #2 must be offered no evidence option");
  assert.equal(res.judge, second, "the final ruling is Judge #2's");
  assert.equal(res.failSafeReason, null);
  assert.equal(res.leanSplitSource, "focused_repass");
  assert.equal(res.judgeCalls, 1, "exactly one Judge call inside this branch");
  assert.notEqual(h.judgeArgs[0], h.investigator, "the Judge rules on the RE-PASS assessment");
  assert.equal(res.focusedRepass?.eligible, true);
  assert.equal(res.evidenceRequest.skippedBecause, undefined, "the re-pass ran");
  assert.deepEqual(h.granted, [RESERVATION], "one pair reservation, no more");
  assert.ok(h.labels().includes("Judge re-deciding after the focused re-pass"));
  assert.ok(h.labels().includes("Judge (revised): RULING RELEASE"));
});

// ── 3. Judge #2 asks for evidence a second time ──────────────────────────────

test("evidence flow: Judge #2 returning request_evidence fails safe, no third call", async () => {
  const secondRequest: JudgeOutcome = {
    kind: "request_evidence",
    focus: "something else entirely",
    reason: "still unclear",
  };
  const h = harness({
    repass: [{ spend: 1 }],
    judge: [{ result: secondRequest }],
  });

  const res = await h.run();

  assert.notEqual(res.failSafeReason, null, "a second request cannot be acted on");
  assert.equal(res.judge, null, "no ruling ⇒ the caller fails safe");
  assert.equal(res.judgeCalls, 1, "exactly 2 Judge calls per escrow: #1 + #2, never #3");
  assert.equal(h.judgeArgs.length, 1);
  assert.ok(
    !h.labels().includes("Judge ruling without a further evidence round"),
    "the forced-ruling path must not run once the pair was paid for"
  );
  assert.ok(h.labels().includes("Judge's final ruling failed"));
  assert.equal(
    h.budget.used,
    2,
    "the re-pass call + the Judge #2 attempt; the unused reservation is handed back"
  );
  assert.ok(h.budget.used <= h.budget.maxCalls);
});

// ── 4. Judge #2 throws (Bug A: the attempted call is still charged) ───────────

test("evidence flow: Judge #2 throwing fails safe and still spends the call", async () => {
  const h = harness({
    usedBefore: 4,
    repass: [{ spend: REPASS_LEDGER_SIZE }],
    judge: [{ throws: new Error("ollama returned garbage") }],
  });

  const res = await h.run();

  assert.notEqual(res.failSafeReason, null);
  assert.match(res.failSafeReason ?? "", /final ruling after the evidence round failed/);
  assert.equal(res.judge, null);
  assert.equal(h.judgeArgs.length, 1, "a failed final ruling is not retried");
  // Bug A: the Judge #2 call is charged BEFORE the await, so a throw after the model
  // answered cannot hand the call back to the budget.
  assert.equal(
    h.budget.used,
    4 + h.repassLedger().used + 1,
    "spent = calls before the branch + re-pass calls + the Judge #2 attempt"
  );
  assert.equal(h.budget.used, 4 + REPASS_LEDGER_SIZE + 1);
  assert.ok(h.labels().includes("Judge's final ruling failed"));
  assert.deepEqual(
    h.granted,
    [RESERVATION],
    "the fail-safe must not reserve anything after the pair was already paid for"
  );
});

// ── 5. Re-pass throws → Judge #2 rules on the ORIGINAL investigator ───────────

test("evidence flow: a failed re-pass is recovered by Judge #2 on the original evidence", async () => {
  const second = ruling({ eligible: false, confidence: 0.66, reason: "insufficient either way" });
  const h = harness({
    repass: [{ spend: 0, throws: new Error("tool context died") }],
    judge: [{ result: second }],
  });

  const res = await h.run();

  assert.equal(h.judgeArgs.length, 1, "Judge #2 still runs");
  assert.equal(h.judgeArgs[0], h.investigator, "it rules on the ORIGINAL investigator object");
  assert.equal(res.judge, second);
  assert.equal(res.failSafeReason, null, "a failed re-pass must not fail the escrow");
  assert.equal(res.focusedRepass, null);
  assert.equal(res.leanSplitSource, "investigator");
  assert.equal(res.evidenceRequest.skippedBecause, "repass_failed");
  assert.equal(res.judgeCalls, 1);
  assert.deepEqual(
    h.granted,
    [RESERVATION],
    "Judge #2 is PAID FOR — recovering must not ask the budget for a second reservation"
  );
  assert.equal(h.repassLedger().used, 0, "the re-pass never reached the model");
  assert.equal(h.budget.used, 1, "only the Judge #2 call really happened — the pair is released back");
  assert.ok(h.labels().includes("Focused re-pass failed — Judge rules on the original evidence"));
  assert.ok(
    !h.labels().includes("Evidence request cannot be granted — LLM call budget exhausted"),
    "a failed re-pass is not a budget problem"
  );
});

// ── 6. Re-pass disabled ──────────────────────────────────────────────────────

test("evidence flow: re-pass disabled ⇒ the Judge still rules, option closed", async () => {
  const forced = ruling({ eligible: true, confidence: 0.71, reason: "ruling without the extra evidence" });
  const h = harness({
    repassEnabled: false,
    repass: [{ throws: new Error("the re-pass must not run when disabled") }],
    judge: [{ result: forced }],
  });

  const res = await h.run();

  assert.deepEqual(h.repassFocus, [], "no re-pass when it is disabled");
  assert.equal(h.judgeArgs.length, 1);
  assert.equal(h.judgeArgs[0], h.investigator);
  assert.equal(h.judgeOptions[0], undefined, "the forced ruling is made with the option closed");
  assert.equal(res.evidenceRequest.skippedBecause, "disabled");
  assert.equal(res.judge, forced);
  assert.equal(res.failSafeReason, null);
  assert.equal(res.leanSplitSource, "investigator");
  assert.equal(res.judgeCalls, 1);
  assert.deepEqual(h.granted, [1], "the forced ruling reserves its own single call");
  assert.ok(h.labels().includes("Evidence request cannot be granted — re-pass disabled"));
});

// ── 7. Budget one short of the pair ──────────────────────────────────────────

test("evidence flow: one call short of the pair ⇒ forced ruling, still within budget", async () => {
  // Remaining = maxCalls - usedBefore = 2, one short of the pair (3).
  const h = harness({
    usedBefore: 10,
    maxCalls: 12,
    repass: [{ throws: new Error("the re-pass must not run when the pair is unaffordable") }],
    judge: [{ result: ruling({ reason: "ruling on what we have" }) }],
  });

  const res = await h.run();

  assert.deepEqual(h.repassFocus, []);
  assert.deepEqual(
    h.reservations,
    [RESERVATION, 1],
    "the pair is attempted, refused, and only the forced ruling is reserved"
  );
  assert.deepEqual(h.granted, [1], "the refused pair reserved nothing");
  assert.equal(res.evidenceRequest.skippedBecause, "budget");
  assert.equal(res.failSafeReason, null);
  assert.notEqual(res.judge, null, "the escrow still gets a ruling — never a bare release");
  assert.equal(res.judgeCalls, 1);
  assert.equal(h.budget.used, 11);
  assert.ok(h.budget.used <= h.budget.maxCalls);
  assert.ok(h.labels().includes("Evidence request cannot be granted — LLM call budget exhausted"));
});

test("evidence flow: nothing affordable at all ⇒ fail-safe, budget respected", async () => {
  const h = harness({
    usedBefore: 12,
    maxCalls: 12,
    repass: [{ throws: new Error("must not run") }],
    judge: [{ throws: new Error("must not run") }],
  });

  const res = await h.run();

  assert.equal(res.evidenceRequest.skippedBecause, "budget");
  assert.notEqual(res.failSafeReason, null, "no ruling and no budget ⇒ fail safe");
  assert.equal(res.judge, null, "an evidence request is never a release");
  assert.equal(res.judgeCalls, 0);
  assert.deepEqual(h.judgeArgs, [], "no Judge call may be started unreserved");
  assert.equal(h.budget.used, 12);
  assert.equal(h.budget.used, h.budget.maxCalls);
});

// ── 8. Ceiling property ──────────────────────────────────────────────────────

test("evidence flow: every path stays inside the ceiling and counts real calls", async () => {
  const scenarios = [
    {
      name: "happy path",
      opts: { usedBefore: 0, maxCalls: 12 },
      repass: [{ spend: REPASS_LEDGER_SIZE }],
      judge: [{}],
    },
    {
      name: "Judge #2 asks again",
      opts: { usedBefore: 0, maxCalls: 12 },
      repass: [{ spend: REPASS_LEDGER_SIZE }],
      judge: [{ result: { kind: "request_evidence", focus: "more", reason: "still unclear" } as JudgeOutcome }],
    },
    {
      name: "Judge #2 throws",
      opts: { usedBefore: 0, maxCalls: 12 },
      repass: [{ spend: REPASS_LEDGER_SIZE }],
      judge: [{ throws: new Error("garbage") }],
    },
    {
      name: "re-pass throws",
      opts: { usedBefore: 0, maxCalls: 12 },
      repass: [{ throws: new Error("tool died") }],
      judge: [{}],
    },
    {
      name: "re-pass disabled",
      opts: { usedBefore: 0, maxCalls: 12, repassEnabled: false },
      repass: [{ spend: REPASS_LEDGER_SIZE }],
      judge: [{}],
    },
    {
      name: "one short of the pair",
      opts: { usedBefore: 10, maxCalls: 12 },
      repass: [{ spend: REPASS_LEDGER_SIZE }],
      judge: [{}],
    },
    {
      name: "nothing affordable",
      opts: { usedBefore: 12, maxCalls: 12 },
      repass: [{ spend: REPASS_LEDGER_SIZE }],
      judge: [{}],
    },
  ] as const;

  for (const s of scenarios) {
    const h = harness({
      maxCalls: s.opts.maxCalls,
      usedBefore: s.opts.usedBefore,
      repassEnabled: "repassEnabled" in s.opts ? s.opts.repassEnabled : true,
      repass: [...s.repass],
      judge: [...s.judge],
    });
    const res = await h.run();

    assert.ok(
      h.budget.used <= h.budget.maxCalls,
      `${s.name}: spent ${h.budget.used} of ${h.budget.maxCalls}`
    );
    assert.equal(
      h.budget.used,
      s.opts.usedBefore + h.llmCalls(),
      `${s.name}: the ledger must count exactly the calls that happened`
    );
    assert.equal(res.judge !== null, res.failSafeReason === null, `${s.name}: ruling ⇔ no fail-safe`);
    assert.ok(res.judgeCalls <= 1, `${s.name}: at most one Judge call in this branch`);
  }
});

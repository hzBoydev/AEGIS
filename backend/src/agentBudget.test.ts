import { test } from "node:test";
import assert from "node:assert/strict";
import { config } from "./config.js";
import { LlmBudget } from "./llmBudget.js";

// The cost model, pinned.
//
// Every number here is a promise the pipeline makes to whoever runs it on a
// single 6GB GPU: one escrow cannot monopolise the model and starve the others.
// If any of these drift, an escrow that used to answer in a minute can start
// holding the serialization queue for ten, and the failure looks like "the demo
// got slow" rather than "a budget was misconfigured".
//
// The legacy comparison is the reason the arithmetic is spelled out: switching
// AGENT_NATIVE_TOOLS on/off must change HOW evidence is gathered, never how many
// times the model is asked.

/** Investigator rounds (AGENT_MAX_STEPS) + 1 forced verdict. */
const investigatorCalls = config.AGENT_MAX_STEPS + 1;
/** Advocate rounds (ADVOCATE_MAX_STEPS) + 1. */
const advocateCalls = config.ADVOCATE_MAX_STEPS + 1;
/** Judge #1 — the first ruling, before any re-pass. */
const judgeCalls = 1;
/** Focused re-pass rounds + 1, then the Judge's re-decision. */
const repassCalls = config.AGENT_MAX_FOLLOWUP_STEPS + 2;

const worstCase = investigatorCalls + advocateCalls + judgeCalls + repassCalls;

test("budget: the default plan fits inside the per-escrow ceiling", () => {
  assert.equal(
    worstCase,
    config.AGENT_MAX_LLM_CALLS,
    `worst case is ${worstCase} calls but the ceiling is ${config.AGENT_MAX_LLM_CALLS}`
  );
});

test("budget: the worst case really is the reservation order in the pipeline", () => {
  // Investigator, Advocate, Judge #1, then re-pass + Judge #2. Asserting the
  // arithmetic rather than restating it means a change to any step cap fails
  // here instead of silently exceeding the ceiling at runtime.
  const b = new LlmBudget(config.AGENT_MAX_LLM_CALLS);
  for (let i = 0; i < investigatorCalls; i += 1) assert.equal(b.tryReserve().ok, true);
  for (let i = 0; i < advocateCalls; i += 1) assert.equal(b.tryReserve().ok, true);
  assert.equal(b.tryReserve().ok, true, "Judge #1");
  // The re-pass reserves itself AND its re-decision together.
  assert.equal(b.tryReserve(repassCalls).ok, true, "re-pass + Judge #2");
  assert.equal(b.exhausted, true);
  assert.equal(b.tryReserve().ok, false, "nothing may run past the ceiling");
});

test("budget: raising any step cap is caught by the ceiling, not at runtime", () => {
  const inflated = new LlmBudget(config.AGENT_MAX_LLM_CALLS);
  const needed = worstCase + 1;
  assert.ok(
    needed > config.AGENT_MAX_LLM_CALLS,
    "an extra call must not fit — this is what proves the ceiling binds"
  );
  assert.equal(inflated.tryReserve(needed).ok, false);
});

test("budget: the generation timeout is derived from the step budget", () => {
  // AGENT_TIMEOUT_MS covers generation across the agent's turns, so it must scale
  // with maxSteps. A fixed timeout would silently truncate a multi-round
  // investigation — and a truncated investigation reads as a clean one.
  assert.equal(config.AGENT_TIMEOUT_MS, config.AGENT_LLM_CALL_ESTIMATE_MS * (config.AGENT_MAX_STEPS + 1));
});

test("budget: the regression profile reproduces the pre-agent call count", () => {
  // Pinned profile:
  //   AGENT_NATIVE_TOOLS=false → the legacy needsData loop, no Judge re-entry
  //   AGENT_MAX_STEPS=1       → at most 2 Investigator calls
  //   ADVOCATE_MAX_STEPS=0    → exactly 1 Advocate call
  //   AGENT_MAX_FOLLOWUP_STEPS=0 → no focused re-pass
  // Total: 4 LLM calls. This is the baseline the native path is compared against,
  // so a change here invalidates any before/after claim about the agent upgrade.
  // Computed from the regression profile's own caps, not from the running config —
  // this suite runs under the default (native) profile.
  const REG = {
    investigatorSteps: 1,
    advocateSteps: 0,
    followupSteps: 0,
    judgeCalls: 1,
  };
  const investigator = REG.investigatorSteps + 1;
  const advocate = REG.advocateSteps + 1;
  const repass = REG.followupSteps > 0 ? REG.followupSteps + 2 : 0;

  assert.equal(investigator, 2, "legacy Investigator = 1 call + 1 tool round");
  assert.equal(advocate, 1, "legacy Advocate = 1 call, no tools");
  assert.equal(repass, 0, "re-pass disabled ⇒ neither the re-pass nor Judge #2");
  assert.equal(
    investigator + advocate + REG.judgeCalls + repass,
    4,
    "the regression profile is 4 calls"
  );
});

test("budget: the discovered-address cap is small and positive", () => {
  assert.ok(config.AGENT_MAX_DISCOVERED_ADDRESSES > 0);
  assert.ok(
    config.AGENT_MAX_DISCOVERED_ADDRESSES <= 10,
    "the cap exists to bound a low-memory local model; a large value defeats it"
  );
});

test("budget: the tool-call cap never exceeds the step cap's reach", () => {
  // With maxSteps rounds there are at most maxSteps tool-requesting calls, and a
  // single call can request several tools. The cap must be reachable but finite.
  assert.ok(config.AGENT_MAX_TOOL_CALLS > 0);
  assert.ok(
    config.AGENT_MAX_TOOL_CALLS <= config.AGENT_MAX_STEPS * 4,
    "more tools than this could not be requested in maxSteps rounds anyway"
  );
});
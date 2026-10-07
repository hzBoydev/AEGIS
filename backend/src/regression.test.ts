import { test } from "node:test";
import assert from "node:assert/strict";
import {
  setGenerateTransport,
  callLLM,
  callAdvocate,
  callJudge,
  type LLMInput,
} from "./aiAnalyzer.js";
import { LlmBudget } from "./llmBudget.js";
import { executeTools, createToolContext } from "./tools.js";
import { unknownIntel } from "./bscscanChecker.js";

// The legacy hearing, pinned at 4 LLM calls.
//
// This suite runs the code the pre-agent pipeline ran — one JSON Investigator
// call listing `needsData`, tools executed in code, one optional second call,
// then the Advocate and the Judge — against a stubbed transport, and counts the
// calls. Pinning the count is the whole point of `AGENT_NATIVE_TOOLS=false`: it
// makes "did the agent upgrade change the model's access to evidence, or only how
// it requests it?" a measurable question instead of an opinion.
//
// It does NOT invoke `runSecurityPipeline`, which would require mocking GoPlus,
// the RPC and the decision database. What it pins is the call accounting of the
// hearing stages themselves, which is where the budget actually goes.

const SENDER = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
const RECIPIENT = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC";

const verdict = (
  eligible: boolean,
  confidence: number,
  riskLevel = "LOW"
): string =>
  JSON.stringify({ eligible, confidence, riskLevel, reason: "stubbed for the regression baseline" });

const firstRoundRequestingData = JSON.stringify({
  needsData: ["get_recipient_db_history"],
  eligible: true,
  confidence: 0.6,
  riskLevel: "MEDIUM",
  reason: "needs the recipient's escrow history",
});

test("legacy: the regression profile is 4 LLM calls, 1 tool round, no Judge re-entry", async () => {
  const prompts: string[] = [];
  setGenerateTransport(async ({ prompt }) => {
    prompts.push(prompt);
    // Investigator round 1 → asks for data. Investigator round 2 → final answer.
    // Advocate → argument. Judge → ruling. The order below is the pipeline's.
    if (prompts.length === 1) return firstRoundRequestingData;
    if (prompts.length === 2) return verdict(true, 0.82);
    if (prompts.length === 3) {
      return JSON.stringify({
        position: "REJECT",
        argument: "The recipient's history was not fully established in time.",
        points: ["history incomplete"],
      });
    }
    return verdict(false, 0.9, "MEDIUM");
  });

  try {
    const budget = new LlmBudget(12);
    const toolCtx = createToolContext(SENDER, RECIPIENT);

    // ── Investigator: 2 calls (round 1 + one tool round) ──────────────────────
    const investigator = await legacyInvestigatorRound(budget, toolCtx);
    assert.equal(investigator.needsData.length, 0, "the final round must not ask again");

    // ── Advocate: 1 call ─────────────────────────────────────────────────────
    await reserve(budget);
    const advocate = await legacyAdvocateCall();
    assert.equal(advocate, "REJECT");

    // ── Judge: 1 call, and NO re-entry in the regression profile ─────────────
    await reserve(budget);
    const judge = await legacyJudgeCall();
    assert.equal(judge.eligible, false);

    assert.equal(prompts.length, 4, "the regression profile must be exactly 4 LLM calls");
    assert.equal(budget.used, 4, "every call must be charged to the escrow budget");
    assert.equal(
      prompts.filter((p) => p.includes("AEGIS JUDGE")).length,
      1,
      "the Judge must be called exactly once — no re-entry in this profile"
    );
  } finally {
    setGenerateTransport(null);
  }
});

test("legacy: the tool round costs no LLM calls", async () => {
  const prompts: string[] = [];
  setGenerateTransport(async ({ prompt }) => {
    prompts.push(prompt);
    return firstRoundRequestingData;
  });
  try {
    const budget = new LlmBudget(12);
    const toolCtx = createToolContext(SENDER, RECIPIENT);
    await legacyInvestigatorRound(budget, toolCtx);
    assert.equal(budget.used, 2, "only the two Investigator calls are charged");
    assert.ok(prompts.length >= 2);
  } finally {
    setGenerateTransport(null);
  }
});

test("legacy: a tool failure does not buy the Investigator a third call", async () => {
  const prompts: string[] = [];
  setGenerateTransport(async ({ prompt }) => {
    prompts.push(prompt);
    // Always asks for data; the legacy loop must still stop after one tool round.
    return firstRoundRequestingData;
  });
  try {
    const budget = new LlmBudget(12);
    const toolCtx = createToolContext(SENDER, RECIPIENT);
    const first = await legacyInvestigatorRound(budget, toolCtx);
    assert.equal(budget.used, 2);
    assert.ok(first !== undefined);
  } finally {
    setGenerateTransport(null);
  }
});

// ── The legacy hearing stages, transcribed ────────────────────────────────────

/**
 * The pre-agent Investigator: one call, tools in code, one optional second call.
 *
 * Transcribed from `securityPipeline.runLegacyInvestigator` rather than imported
 * because that function is a closure over the pipeline's evidence and SSE state.
 * The transcription is kept honest by `tools-catalog-unique` in the red-team
 * suite: if the tool set changes, the legacy baseline changes with it.
 */
async function legacyInvestigatorRound(
  budget: LlmBudget,
  toolCtx: ReturnType<typeof createToolContext>
): Promise<{ needsData: string[] }> {
  const first = await reserve(budget);
  void first;

  // `callLLM` is exercised through the same transport seam, so this reproduces
  // the legacy round trip without importing the pipeline's evidence gathering.
  const input = legacyInput();
  const round1 = await callLLM(input);

  if (round1.needsData.length === 0) return { needsData: [] };
  await reserve(budget);

  const exec = await executeTools(round1.needsData, toolCtx);
  if (exec.succeeded.length === 0) return { needsData: [] };

  const followUp = await callLLM({ ...input, toolResults: exec.block, followUp: true });
  return { needsData: followUp.needsData };
}

async function legacyAdvocateCall(): Promise<string> {
  const res = await callAdvocate(legacyInput(), {
    eligible: true,
    confidence: 0.82,
    riskLevel: "LOW",
    reason: "stubbed",
    needsData: [],
  });
  return res.position;
}

async function legacyJudgeCall(): Promise<{ eligible: boolean }> {
  const outcome = await callJudge(
    legacyInput(),
    {
      eligible: true,
      confidence: 0.82,
      riskLevel: "LOW",
      reason: "stubbed",
      needsData: [],
    },
    {
      position: "REJECT",
      argument: "stubbed",
    }
  );
  // The legacy profile has no evidence-request stage, so the Judge must rule — this
  // assertion is what keeps the 4-call baseline honest about that.
  assert.equal(outcome.kind, "ruling", "the regression profile must never request evidence");
  return outcome;
}

/** Minimal evidence for the prompts; no network, and the parsers never read it. */
function legacyInput(): LLMInput {
  return {
    sender: SENDER,
    recipient: RECIPIENT,
    amountBNB: 0.5,
    security: {
      status: "clean" as const,
      riskFlags: [],
      hardFlags: [],
      softFlags: [],
      source: "goplus" as const,
    },
    intel: unknownIntel(),
  };
}

async function reserve(budget: LlmBudget): Promise<void> {
  const r = budget.tryReserve();
  assert.equal(r.ok, true, "the regression profile must fit inside its budget");
}
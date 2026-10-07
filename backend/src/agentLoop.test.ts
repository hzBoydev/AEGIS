import { test } from "node:test";
import assert from "node:assert/strict";
import { runAgentLoop, type ChatTransport } from "./agentLoop.js";
import { createToolContext, type ToolContext } from "./tools.js";
import { LlmBudget } from "./llmBudget.js";
import type { ChatMessage, ChatResult } from "./ollamaChat.js";

const SENDER = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
const RECIPIENT = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC";

const newCtx = (): ToolContext => createToolContext(SENDER, RECIPIENT);

/** A verdict the real parser would accept. */
const VERDICT = JSON.stringify({
  eligible: true,
  confidence: 0.8,
  riskLevel: "LOW",
  reason: "ok",
});

interface StubCall {
  messages: ChatMessage[];
  withTools: boolean;
}

/**
 * A transport that replays a scripted sequence and records what it was asked.
 *
 * The loop must be fully exercisable without a GPU: every edge case that matters
 * here (budget exhaustion, malformed tool calls, unparseable answers) is a case
 * where waiting for a real model to misbehave is not a test plan.
 */
function stubTransport(script: ChatResult[]): { transport: ChatTransport; calls: StubCall[] } {
  const calls: StubCall[] = [];
  let i = 0;
  const transport: ChatTransport = async (messages, opts) => {
    calls.push({ messages: [...messages], withTools: opts.withTools === true });
    const next = script[Math.min(i, script.length - 1)];
    i += 1;
    return (
      next ?? {
        content: VERDICT,
        toolCalls: [],
        usage: { promptTokens: 0, completionTokens: 0, truncated: false, nearContextLimit: false },
        generationMs: 0,
      }
    );
  };
  return { transport, calls };
}

const result = (over: Partial<ChatResult> = {}): ChatResult => ({
  content: "",
  toolCalls: [],
  usage: { promptTokens: 0, completionTokens: 0, truncated: false, nearContextLimit: false },
  generationMs: 0,
  ...over,
});

const seed: ChatMessage[] = [
  { role: "system", content: "You are the Investigator." },
  { role: "user", content: "Assess this escrow." },
];

// ── Termination ───────────────────────────────────────────────────────────────

test("loop: maxSteps=0 makes exactly one call and never offers tools", async () => {
  const { transport, calls } = stubTransport([result({ content: VERDICT })]);
  const res = await runAgentLoop(seed, {
    toolContext: newCtx(),
    maxSteps: 0,
    label: "t",
  }, { chat: transport });

  assert.equal(calls.length, 1, "maxSteps=0 must mean exactly one LLM call");
  assert.equal(calls[0]?.withTools, false, "no tools may be offered when maxSteps=0");
  assert.equal(res.content, VERDICT);
  assert.equal(res.exhausted, false);
  assert.equal(res.stopReason, "answered");
});

test("loop: maxSteps=2 permits at most three calls", async () => {
  const toolCall = result({ toolCalls: [{ name: "get_sender_profile", args: {} }] });
  const { transport, calls } = stubTransport([toolCall, toolCall, result({ content: VERDICT })]);
  const res = await runAgentLoop(seed, {
    toolContext: newCtx(),
    maxSteps: 2,
    label: "t",
  }, { chat: transport });

  assert.equal(calls.length, 3, "maxSteps=2 ⇒ 2 tool rounds + 1 forced verdict");
  assert.equal(calls[0]?.withTools, true);
  assert.equal(calls[1]?.withTools, true);
  assert.equal(calls[2]?.withTools, false, "the last call must not offer tools");
  assert.equal(res.toolCalls, 2);
});

test("loop: a model that never stops calling tools is stopped, not trusted", async () => {
  const toolCall = result({ toolCalls: [{ name: "get_sender_profile", args: {} }] });
  const { transport, calls } = stubTransport([toolCall]);
  const res = await runAgentLoop(seed, {
    toolContext: newCtx(),
    maxSteps: 3,
    label: "t",
  }, { chat: transport });

  assert.equal(calls.length, 4, "3 rounds + 1 forced verdict, then stop");
  assert.equal(res.exhausted, true, "running out of steps must be reported as exhausted");
  assert.equal(res.stopReason, "max_steps");
});

test("loop: tools are withheld once the tool budget is spent", async () => {
  const toolCall = result({ toolCalls: [{ name: "get_sender_profile", args: {} }] });
  const { transport, calls } = stubTransport([toolCall, result({ content: VERDICT })]);
  const res = await runAgentLoop(seed, {
    toolContext: newCtx(),
    maxSteps: 8,
    maxToolCalls: 1,
    label: "t",
  }, { chat: transport });

  assert.equal(res.toolCalls, 1);
  assert.equal(calls.length, 2, "after the tool budget is spent the model must answer");
  assert.equal(calls[1]?.withTools, false, "tools must not be offered past the tool budget");
});

// ── The forced final call is an answer, not a failure ─────────────────────────

/**
 * The parser predicate the real callers inject. Deliberately a strict
 * `parseLLMOutput`-equivalent rather than "the text is non-empty": a loop that
 * trusted prose here would turn a paragraph into a verdict.
 */
const isVerdict = (text: string): boolean => {
  try {
    const parsed = JSON.parse(text) as { eligible?: unknown; confidence?: unknown };
    return typeof parsed.eligible === "boolean" && typeof parsed.confidence === "number";
  } catch {
    return false;
  }
};

test("loop: maxSteps=1 + a valid verdict on the forced final call is NOT exhausted", async () => {
  // The regression this pins: at maxSteps=1 every escrow whose Investigator called a
  // tool used to come back `exhausted: true`, and `requireAgentVerdict` then threw —
  // a fail-safe REJECT on a perfectly good verdict. The forced final call is the
  // loop's intended ending, so spending the step budget must not void it.
  const toolCall = result({ toolCalls: [{ name: "get_recipient_db_history", args: {} }] });
  const { transport, calls } = stubTransport([toolCall, result({ content: VERDICT })]);
  const res = await runAgentLoop(seed, {
    toolContext: newCtx(),
    maxSteps: 1,
    label: "t",
    isFinalAnswer: isVerdict,
  }, { chat: transport });

  assert.equal(calls.length, 2, "one tool round + the forced verdict");
  assert.equal(calls[1]?.withTools, false, "the forced call must have tools withheld");
  assert.equal(res.exhausted, false, "a usable verdict on the forced call is a completed run");
  assert.equal(res.stopReason, "answered");
  assert.equal(res.content, VERDICT, "the verdict text must reach the caller unchanged");
});

test("loop: maxSteps=1 + garbage on the forced final call IS exhausted", async () => {
  const toolCall = result({ toolCalls: [{ name: "get_recipient_db_history", args: {} }] });
  const { transport } = stubTransport([toolCall, result({ content: "I looked, it seems fine." })]);
  const res = await runAgentLoop(seed, {
    toolContext: newCtx(),
    maxSteps: 1,
    label: "t",
    isFinalAnswer: isVerdict,
  }, { chat: transport });

  assert.equal(res.exhausted, true, "text the caller cannot parse must still fail safe");
  assert.equal(res.stopReason, "max_steps");
});

test("loop: a spent step budget without an isFinalAnswer predicate stays exhausted", async () => {
  // The seam is opt-in precisely so its absence is the strict behaviour: an agent
  // that cannot say what a usable answer looks like keeps the old fail-safe.
  const toolCall = result({ toolCalls: [{ name: "get_recipient_db_history", args: {} }] });
  const { transport } = stubTransport([toolCall, result({ content: VERDICT })]);
  const res = await runAgentLoop(seed, {
    toolContext: newCtx(),
    maxSteps: 1,
    label: "t",
  }, { chat: transport });

  assert.equal(res.exhausted, true);
  assert.equal(res.stopReason, "max_steps");
});

test("loop: an EMPTY forced final call is exhausted even with a predicate", async () => {
  // A model that keeps calling tools until the last call emits no text at all is the
  // original exhaustion case, and the predicate must not rescue it.
  const toolCall = result({ toolCalls: [{ name: "get_recipient_db_history", args: {} }] });
  const { transport } = stubTransport([toolCall, result({ content: "   " })]);
  const res = await runAgentLoop(seed, {
    toolContext: newCtx(),
    maxSteps: 1,
    label: "t",
    isFinalAnswer: isVerdict,
  }, { chat: transport });

  assert.equal(res.exhausted, true);
});

// ── Tool-call handling ────────────────────────────────────────────────────────

test("loop: an unknown tool name is refused, never executed", async () => {
  const { transport } = stubTransport([
    result({ toolCalls: [{ name: "approve_transfer", args: {} }] }),
    result({ content: VERDICT }),
  ]);
  const res = await runAgentLoop(seed, {
    toolContext: newCtx(),
    maxSteps: 1,
    label: "t",
  }, { chat: transport });

  assert.equal(res.toolCalls, 0, "a refused call must not count as an executed tool");
  const toolMsgs = res.messages.filter((m) => m.role === "tool");
  assert.ok(toolMsgs.length > 0);
  assert.match(
    toolMsgs.map((m) => m.content).join("\n"),
    /REFUSED/,
    "the model must be told the call did not run"
  );
});

test("loop: tool results are appended as tool-role messages with a name", async () => {
  const { transport } = stubTransport([
    result({ toolCalls: [{ name: "get_recipient_db_history", args: {} }] }),
    result({ content: VERDICT }),
  ]);
  const res = await runAgentLoop(seed, {
    toolContext: newCtx(),
    maxSteps: 1,
    label: "t",
  }, { chat: transport });

  const toolMsg = res.messages.find((m) => m.role === "tool");
  assert.ok(toolMsg, "a tool result must reach the transcript");
  assert.equal(toolMsg.toolName, "get_recipient_db_history");
  // The assistant turn that requested it must also be preserved, or the model
  // cannot tell which call the data answers.
  const assistant = res.messages.find((m) => m.role === "assistant");
  assert.ok(assistant?.toolCalls?.[0]?.name === "get_recipient_db_history");
});

test("loop: tool output is wrapped as untrusted before the model sees it", async () => {
  const { transport } = stubTransport([
    result({ toolCalls: [{ name: "get_recipient_db_history", args: {} }] }),
    result({ content: VERDICT }),
  ]);
  const res = await runAgentLoop(seed, {
    toolContext: newCtx(),
    maxSteps: 1,
    label: "t",
  }, { chat: transport });

  const toolMsg = res.messages.find((m) => m.role === "tool");
  assert.match(toolMsg?.content ?? "", /UNTRUSTED/i);
});

test("loop: an out-of-scope address in tool args is refused", async () => {
  const { transport } = stubTransport([
    result({
      toolCalls: [{ name: "check_address_security", args: { address: "0x90F8bf6A479f320ead074411a4B0e7944Ea8c9C1" } }],
    }),
    result({ content: VERDICT }),
  ]);
  const res = await runAgentLoop(seed, {
    toolContext: newCtx(),
    maxSteps: 1,
    label: "t",
  }, { chat: transport });

  assert.equal(res.toolCalls, 0, "an out-of-scope query must not execute");
  assert.match(
    res.messages.filter((m) => m.role === "tool").map((m) => m.content).join("\n"),
    /REFUSED/
  );
});

test("loop: more calls than the budget allows are refused, not silently dropped", async () => {
  const many = result({
    toolCalls: Array.from({ length: 4 }, () => ({
      name: "get_sender_db_history",
      args: {},
    })),
  });
  const { transport } = stubTransport([many, result({ content: VERDICT })]);
  const res = await runAgentLoop(seed, {
    toolContext: newCtx(),
    maxSteps: 1,
    maxToolCalls: 2,
    label: "t",
  }, { chat: transport });

  assert.equal(res.toolCalls, 2, "the tool budget must be respected");
  const toolMsgs = res.messages.filter((m) => m.role === "tool");
  assert.equal(toolMsgs.length, 3, "2 executed + 1 refusal record for the overflow");
  assert.match(toolMsgs[2]?.content ?? "", /REFUSED/);
});

test("loop: a throwing tool does not lose the other tools' results", async () => {
  // `get_sender_profile` is the only spec whose executor reaches the network, so a
  // transport-level failure there is the realistic version of this case; the
  // SQLite tools beside it must still report.
  const { transport } = stubTransport([
    result({
      toolCalls: [
        { name: "get_sender_profile", args: {} },
        { name: "get_recipient_db_history", args: {} },
      ],
    }),
    result({ content: VERDICT }),
  ]);
  const res = await runAgentLoop(seed, {
    toolContext: newCtx(),
    maxSteps: 1,
    label: "t",
  }, { chat: transport });

  const toolMsgs = res.messages.filter((m) => m.role === "tool");
  assert.equal(toolMsgs.length, 2, "both tools must report, one succeeded or not");
});

// ── LLM call budget ───────────────────────────────────────────────────────────

test("budget: an exhausted budget stops the agent before it calls", async () => {
  const { transport, calls } = stubTransport([result({ content: VERDICT })]);
  const budget = new LlmBudget(0);
  const res = await runAgentLoop(seed, {
    toolContext: newCtx(),
    maxSteps: 2,
    budget,
    label: "t",
  }, { chat: transport });

  assert.equal(calls.length, 0, "no LLM call may start without a reservation");
  assert.equal(res.exhausted, true);
  assert.equal(res.stopReason, "budget");
  assert.equal(budget.used, 0, "a refused reservation charges nothing");
});

test("budget: the agent stops as soon as the escrow budget runs out mid-run", async () => {
  const toolCall = result({ toolCalls: [{ name: "get_sender_db_history", args: {} }] });
  const { transport, calls } = stubTransport([toolCall, toolCall, result({ content: VERDICT })]);
  const budget = new LlmBudget(2);
  const res = await runAgentLoop(seed, {
    toolContext: newCtx(),
    maxSteps: 8,
    budget,
    label: "t",
  }, { chat: transport });

  assert.equal(budget.used, 2, "the budget must be fully spent and not exceeded");
  assert.equal(calls.length, 2);
  assert.equal(res.exhausted, true);
  assert.equal(res.stopReason, "budget");
});

test("budget: an agent that finishes within its share leaves the rest for others", async () => {
  const { transport } = stubTransport([result({ content: VERDICT })]);
  const budget = new LlmBudget(12);
  await runAgentLoop(seed, {
    toolContext: newCtx(),
    maxSteps: 4,
    budget,
    label: "t",
  }, { chat: transport });
  assert.equal(budget.used, 1);
  assert.equal(budget.remaining, 11, "the Judge's calls must still fit");
});

// ── Failure handling ──────────────────────────────────────────────────────────

test("loop: a transport error is exhausted, never an approval", async () => {
  const transport: ChatTransport = async () => {
    throw new Error("Ollama timeout after 1000ms (t)");
  };
  const res = await runAgentLoop(seed, {
    toolContext: newCtx(),
    maxSteps: 2,
    label: "t",
  }, { chat: transport });

  assert.equal(res.exhausted, true);
  assert.equal(res.stopReason, "error");
  assert.match(res.error ?? "", /timeout/);
  assert.notEqual(res.content, VERDICT, "a failure must never yield a verdict");
});

test("loop: an empty answer is reported, not silently accepted", async () => {
  const { transport } = stubTransport([result({ content: "   " })]);
  const res = await runAgentLoop(seed, {
    toolContext: newCtx(),
    maxSteps: 0,
    label: "t",
  }, { chat: transport });

  assert.equal(res.content.trim(), "");
  assert.equal(res.stopReason, "answered");
  // The parser is what rejects a blank verdict; the loop's job is to hand it over
  // unchanged rather than manufacture one.
});

test("loop: a truncated prompt yields no trustworthy verdict", async () => {
  const { transport } = stubTransport([
    result({
      content: VERDICT,
      usage: { promptTokens: 9000, completionTokens: 10, truncated: true, nearContextLimit: true },
    }),
  ]);
  const res = await runAgentLoop(seed, {
    toolContext: newCtx(),
    maxSteps: 0,
    label: "t",
  }, { chat: transport });

  assert.equal(res.exhausted, true, "a context-starved answer must not read as a clean verdict");
});

test("loop: a transcript budget keeps the system prompt and the newest evidence", async () => {
  const long = "y".repeat(400);
  const longSeed: ChatMessage[] = [
    { role: "system", content: "SYSTEM RULES" },
    { role: "user", content: long },
    { role: "assistant", content: long },
    { role: "tool", content: long, toolName: "get_sender_profile" },
    { role: "user", content: "NEWEST QUESTION" },
  ];
  const { transport, calls } = stubTransport([result({ content: VERDICT })]);
  await runAgentLoop(longSeed, {
    toolContext: newCtx(),
    maxSteps: 0,
    label: "t",
    maxChars: 500,
  }, { chat: transport });

  const sent = calls[0]?.messages ?? [];
  assert.ok(
    sent.some((m) => m.role === "system" && m.content === "SYSTEM RULES"),
    "the safety rules must never be trimmed away"
  );
  assert.ok(
    sent.some((m) => m.content === "NEWEST QUESTION"),
    "the question being answered must survive"
  );
  assert.ok(sent.length < longSeed.length, "old messages must actually be dropped");
});

// ── Trace ─────────────────────────────────────────────────────────────────────

test("loop: each step is reported for the SSE trace", async () => {
  const toolCall = result({ toolCalls: [{ name: "get_sender_db_history", args: {} }] });
  const { transport } = stubTransport([toolCall, result({ content: VERDICT })]);
  const events: string[] = [];
  await runAgentLoop(seed, {
    toolContext: newCtx(),
    maxSteps: 1,
    label: "t",
  }, { chat: transport, onStep: (e) => events.push(`${e.index}:${e.kind}:${e.toolNames.join(",")}`) });

  assert.deepEqual(events, ["1:tool_request:get_sender_db_history", "2:final:"]);
});
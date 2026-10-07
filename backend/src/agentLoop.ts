// ── Bounded ReAct agent loop ────────────────────────────────────────────────────
// WHAT THIS IS
// ───────────
// One generic loop that drives every LLM agent in AEGIS: the Investigator, the
// Advocate and the focused re-pass all run through it with different system
// prompts and different step caps. The old code had three near-copies of the same
// "call → parse JSON → maybe call again" shape; the divergence between them is
// what made the pre-agent behaviour impossible to reason about.
//
// THE TWO INVARIANTS THAT MATTER MOST
// ───────────────────────────────────
// 1. A tool call is never a decision. The loop returns TEXT and lets the caller's
//    parser judge it. If the model says "I called a tool and everything is fine",
//    the caller sees a missing verdict and fails safe — the loop never converts
//    tool output into an outcome by itself.
//
// 2. The loop always terminates with a forced final call. When the step or tool
//    budget runs out, it stops offering tools and asks for the verdict outright,
//    so the common case is a decision rather than an exception. That final call
//    is the INTENDED way to conclude, so spending the whole step budget is not by
//    itself exhaustion: whether the run counts as exhausted depends on whether the
//    forced answer is actually usable, and the loop cannot judge that on its own —
//    it has no verdict schema. The caller therefore injects `isFinalAnswer(text)`
//    (bound to the very parser that will read the answer), and the rule is:
//    exhausted ⇔ the run could not produce a usable final answer. Only then does
//    the caller fail safe (Investigator/Judge REJECT, Advocate degrades).
//
//    Why this matters: `exhausted` used to be set purely from "rounds were spent",
//    which made `maxSteps = 1` fail-safe REJECT on every escrow whose Investigator
//    called a tool — even when the forced final call returned a perfectly valid
//    verdict JSON. A safety flag that fires on the success path trains operators to
//    ignore it, and discards real verdicts while doing so.
//
// The transport is injected (`deps.chat`) so the whole loop is testable without a
// GPU — which is the only way these edge cases get covered at all.

import { config } from "./config.js";
import {
  chat as defaultChat,
  trimMessages,
  type ChatMessage,
  type ChatOptions,
  type ChatResult,
} from "./ollamaChat.js";
import {
  executeToolCall,
  formatToolResultMessage,
  getToolSpec,
  ToolArgError,
  type ToolContext,
} from "./tools.js";
import type { LlmBudget } from "./llmBudget.js";

/** Transport seam. The real implementation queues on Ollama; tests supply a stub. */
export type ChatTransport = (
  messages: ChatMessage[],
  opts: ChatOptions
) => Promise<ChatResult>;

export interface AgentStepEvent {
  /** 1-based index of the LLM call that produced this step. */
  index: number;
  kind: "tool_request" | "final" | "budget_stop";
  /** Tool names requested in this step (empty for `final`). */
  toolNames: string[];
  /** Generation time for the call that produced the event. */
  generationMs: number;
  /** How many LLM calls this agent has now made, including this one. */
  llmCalls: number;
}

export interface AgentLoopDeps {
  chat?: ChatTransport;
  /** Called once per step so the pipeline can publish an SSE trace. */
  onStep?: (event: AgentStepEvent) => void;
}

export interface AgentLoopOptions {
  /**
   * Address scope for this run: the two escrow endpoints plus the bounded set of
   * addresses the agent has discovered so far.
   *
   * It is threaded through the loop (rather than rebuilt per turn) precisely so
   * the discovered-address cap cannot reset at each step: the cap has to bound
   * the whole investigation, not each turn of it.
   */
  toolContext: ToolContext;
  /** Tool rounds allowed before the forced final call. 0 ⇒ one call, no tools. */
  maxSteps: number;
  /** Total tool invocations allowed across the whole agent run. */
  maxToolCalls?: number;
  /** Charged from this before every LLM call. Omit for an unbounded run. */
  budget?: LlmBudget | undefined;
  /** Label for logs and SSE, e.g. "investigator". */
  label: string;
  temperature?: number;
  numPredict?: number;
  /** Generation-time budget across all turns. Defaults to `AGENT_TIMEOUT_MS`. */
  timeoutMs?: number;
  /**
   * Character budget for the accumulated transcript. Defaults to
   * `AGENT_CONTEXT_CHAR_LIMIT`.
   *
   * Applied HERE rather than only inside the transport, so the loop owns its own
   * budget: a run cannot silently outgrow its context because the transport
   * implementation changed, and the policy is testable with a stubbed model.
   */
  maxChars?: number;
  /**
   * "Is this text a usable final answer?" — used ONLY to decide the `exhausted`
   * flag on a run that spent its whole step budget and was then forced to answer.
   *
   * Deliberately a callback rather than a second parser inside the loop: the loop
   * has no verdict schema, and a second copy of the parser is a second thing that
   * can drift from the one the caller actually uses. `aiAnalyzer.ts` passes
   * `parseLLMOutput`-backed predicates for the Investigator / re-pass and the
   * Advocate's own parser for the Advocate, so "usable" means exactly what the
   * caller will accept — never more, never less.
   *
   * Omit it and a run that spent its rounds is reported as exhausted, which is the
   * strict behaviour: an unparseable answer must never be promoted to a verdict.
   */
  isFinalAnswer?: (text: string) => boolean;
}

export interface AgentLoopResult {
  /** The model's final text. Empty when the run stopped before any answer. */
  content: string;
  /** LLM calls actually made. */
  llmCalls: number;
  /** Tool invocations actually executed. */
  toolCalls: number;
  /**
   * True when the run ended WITHOUT a usable final answer — the LLM-call budget
   * refused a call, the generation timeout elapsed, the transport errored, the
   * prompt was truncated, or the final text is not a parseable verdict.
   *
   * Spending the whole step budget is deliberately NOT exhaustion on its own: the
   * forced final call is how the loop is designed to finish, and when that call
   * returns a verdict the caller reads it (see `isFinalAnswer`). `exhausted: true`
   * therefore means "this agent could not produce an answer", never "this agent
   * used its budget".
   *
   * NOTE: `exhausted` does NOT mean "the model refused". It means this agent could
   * not finish, which the caller must translate into its own fail-safe (REJECT for
   * Investigator/Judge, degraded-but-proceed for Advocate).
   */
  exhausted: boolean;
  /** Why the run ended, for the transcript. */
  stopReason: "answered" | "max_steps" | "max_tool_calls" | "budget" | "timeout" | "error";
  /** Transcript, so a caller can show the reasoning or replay it. */
  messages: ChatMessage[];
  /** Total generation time, queue wait excluded. */
  generationMs: number;
  /** Set when `stopReason === "error"`. */
  error?: string;
}

/** One tool invocation and how it turned out. */
interface ToolExecution {
  name: string;
  /** Wrapper text handed back to the model (already untrusted-marked + capped). */
  text: string;
  /** False when the name was not in the registry or validation refused it. */
  ok: boolean;
}

/**
 * Run up to `maxSteps` tool rounds, then force a final answer.
 *
 * `maxSteps = 0` is a real, supported configuration and not a degenerate one: it
 * means "one LLM call, no tools", which is exactly what the Advocate runs as when
 * `ADVOCATE_MAX_STEPS=0`, and what the whole pipeline degrades to for the
 * regression comparison.
 */
export async function runAgentLoop(
  seed: ChatMessage[],
  opts: AgentLoopOptions,
  deps: AgentLoopDeps = {}
): Promise<AgentLoopResult> {
  const transport: ChatTransport = deps.chat ?? defaultChat;
  const maxToolCalls = opts.maxToolCalls ?? config.AGENT_MAX_TOOL_CALLS;
  const timeoutMs = opts.timeoutMs ?? config.AGENT_TIMEOUT_MS;
  const label = opts.label;

  const messages: ChatMessage[] = [...seed];
  let llmCalls = 0;
  let toolCalls = 0;
  let generationMs = 0;

  const finish = (
    content: string,
    stopReason: AgentLoopResult["stopReason"],
    extra: { exhausted: boolean; error?: string } = { exhausted: false }
  ): AgentLoopResult => ({
    content,
    llmCalls,
    toolCalls,
    exhausted: extra.exhausted,
    stopReason,
    messages,
    generationMs,
    ...(extra.error !== undefined ? { error: extra.error } : {}),
  });

  // The seed's last message is the current question; it is always present, so an
  // empty transcript is a programming error rather than a runtime condition.
  if (messages.length === 0) {
    throw new Error("runAgentLoop: seed must contain at least a system message");
  }

  for (;;) {
    // ── Budget gates, checked BEFORE spending a call ──────────────────────────
    if (opts.budget !== undefined) {
      const reservation = opts.budget.tryReserve(1);
      if (!reservation.ok) {
        console.warn(
          `[Agent]   ${label}: escrow LLM-call budget exhausted — stopping before call ` +
            `${llmCalls + 1} (${opts.budget.describe()}).`
        );
        deps.onStep?.({
          index: llmCalls + 1,
          kind: "budget_stop",
          toolNames: [],
          generationMs: 0,
          llmCalls,
        });
        return finish(lastAssistantText(messages), "budget", { exhausted: true });
      }
    }

    if (generationMs >= timeoutMs) {
      console.warn(
        `[Agent]   ${label}: generation budget spent (${generationMs}ms of ${timeoutMs}ms) ` +
          `after ${llmCalls} call(s) — stopping.`
      );
      return finish(lastAssistantText(messages), "timeout", { exhausted: true });
    }

    // ── Decide whether tools are offered ────────────────────────────────────
    // Tools are withheld once the step or tool budget is gone, so the model is
    // pushed towards a verdict instead of being allowed to keep exploring a
    // budget it no longer has.
    const stepsUsed = llmCalls;
    const outOfSteps = stepsUsed >= opts.maxSteps;
    const outOfToolCalls = toolCalls >= maxToolCalls;
    const offerTools = !outOfSteps && !outOfToolCalls;

    let result: ChatResult;
    try {
      // Trim here, not only in the transport: the loop must be able to bound its
      // own transcript with a stubbed model, so this property is testable without
      // a GPU and cannot be lost by swapping the transport.
      const { trimmed, dropped } = trimMessages(messages, opts.maxChars ?? config.AGENT_CONTEXT_CHAR_LIMIT);
      result = await transport(dropped > 0 ? trimmed : messages, {
        withTools: offerTools,
        ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
        ...(opts.numPredict !== undefined ? { numPredict: opts.numPredict } : {}),
        // Remaining generation budget for this call, never the full allowance:
        // one turn may not consume the whole agent's timeout.
        timeoutMs: Math.max(1_000, timeoutMs - generationMs),
        label: `${label} step ${llmCalls + 1}`,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[Agent]   ${label}: LLM call failed — ${msg}`);
      return finish(lastAssistantText(messages), "error", { exhausted: true, error: msg });
    }

    llmCalls += 1;
    generationMs += result.generationMs;

    if (result.usage.truncated) {
      // Not fatal on its own — the caller still gets a verdict — but the run is no
      // longer trustworthy enough to be treated as a full investigation, so the
      // loop reports it through `exhausted` rather than passing a silently
      // context-starved answer up as a clean one.
      console.warn(
        `[Agent]   ${label}: Ollama truncated the prompt at call ${llmCalls}; the answer may ` +
          `ignore earlier evidence.`
      );
      if (result.content.trim().length > 0) {
        return {
          ...finish(result.content, "answered", { exhausted: true }),
          stopReason: "answered",
        };
      }
      return finish(result.content, "timeout", { exhausted: true });
    }

    const requested = result.toolCalls;
    const toolPhase = offerTools && requested.length > 0;

    deps.onStep?.({
      index: llmCalls,
      kind: toolPhase ? "tool_request" : "final",
      toolNames: requested.map((c) => c.name),
      generationMs: result.generationMs,
      llmCalls,
    });

    // ── Final answer ────────────────────────────────────────────────────────
    if (!toolPhase) {
      // `outOfSteps`/`outOfToolCalls` reached, or the model declined to call any
      // tool. Either way this text is the verdict.
      if (requested.length > 0) {
        // Tools were withheld but the model asked for them anyway (it can, if the
        // transport echoed a stale schema). Record it instead of running it: the
        // budget is spent and an unvalidated request must not be executed.
        console.warn(
          `[Agent]   ${label}: model requested ${requested.length} tool call(s) with tools ` +
            `withheld (step/tool budget reached) — not executed: ` +
            `${requested.map((c) => c.name).join(", ")}`
        );
      }
      // Exhaustion requires that rounds were actually spent AND that the forced
      // answer is not usable. `maxSteps = 0` also lands here with `outOfSteps` true
      // on the very first call, but that is the supported "one call, no tools"
      // configuration answering as asked — calling it exhaustion would make every
      // stateless agent look like a failure.
      //
      // A spent step budget WITH a parseable verdict is a completed run: the forced
      // call is the intended ending, so `stopReason` is "answered" and `exhausted` is
      // false. Reporting it as exhausted used to throw away valid verdicts and
      // fail-safe REJECT them, which is exactly what happened to every escrow at
      // maxSteps=1 where the Investigator used its tool round. Anything else — no
      // `isFinalAnswer` predicate supplied, or text the caller's parser rejects —
      // stays exhausted, so an unusable answer is never promoted to a verdict.
      const spentRounds = outOfSteps && llmCalls > 1;
      const usableFinal =
        spentRounds && opts.isFinalAnswer !== undefined
          ? opts.isFinalAnswer(result.content)
          : false;
      const exhausted = spentRounds && !usableFinal;
      return finish(result.content, exhausted ? "max_steps" : "answered", { exhausted });
    }

    // ── Execute the requested tools ──────────────────────────────────────────
    messages.push({ role: "assistant", content: result.content, toolCalls: requested });

    const room = maxToolCalls - toolCalls;
    const executions = await executeRequested(requested, opts, room, opts.maxSteps - stepsUsed);

    toolCalls += executions.filter((e) => e.ok).length;
    for (const exec of executions) {
      messages.push({ role: "tool", content: exec.text, toolName: exec.name });
    }
  }
}

/**
 * Execute one turn's tool calls and append the wrapped results to `messages`.
 *
 * Calls run in PARALLEL: they are independent reads, and the escrow's wall clock
 * is the scarcest resource in the system. Each call is isolated — one throwing
 * tool must not cost the others their results — and each result is wrapped as
 * untrusted data before it can reach the model.
 *
 * `room` bounds the turn: a model that asks for nine tools when only two are left
 * in the budget gets the first two, and the rest are reported as REFUSED rather
 * than silently ignored (a silent drop would leave the model waiting for data it
 * will never get, and it might fill the gap with a guess).
 */
async function executeRequested(
  requested: Array<{ name: string; args: Record<string, unknown> }>,
  opts: AgentLoopOptions,
  room: number,
  stepsLeft: number
): Promise<ToolExecution[]> {
  const ctx = opts.toolContext;
  const accepted = requested.slice(0, Math.max(0, room));
  const overflow = requested.slice(accepted.length);

  const overflowText = formatToolResultMessage(
    "(skipped)",
    JSON.stringify({
      status: "REFUSED",
      error: `Tool budget exhausted: ${overflow.length} requested call(s) were not executed.`,
      note: "Do NOT assume the missing data is favourable. State it as UNKNOWN.",
    }),
    { advisoryOnly: true }
  );

  const results = await Promise.all(
    accepted.map(async (call): Promise<ToolExecution> => {
      const spec = getToolSpec(call.name);
      if (spec === undefined) {
        console.warn(`[Agent]   ${opts.label}: refusing unknown tool '${call.name}'`);
        return {
          name: call.name,
          ok: false,
          text: formatToolResultMessage(
            call.name,
            JSON.stringify({
              status: "REFUSED",
              error: `No tool named '${call.name}' is registered.`,
              note: "This call never executed. Treat the information as UNKNOWN.",
            })
          ),
        };
      }
      try {
        const { outcome } = await executeToolCall(spec, call.args, ctx, stepsLeft);
        return {
          name: call.name,
          ok: true,
          text: formatToolResultMessage(call.name, outcome.out, {
            ...(outcome.advisoryOnly === true ? { advisoryOnly: true } : {}),
          }),
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // An argument refusal is NOT a runtime failure. Reporting it as FAILED
        // would tell the model "this tool is broken, try it again", when the truth
        // is "the system declined this query and will decline it again" — which
        // invites a retry loop and inflates the failed-vs-unavailable accounting.
        const refused = err instanceof ToolArgError;
        console.warn(
          `[Agent]   ${opts.label}: tool ${call.name} ${refused ? "refused" : "failed"} — ${msg}`
        );
        return {
          name: call.name,
          ok: false,
          text: formatToolResultMessage(
            call.name,
            JSON.stringify(
              refused
                ? {
                    status: "REFUSED",
                    error: msg,
                    note:
                      "The call was refused and never executed. Do NOT retry it with a " +
                      "modified address — you may only query addresses already in scope. " +
                      "Treat the missing information as UNKNOWN.",
                  }
                : {
                    status: "FAILED",
                    error: msg,
                    note: "Tool execution failed. Treat this as UNKNOWN, not safe.",
                  }
            )
          ),
        };
      }
    })
  );

  const out = [...results];
  if (overflow.length > 0) {
    out.push({ name: "(budget)", ok: false, text: overflowText });
  }
  return out;
}

/** The most recent assistant text, used when a run stops without a fresh answer. */
function lastAssistantText(messages: ChatMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i];
    if (m?.role === "assistant" && m.content.trim().length > 0) return m.content;
  }
  return "";
}
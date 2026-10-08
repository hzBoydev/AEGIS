// ── Ollama transport (native tool calling) ──────────────────────────────────────
// WHY a separate module
// ─────────────────────
// The pre-agent pipeline talked to `/api/generate` with a JSON-format prompt and
// parsed the answer. Native tool calling needs `/api/chat`, a message array, a
// `tools` schema and a multi-turn assistant/tool exchange — none of which the old
// call shape can express.
//
// Two things are shared with the old path and therefore live here rather than in
// aiAnalyzer: the SERIALIZATION LOCK (one GPU, one model, concurrent escrows from
// the poller) and `num_ctx`. If the two endpoints disagreed about either, the
// agent path would silently hit a different context budget than the legacy one.
//
// Dependency direction: ollamaChat (transport) ← aiAnalyzer (prompts) ← agentLoop.

import { config } from "./config.js";
import { TOOL_SPECS, type JsonSchema } from "./tools.js";

// ── Ollama serialization lock ─────────────────────────────────────────────────
/**
 * Serialize ALL Ollama requests into a single queue.
 *
 * The Qwen3:8b model runs locally on one GPU (6GB VRAM). If several escrows are
 * processed concurrently (the poller uses `void processEscrow`), the requests
 * queue up inside Ollama and trigger timeouts — a lesson from an earlier CoT
 * failure. With this lock the queue is managed on our side: the timeout is only
 * counted once a turn arrives, not while waiting.
 *
 * The agent budget depends on this property. `AGENT_TIMEOUT_MS` is a budget for
 * GENERATION time across an agent's turns, so it must not silently include the
 * wall-clock time spent queued behind another escrow — otherwise a burst of
 * escrows makes healthy agents "time out" for no fault of their own.
 */
let ollamaChain: Promise<void> = Promise.resolve();

/**
 * Number of enqueued-but-unfinished lock turns. Tracked explicitly rather than
 * inferred from `ollamaChain` (which is a resolved promise whenever the queue is
 * empty, including *while* a turn is mid-flight before it settles).
 *
 * Incremented at ENQUEUE time, not when the turn starts: a caller that asks "is
 * Ollama idle?" must see a queued request as not-idle, otherwise the optional
 * lesson writer queues behind real escrows while reporting the queue as empty.
 */
let idleWatchers = 0;

export function withOllamaLock<T>(fn: () => Promise<T>): Promise<T> {
  idleWatchers += 1;
  const result = ollamaChain.then(
    async () => {
      try {
        return await fn();
      } finally {
        idleWatchers -= 1;
      }
    },
    async () => {
      try {
        return await fn();
      } finally {
        idleWatchers -= 1;
      }
    }
  );
  ollamaChain = result.then(
    () => undefined,
    () => undefined
  );
  return result;
}

/**
 * True when no request is queued or in flight.
 *
 * Used to gate the post-decision lesson writer: a lesson write is optional work,
 * and starting it while escrows are waiting would delay a real decision.
 */
export function isOllamaIdle(): boolean {
  return idleWatchers === 0;
}

// ── Message shapes ────────────────────────────────────────────────────────────
export type ChatRole = "system" | "user" | "assistant" | "tool";

/** One tool invocation the model asked for. */
export interface ParsedToolCall {
  name: string;
  /** Always an object — never a JSON string — so validators can index it safely. */
  args: Record<string, unknown>;
}

export interface ChatMessage {
  role: ChatRole;
  /** Text. For a `tool` message this is the wrapped tool result. */
  content: string;
  /** Only on assistant messages that requested tools. */
  toolCalls?: ParsedToolCall[];
  /** Only on `tool` messages: which tool produced `content`. */
  toolName?: string;
}

export interface ChatUsage {
  promptTokens: number;
  completionTokens: number;
  /** Ollama reported the context window filled and generation clipped. */
  truncated: boolean;
  /**
   * True when the prompt filled more than 75% of `OLLAMA_NUM_CTX`.
   *
   * Surfaced because it is the failure mode that does not look like one: the run
   * "succeeds" and simply ignores the earliest evidence.
   */
  nearContextLimit: boolean;
}

export interface ChatResult {
  content: string;
  toolCalls: ParsedToolCall[];
  usage: ChatUsage;
  /**
   * Wall-clock time spent GENERATING, measured inside the lock.
   *
   * The agent timeout budget sums this across an agent's turns and must NOT be
   * measured by the caller around `chat()`, because that would include time spent
   * queued behind another escrow. A queued-but-healthy turn must not be recorded
   * as a slow turn.
   */
  generationMs: number;
}

export interface ChatOptions {
  /** Offer the read-only tool registry. Omit for a plain question. */
  withTools?: boolean;
  temperature?: number;
  numPredict?: number;
  /**
   * Abort budget for THIS generation. Defaults to `AGENT_TIMEOUT_MS`, and is
   * measured from inside the lock so queue wait is excluded.
   */
  timeoutMs?: number;
  /**
   * Character budget for the accumulated transcript. When exceeded, the OLDEST
   * non-system messages are dropped — the system rules and the most recent
   * evidence are what must survive. Default `AGENT_CONTEXT_CHAR_LIMIT`.
   */
  maxChars?: number;
  /** Label used in log lines, e.g. "investigator step 2". */
  label?: string;
}

// ── Context trimming ──────────────────────────────────────────────────────────
/**
 * Drop the oldest non-system messages until the transcript fits `maxChars`.
 *
 * Deliberately naive about semantics and careful about what it keeps:
 *   - the system message is NEVER dropped (it carries the safety rules and the
 *     untrusted-data contract; losing it would let tool output steer the model);
 *   - the newest messages are kept (the question being asked, and the evidence
 *     just gathered);
 *   - `tool` messages are dropped BEFORE `assistant`/`user` ones, because a
 *     dangling tool result with no matching call is worse than a dropped turn.
 */
export function trimMessages(
  messages: ChatMessage[],
  maxChars: number
): { trimmed: ChatMessage[]; dropped: number } {
  const totalChars = (msgs: ChatMessage[]): number =>
    msgs.reduce((n, m) => n + m.content.length, 0);

  if (totalChars(messages) <= maxChars) return { trimmed: messages, dropped: 0 };

  const kept = [...messages];
  let dropped = 0;

  // Pass 1: shed tool results (oldest first).
  for (let i = 0; i < kept.length && totalChars(kept) > maxChars; ) {
    const idx = kept.findIndex((m, j) => j > 0 && m.role === "tool");
    if (idx === -1) break;
    kept.splice(idx, 1);
    dropped += 1;
  }

  // Pass 2: shed whole middle turns, oldest first, never the system message.
  while (totalChars(kept) > maxChars && kept.length > 1) {
    // Index 0 is the system message. Also keep the final user/tool message, which
    // is the turn the model is currently answering.
    if (kept.length <= 2) break;
    kept.splice(1, 1);
    dropped += 1;
  }

  if (dropped > 0) {
    console.warn(
      `[Agent]   Transcript over ${maxChars} chars — dropped ${dropped} early message(s) ` +
        `(oldest first; system rules and newest evidence kept).`
    );
  }
  return { trimmed: kept, dropped };
}

// ── Tool-call normalization ───────────────────────────────────────────────────
/**
 * Ollama returns `function.arguments` as an object on current versions, but a
 * JSON string on some builds. Both are accepted; neither is trusted, since this
 * is model-controlled data that may also be null or a scalar.
 */
function coerceArgs(raw: unknown): Record<string, unknown> {
  if (raw === null || raw === undefined) return {};
  if (typeof raw === "object" && !Array.isArray(raw)) {
    return raw as Record<string, unknown>;
  }
  if (typeof raw === "string") {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // fall through to the refusal below
    }
  }
  // Returning {} makes the validator apply the tool's default address, which is
  // the safe interpretation: a malformed argument object should not be able to
  // widen what the tool looks at.
  return {};
}

/** Pull tool calls out of a raw Ollama message, dropping anything malformed. */
function parseToolCalls(raw: unknown): ParsedToolCall[] {
  if (!Array.isArray(raw)) return [];
  const out: ParsedToolCall[] = [];
  for (const entry of raw) {
    if (entry === null || typeof entry !== "object") continue;
    const fn = (entry as { function?: unknown }).function;
    if (fn === null || typeof fn !== "object") continue;
    const name = (fn as { name?: unknown }).name;
    if (typeof name !== "string" || name.length === 0) continue;
    out.push({ name, args: coerceArgs((fn as { arguments?: unknown }).arguments) });
  }
  return out;
}

/** Wire format for `/api/chat`. */
function toWireMessages(messages: ChatMessage[]): Array<Record<string, unknown>> {
  return messages.map((m) => {
    const wire: Record<string, unknown> = { role: m.role, content: m.content };
    if (m.role === "assistant" && m.toolCalls && m.toolCalls.length > 0) {
      wire.tool_calls = m.toolCalls.map((c) => ({
        function: { name: c.name, arguments: c.args },
      }));
    }
    // Ollama identifies a tool result by name; without it the model cannot tell
    // which call the data answers.
    if (m.role === "tool" && m.toolName !== undefined) wire.name = m.toolName;
    return wire;
  });
}

/** The tool schemas handed to the model, derived from the one read-only registry. */
function toolSchemas(): Array<{ type: "function"; function: { name: string; description: string; parameters: JsonSchema } }> {
  return TOOL_SPECS.map((spec) => ({
    type: "function" as const,
    function: {
      name: spec.name,
      description: spec.description,
      parameters: spec.parameters,
    },
  }));
}

// ── The call ───────────────────────────────────────────────────────────────────
/**
 * One `/api/chat` turn with native tool calling.
 *
 * `think: false` is mandatory, not cosmetic: qwen3 emits a `thinking` field
 * alongside `content`, and with reasoning enabled on a 6 GB box the model burns
 * the whole token budget on it and returns an empty `content` — which the old
 * parser then reported as "no JSON found".
 */
export async function chat(
  messages: ChatMessage[],
  opts: ChatOptions = {}
): Promise<ChatResult> {
  const label = opts.label ?? "chat";
  const timeoutMs = opts.timeoutMs ?? config.AGENT_TIMEOUT_MS;
  const maxChars = opts.maxChars ?? config.AGENT_CONTEXT_CHAR_LIMIT;
  const { trimmed } = trimMessages(messages, maxChars);

  const body: Record<string, unknown> = {
    model: config.OLLAMA_MODEL,
    messages: toWireMessages(trimmed),
    stream: false,
    think: false,
    // The model stays resident for the whole demo/judging session
    // (Ollama's default unload after 5 idle minutes → cold-load ~20 seconds).
    keep_alive: "30m",
    options: {
      temperature: opts.temperature ?? 0.1,
      num_predict: opts.numPredict ?? 768,
      // Same context budget as the legacy /api/generate path, so switching
      // AGENT_NATIVE_TOOLS on/off does not silently change what fits.
      num_ctx: config.OLLAMA_NUM_CTX,
    },
  };
  if (opts.withTools === true) body.tools = toolSchemas();

  // `idleWatchers` is incremented by withOllamaLock at enqueue time.
  return withOllamaLock(async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const startedAt = Date.now();

    let response: Response;
    try {
      response = await fetch(`${config.OLLAMA_URL}/api/chat`, {
        method: "POST",
        headers: config.OLLAMA_HEADERS,
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err) {
      // The SIGNAL is the only reliable abort test: an abort can surface as a
      // TypeError("fetch failed") whose `cause` is the AbortError, and undici
      // rethrows a non-Error abort reason verbatim (no `name` at all).
      if (controller.signal.aborted) {
        throw new Error(`Ollama timeout after ${timeoutMs}ms (${label})`);
      }
      throw new Error(`Ollama network error (${label}): ${err}`);
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      throw new Error(`Ollama HTTP ${response.status} (${label}): ${response.statusText}`);
    }

    let payload: {
      message?: { content?: unknown; tool_calls?: unknown };
      prompt_eval_count?: number;
      eval_count?: number;
      done_reason?: unknown;
      truncated?: boolean;
    };
    try {
      payload = (await response.json()) as typeof payload;
    } catch {
      throw new Error(`Ollama returned malformed JSON body (${label})`);
    }

    const content =
      typeof payload.message?.content === "string" ? payload.message.content : "";
    const toolCalls = parseToolCalls(payload.message?.tool_calls);

    const promptTokens = typeof payload.prompt_eval_count === "number" ? payload.prompt_eval_count : 0;
    const completionTokens = typeof payload.eval_count === "number" ? payload.eval_count : 0;
    // Ollama sets `truncated` when the context window filled mid-prompt. It is
    // silent about it otherwise, so the agent would keep reasoning over evidence
    // it never actually saw.
    const truncated = payload.truncated === true || payload.done_reason === "length";
    const nearContextLimit = promptTokens > 0.75 * config.OLLAMA_NUM_CTX;

    if (truncated) {
      console.warn(
        `[Agent]   ${label}: OLLAMA TRUNCATED the prompt — the model did NOT see the whole ` +
          `transcript (${promptTokens} prompt tokens vs num_ctx=${config.OLLAMA_NUM_CTX}). ` +
          `Its conclusion is unreliable; consider lowering AGENT_CONTEXT_CHAR_LIMIT.`
      );
    } else if (nearContextLimit) {
      console.warn(
        `[Agent]   ${label}: prompt used ${promptTokens} tokens (>75% of num_ctx=` +
          `${config.OLLAMA_NUM_CTX}). Old evidence is at risk of being dropped silently.`
      );
    }

    console.log(
      `[Agent]   ${label}: ${Date.now() - startedAt}ms, ${completionTokens} out, ` +
        `${promptTokens} prompt tokens, ${toolCalls.length} tool call(s)` +
        (truncated ? " [TRUNCATED]" : "")
    );

    return {
      content,
      toolCalls,
      usage: { promptTokens, completionTokens, truncated, nearContextLimit },
      generationMs: Date.now() - startedAt,
    };
  });
}
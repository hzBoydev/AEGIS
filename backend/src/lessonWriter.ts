// ── Lesson writer (LLM-facing) ──────────────────────────────────────────────────
// WHY THIS IS A SEPARATE MODULE
// ─────────────────────────────
// Storage lives in `agentLessons.ts`, which `tools.ts` imports (for the
// `recall_lessons` tool). This module needs BOTH that storage and the Ollama
// transport — and the transport imports `tools.ts` for the tool schemas. Putting
// the writer inside `agentLessons.ts` would therefore close the cycle
// agentLessons → ollamaChat → tools → agentLessons. Split by dependency direction
// instead: this file is imported only by the poller, and it imports both leaves.
//
// THE RULE THIS FILE ENFORCES
// ───────────────────────────
// A lesson is written ONLY when something outside the model corrected it. The
// three sources are a human veto, a hard rule and GoPlus — all of which happen
// OUTSIDE the hearing and all of which are ground truth about the case.
//
// The AI's own verdict is never a lesson. Writing "in similar cases we released"
// back into the prompt would let the model grade its own homework, and one bad
// afternoon would harden into a standing bias with no evidence behind it.

import { config } from "./config.js";
import { chat, isOllamaIdle } from "./ollamaChat.js";
import { saveLesson, type LessonSource } from "./agentLessons.js";

/** What the AI recommended vs what actually happened. */
export interface CorrectionInput {
  escrowId: string;
  sender: string;
  recipient: string;
  amountBNB: number;
  /** The AI's recommendation: true = RELEASE. */
  aiRecommended: boolean;
  /** What the deterministic ground truth decided: true = RELEASE. */
  actualReleased: boolean;
  /** The AI's reasoning, so the lesson can be about the mistake, not the case. */
  aiReason: string;
  /** Why the correction happened (a hard-rule name, a GoPlus flag, operator text). */
  correctionDetail: string;
  source: LessonSource;
}

/** Longest hint passed to the generator, to bound the prompt. */
const HINT_CHAR_LIMIT = 600;

/**
 * Record a correction as a transferable lesson.
 *
 * Never throws and never blocks the caller: a lesson is optional bookkeeping, and
 * the case it describes has already been decided on-chain by the time this runs.
 * Every failure mode is a log line, not an exception.
 *
 * Returns true when a lesson was actually stored.
 */
export async function writeCorrectionLesson(input: CorrectionInput): Promise<boolean> {
  if (!config.AGENT_LESSONS_ENABLED) {
    return false;
  }
  // Only disagreements are lessons. An agreement is not evidence about anything,
  // and recording it would inflate the memory with self-confirmation.
  if (input.aiRecommended === input.actualReleased) {
    return false;
  }
  // Wait for an idle queue: this is optional post-decision work and must never
  // delay a live escrow's LLM call.
  if (!isOllamaIdle()) {
    console.log("[Lessons] Ollama busy — skipping the lesson write for this escrow.");
    return false;
  }

  try {
    const aiSide = input.aiRecommended ? "RELEASE" : "REJECT";
    const realSide = input.actualReleased ? "RELEASE" : "REJECT";
    const lesson = await generateLessonText({
      aiSide,
      realSide,
      hint: `${correctionHint(input)}`.slice(0, HINT_CHAR_LIMIT),
    });

    return saveLesson({
      escrowId: input.escrowId,
      pattern: `${aiSide} was wrong here`,
      lesson,
      outcome: realSide,
      source: input.source,
    });
  } catch (err) {
    console.warn(
      `[Lessons] Could not store a lesson for ${input.escrowId}: ` +
        `${err instanceof Error ? err.message : err} (non-fatal — the decision stands).`
    );
    return false;
  }
}

/** The deterministic facts of the correction, used as the generator's input. */
function correctionHint(input: CorrectionInput): string {
  return [
    `sender=${input.sender}`,
    `recipient=${input.recipient}`,
    `amount=${input.amountBNB} BNB`,
    `ai decided: ${input.aiRecommended ? "RELEASE" : "REJECT"} — ${input.aiReason}`,
    `override: ${input.actualReleased ? "RELEASE" : "REJECT"} (${input.source}) — ${input.correctionDetail}`,
  ].join("\n");
}

/**
 * Ask the model for ONE transferable lesson.
 *
 * Deliberately constrained to a single short rule about the SIGNATURE of the case,
 * not a verdict and not a fact about these addresses. A lesson that named an
 * address would be useless (that address is unique) and dangerous (the next
 * investigation would meet it again as "the address we got wrong").
 */
async function generateLessonText(args: {
  aiSide: string;
  realSide: string;
  hint: string;
}): Promise<string> {
  const result = await chat(
    [
      {
        role: "system",
        content: `You write transferable lessons for a crypto-transfer risk agent.

An automated check (a hard rule, a security database, or a human operator) OVERRODE the agent's own judgement on a case. Your job is to state the ONE general principle the agent should have applied, so it does not repeat the mistake on the next case.

RULES:
- Write ONE rule, at most 25 words, in plain ENGLISH, starting with "When ...".
- Write about the SHAPE of the situation, never about the specific addresses or the specific amount. Naming an address is useless, because no future case will have it.
- Do not restate what happened. Write what to DO (or not do) differently.
- Do not hedge and do not mention that the agent "may" be wrong.
- NEVER invent an on-chain fact: you have only the facts below.
- Reply with the rule as plain text. No JSON, no preamble, no bullet points.`,
      },
      {
        role: "user",
        content: `The agent decided ${args.aiSide}. The automated check overrode it and the correct outcome was ${args.realSide}.

Facts:
${args.hint}

Write the one rule the agent should have applied.`,
      },
    ],
    { temperature: 0.2, numPredict: 96, label: "lesson writer" }
  );

  const text = result.content.trim();
  if (text.length < 10) {
    throw new Error("the generator returned an empty lesson");
  }
  return text;
}
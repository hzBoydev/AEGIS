// ── Agent-written lessons memory ────────────────────────────────────────────────
// WHY this table exists
// ────────────────────
// The decision history (`decisions`) records what AEGIS DID. It says nothing about
// what it should have done differently, so every miscalibration repeats forever.
//
// The obvious fix — "let the AI learn from its own verdicts" — is the one thing
// that must NOT happen here: a verdict the system produced and never saw
// corrected is a hypothesis, not ground truth. Writing those lessons back into
// the prompt is how a single bad afternoon turns into a permanent bias: the
// model is told "last time a wallet like this was blocked", with no evidence that
// the block was right, and starts defending the first decision it ever made.
//
// So `agent_lessons` is written ONLY from disagreement with ground truth:
//   - a human operator overrode the AI           (source: human_veto)
//   - a deterministic rule beat the AI          (source: hard_rule)
//   - GoPlus beat the AI                        (source: goplus_override)
// In all three cases a party outside the model decided, and the model was wrong.
// Nothing the AI got right on its own is ever recorded.
//
// Lessons are ADVISORY context. They inform the investigation; they can never
// decide an outcome. `evaluateFinalOutcome()` remains the only authority.

import { db } from "./db.js";

// ── Schema ─────────────────────────────────────────────────────────────────────
// `CREATE TABLE IF NOT EXISTS` — the migration is a no-op on an existing aegis.db,
// matching how every other table in db.ts is created (no versioned migrations in
// this project, by design: a single-file SQLite that is recreated on reset).
db.exec(`
  CREATE TABLE IF NOT EXISTS agent_lessons (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at TEXT    DEFAULT CURRENT_TIMESTAMP,
    escrow_id  TEXT,
    pattern    TEXT    NOT NULL,
    lesson     TEXT    NOT NULL,
    outcome    TEXT    NOT NULL,
    source     TEXT    NOT NULL
  )
`);

// Reading is cheap and the recall path filters in JS; this index serves the
// recency-ordered scan that bounds the candidate set.
db.exec(`
  CREATE INDEX IF NOT EXISTS idx_agent_lessons_created
  ON agent_lessons(created_at DESC)
`);

/**
 * Where a lesson came from. Deliberately a closed set:
 * a lesson may only exist if something OUTSIDE the model corrected it.
 */
export type LessonSource = "human_veto" | "hard_rule" | "goplus_override";

const VALID_SOURCES: ReadonlySet<string> = new Set<LessonSource>([
  "human_veto",
  "hard_rule",
  "goplus_override",
]);

export interface AgentLesson {
  id: number;
  createdAt: string;
  escrowId: string | null;
  /** Short label of the shape of the case ("large transfer to a novel account"). */
  pattern: string;
  /** The transferable rule, one or two sentences. */
  lesson: string;
  /** What actually happened ("REJECT", "RELEASE"). */
  outcome: string;
  source: LessonSource;
}

export interface LessonInput {
  escrowId: string;
  /** Short pattern label. */
  pattern: string;
  /** The lesson text. */
  lesson: string;
  /** What the ground truth decided. */
  outcome: string;
  /** Who corrected the AI. */
  source: LessonSource;
}

/**
 * Persist one lesson.
 *
 * Returns false (without writing) when the input is not eligible: an unknown
 * source, an empty pattern, or a suspiciously long lesson. That last bound
 * matters because the lesson text is model-written — an injected or looping
 * generation must not be able to park a 100 KB blob in the prompt of every
 * future investigation.
 */
export function saveLesson(input: LessonInput): boolean {
  if (!VALID_SOURCES.has(input.source)) {
    console.warn(`[Lessons] Refusing to store a lesson from unknown source '${input.source}'.`);
    return false;
  }
  const pattern = input.pattern.trim().slice(0, 200);
  const lesson = input.lesson.trim().slice(0, 600);
  const outcome = input.outcome.trim().slice(0, 40);
  if (pattern.length < 3 || lesson.length < 10 || outcome.length === 0) {
    console.warn("[Lessons] Refusing to store an incomplete lesson.");
    return false;
  }

  db.prepare(
    "INSERT INTO agent_lessons (escrow_id, pattern, lesson, outcome, source) VALUES (?, ?, ?, ?, ?)"
  ).run(input.escrowId, pattern, lesson, outcome, input.source);
  console.log(
    `[Lessons] Stored lesson (${input.source}) from escrow ${input.escrowId.slice(0, 14)}…: ` +
      `${pattern} → ${lesson}`
  );
  return true;
}

// ── Recall ─────────────────────────────────────────────────────────────────────
/**
 * Token set for keyword overlap. English + the vocabulary this system actually
 * uses (GoPlus flag names are snake_case multi-word tokens, so they are split).
 *
 * Deliberately a plain tokeniser, not an embedding: there is no vector DB here
 * and no dependency budget for one. The corpus is a handful of lessons, so exact
 * token overlap with a couple of stopwords removed is both sufficient and
 * auditable — an operator can read exactly why a lesson surfaced.
 */
const STOPWORDS: ReadonlySet<string> = new Set([
  "the", "and", "for", "that", "this", "with", "from", "was", "has", "have",
  "not", "but", "you", "are", "its", "his", "her", "they", "them", "then",
  "than", "into", "when", "who", "what", "which", "will", "would", "should",
  "could", "can", "did", "does", "been", "being", "there", "here", "about",
  "transfer", "escrow", "aegis", "ai", "the", "a", "an", "of", "to", "in",
  "is", "it", "on", "at", "by", "or", "as", "be",
  // Domain-generic nouns. These are not grammatical noise, but they appear in
  // almost every lesson, so leaving them in makes every query match every lesson
  // and the ranking carries no information.
  "wallet", "address", "account", "fund", "funds", "case", "time", "times",
  "been", "also", "any", "only", "over", "under", "more", "most", "some",
  "such", "than", "then", "them", "very", "just", "like", "make", "made",
  "need", "want", "use", "used", "using", "one", "two", "out", "off", "own",
]);

/** Minimum token length kept after stopword removal — drops "b", "1x", noise. */
const MIN_TOKEN_LEN = 3;

export function tokenize(text: string): Set<string> {
  const out = new Set<string>();
  // Split on anything that is not a letter, digit or underscore. Keeping
  // underscores intact is deliberate: GoPlus reports its findings as multi-word
  // snake_case identifiers (`sanctioned_activities`, `phishing_activities`), and
  // splitting them would reduce every flag to the bare words "sanctioned" and
  // "activities" — which are either stopwords or shared by unrelated flags, so the
  // most specific signal the data source emits would rank the same as noise.
  for (const raw of text.toLowerCase().split(/[^a-z0-9_]+/)) {
    const tok = raw.replace(/^0x/, "");
    if (tok.length < MIN_TOKEN_LEN) continue;
    if (STOPWORDS.has(tok)) continue;
    out.add(tok);
  }
  return out;
}

/** Candidates scanned per recall before ranking. Bounded so recall cannot grow
 *  into a full table scan with an unbounded LIKE-free ranking loop. */
const RECALL_CANDIDATE_LIMIT = 200;

/** Maximum lessons returned. */
export const RECALL_TOP_K = 3;

export interface RecalledLesson extends AgentLesson {
  /** Overlap score against the query (0 when returned as "no match"). */
  score: number;
}

/**
 * Top-k lessons by keyword overlap with `query`.
 *
 * Always returns at least the "empty" payload shape, so the caller can hand it
 * to the model unchanged: an empty result is stated as "no lesson applies", which
 * is a different statement from "recall failed".
 */
export function recallLessons(
  query: string,
  topK: number = RECALL_TOP_K
): { lessons: RecalledLesson[]; note: string } {
  const k = Math.max(1, Math.min(10, Math.floor(topK)));

  let rows: Array<{
    id: number;
    created_at: string;
    escrow_id: string | null;
    pattern: string;
    lesson: string;
    outcome: string;
    source: string;
  }>;
  try {
    rows = db
      .prepare(
        "SELECT id, created_at, escrow_id, pattern, lesson, outcome, source " +
        "FROM agent_lessons ORDER BY created_at DESC, id DESC LIMIT ?"
      )
      .all(RECALL_CANDIDATE_LIMIT) as typeof rows;
  } catch (err) {
    console.warn(
      `[Lessons] Recall failed (${err instanceof Error ? err.message : err}) — treating as "no lessons".`
    );
    return {
      lessons: [],
      note:
        "Lesson memory could not be read. That is UNKNOWN, not a clean bill of health — " +
        "decide on the primary evidence instead.",
    };
  }

  if (rows.length === 0) {
    // The advisory framing is repeated here rather than only on the populated
    // path: "no lessons exist" must not read as "nothing was ever wrong", which is
    // exactly the false reassurance the empty state could otherwise imply.
    return {
      lessons: [],
      note:
        "ADVISORY ONLY — no prior agent lessons exist yet (this is the first corrected case). " +
        "The absence of lessons means nothing has been corrected yet, NOT that the system has " +
        "never been wrong. Decide on the primary evidence alone.",
    };
  }

  const q = tokenize(query);
  const scored: RecalledLesson[] = [];
  for (const row of rows) {
    const text = tokenize(`${row.pattern} ${row.lesson} ${row.outcome} ${row.source}`);
    let score = 0;
    for (const tok of q) {
      if (text.has(tok)) score += 1;
      // A shared GoPlus flag name is a much stronger signal than a shared
      // generic word, so it is weighted — `sanctioned` linking two cases is
      // worth more than `wallet` does.
      else if (/^[a-z]+(_[a-z]+)+$/.test(tok) && text.has(tok.split("_")[0]!)) score += 0.5;
    }
    if (score <= 0) continue;
    if (!VALID_SOURCES.has(row.source)) continue;
    scored.push({
      id: row.id,
      createdAt: row.created_at,
      escrowId: row.escrow_id,
      pattern: row.pattern,
      lesson: row.lesson,
      outcome: row.outcome,
      source: row.source as LessonSource,
      score,
    });
  }

  scored.sort((a, b) => b.score - a.score || b.id - a.id);
  const lessons = scored.slice(0, k);

  return {
    lessons,
    note:
      `ADVISORY ONLY — ${lessons.length} of ${rows.length} stored lesson(es) matched, ranked by ` +
      "keyword overlap. These are past cases where a HUMAN, a hard rule or GoPlus overrode the " +
      "AI. They are context, not a verdict: never treat a matching lesson as proof about the " +
      "current addresses, and never let one decide the outcome on its own. A stored REJECT " +
      "outcome may have been a fail-safe (the AI simply could not analyse it), which is NOT a " +
      "risk finding.",
  };
}

/** Count of stored lessons — surfaced in the red-team/log output. */
export function countLessons(): number {
  const row = db.prepare("SELECT COUNT(*) AS n FROM agent_lessons").get() as
    | { n: number }
    | undefined;
  return row?.n ?? 0;
}
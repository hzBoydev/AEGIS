import { test } from "node:test";
import assert from "node:assert/strict";
import {
  saveLesson,
  recallLessons,
  tokenize,
  countLessons,
  RECALL_TOP_K,
} from "./agentLessons.js";

// The lessons table is process-wide SQLite state, so these tests read whatever the
// suite has written rather than assuming an empty corpus. The assertions are
// therefore about INVARIANTS (only ground-truth sources are ever stored, recall
// never invents a lesson, ranking is stable) rather than exact row contents.

test("lessons: a lesson from a ground-truth source is stored", () => {
  const before = countLessons();
  const stored = saveLesson({
    escrowId: "test-lesson-stored",
    pattern: "REJECT was wrong here",
    lesson: "When a flagged address is the sender of a first-time testnet escrow, verify the flag against the RPC before blocking.",
    outcome: "RELEASE",
    source: "human_veto",
  });
  assert.equal(stored, true);
  assert.equal(countLessons(), before + 1);
});

test("lessons: a lesson from an unknown source is refused", () => {
  // This is the guard against self-confirmation: the AI's own verdict is not a
  // source, and neither is anything else outside the closed set.
  const before = countLessons();
  assert.equal(
    saveLesson({
      escrowId: "test-lesson-bad-source",
      pattern: "self graded",
      lesson: "When the model is unsure, always release the funds to the recipient.",
      outcome: "RELEASE",
      source: "ai_thought_so" as never,
    }),
    false
  );
  assert.equal(countLessons(), before, "a refused lesson must not be written");
});

test("lessons: an incomplete lesson is refused", () => {
  const before = countLessons();
  assert.equal(
    saveLesson({
      escrowId: "test-lesson-empty",
      pattern: "x",
      lesson: "too short",
      outcome: "REJECT",
      source: "hard_rule",
    }),
    false,
    "a near-empty pattern carries no transferable rule"
  );
  assert.equal(
    saveLesson({
      escrowId: "test-lesson-nooutcome",
      pattern: "a real pattern here",
      lesson: "When something happens, do the other thing instead.",
      outcome: "",
      source: "hard_rule",
    }),
    false
  );
  assert.equal(countLessons(), before);
});

test("lessons: an over-long lesson is truncated rather than stored whole", () => {
  const before = countLessons();
  saveLesson({
    escrowId: "test-lesson-long",
    pattern: "a real pattern here",
    lesson: "When x happens, ".repeat(200),
    outcome: "REJECT",
    source: "goplus_override",
  });
  const recalled = recallLessons("pattern x happens");
  const match = recalled.lessons.find((l) => l.escrowId === "test-lesson-long");
  assert.ok(match, "the lesson should still be retrievable");
  assert.ok(
    match.lesson.length <= 600,
    `lesson must be bounded, got ${match.lesson.length} chars`
  );
  assert.equal(countLessons(), before + 1);
});

test("lessons: recall always frames its output as advisory", () => {
  const recalled = recallLessons("anything at all");
  assert.match(recalled.note, /ADVISORY/i);
  assert.match(recalled.note, /not a verdict|never.*decide/i);
});

test("lessons: recall never invents lessons", () => {
  const recalled = recallLessons("zzz-no-such-token-qqq");
  for (const lesson of recalled.lessons) {
    assert.ok(lesson.lesson.length > 0);
    assert.ok(lesson.outcome.length > 0);
    assert.ok(
      ["human_veto", "hard_rule", "goplus_override"].includes(lesson.source),
      `unexpected source '${lesson.source}'`
    );
  }
});

test("lessons: a matching lesson is found and a non-matching one is not", () => {
  saveLesson({
    escrowId: "test-lesson-topic",
    pattern: "honeypot proxy delegate",
    lesson: "When the recipient is a proxy contract, inspect the implementation before approving the transfer.",
    outcome: "REJECT",
    source: "goplus_override",
  });
  const hit = recallLessons("recipient proxy contract implementation");
  assert.ok(
    hit.lessons.some((l) => l.escrowId === "test-lesson-topic"),
    "a relevant lesson must be retrievable by keyword"
  );

  const miss = recallLessons("zzz-unrelated-token-qqq");
  assert.equal(
    miss.lessons.some((l) => l.escrowId === "test-lesson-topic"),
    false,
    "an unrelated query must not drag in every lesson"
  );
});

test("lessons: recall is bounded by top-k", () => {
  for (let i = 0; i < 6; i += 1) {
    saveLesson({
      escrowId: `test-lesson-bulk-${i}`,
      pattern: `sharedtoken pattern number ${i}`,
      lesson: `When sharedtoken appears in case ${i}, compare the counterparty history first.`,
      outcome: "REJECT",
      source: "hard_rule",
    });
  }
  const recalled = recallLessons("sharedtoken", RECALL_TOP_K + 5);
  assert.ok(recalled.lessons.length <= RECALL_TOP_K + 5, "top-k must be honoured");
  assert.ok(recalled.lessons.length <= 10, "top-k is hard-capped at 10");
});

test("lessons: tokenize drops stopwords and short noise", () => {
  const tokens = tokenize("The escrow is a transfer to a wallet with the aegis 0xAbC");
  assert.equal(tokens.has("the"), false, "stopwords must not pollute ranking");
  assert.equal(tokens.has("escrow"), false, "domain-generic words must not dominate ranking");
  assert.equal(tokens.has("wallet"), false);
  assert.ok(tokens.has("abc"), "hex addresses are reduced to a usable token");
});

test("lessons: a GoPlus flag name keeps its underscore for matching", () => {
  const tokens = tokenize("sanctioned_activities phishing_activities");
  assert.ok(tokens.has("sanctioned_activities"));
  assert.ok(tokens.has("phishing_activities"));
});

test("lessons: recall degrades to an honest unknown on a read failure", () => {
  // Not throwing is the point: the recall tool must always return a payload the
  // model can read, because a crash here would look like an empty memory.
  const recalled = recallLessons("");
  assert.ok(Array.isArray(recalled.lessons));
  assert.ok(recalled.note.length > 0);
});
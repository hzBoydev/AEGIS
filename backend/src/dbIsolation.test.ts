import { test } from "node:test";
import assert from "node:assert/strict";
import { db, DB_PATH } from "./db.js";
// Imported for its schema side effects, exactly as `tools.ts` does in production:
// `agent_lessons` is created by the module that owns it, not by `db.ts`. Importing it
// here is also what makes the isolation test cover the module the lesson suite uses.
import "./agentLessons.js";

// The tests must not touch the production database.
//
// This is asserted rather than assumed because the failure is invisible: a suite that
// writes to `aegis.db` still passes, still prints green, and leaves ~9 rows per run
// in `agent_lessons` — the table `recall_lessons` feeds to the Investigator. The next
// real escrow then recalls a lesson written by a unit test, and the hearing is decided
// on fixture data. Nothing crashes; the oracle is just quietly wrong.

test("db: the test suite runs on an in-memory database, never aegis.db", () => {
  // better-sqlite3 exposes the resolved name; for the in-memory database it is the
  // literal ":memory:". A file-backed test run would show an absolute path here.
  assert.equal(
    db.name,
    ":memory:",
    `tests must run in-memory (AEGIS_DB_PATH was ${process.env.AEGIS_DB_PATH ?? "unset"}, ` +
      `resolved to ${DB_PATH}) — otherwise this suite is writing to a real database`
  );
  assert.equal(DB_PATH, ":memory:");
  assert.notEqual(DB_PATH, "aegis.db", "the default production path must not be reachable from a test");
});

test("db: AEGIS_DB_PATH overrides the path, and is what the runner sets", () => {
  // The override has to exist as well as the test-mode default: pointing a run at a
  // scratch file is how you inspect a fixture database after the fact.
  assert.equal(process.env.AEGIS_DB_PATH, ":memory:", "the test bootstrap must set the override");
});

test("db: the schema the pipeline needs exists in the test database", () => {
  // Isolation is only safe if the in-memory database is a real substitute: a suite
  // that quietly ran against an empty schema would pass while testing nothing. This
  // is the assertion that would have caught "isolated but missing migrations".
  const tables = (
    db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>
  ).map((r) => r.name);
  for (const required of ["decisions", "agent_lessons"]) {
    assert.ok(tables.includes(required), `missing table ${required} — the in-memory DB is not a substitute`);
  }
});

test("db: fixture rows go to the in-memory database and nowhere else", () => {
  // Written with the same shape the lesson suite uses, and verified through the same
  // connection the pipeline would use. The assertion is that the row is VISIBLE here
  // and that the process never opened a file to put it in.
  const escrowId = "test-db-isolation-probe";
  db.prepare(
    `INSERT INTO agent_lessons (escrow_id, pattern, lesson, outcome, source)
     VALUES (?, ?, ?, ?, ?)`
  ).run(escrowId, "RELEASE was wrong here", "probe", "REJECT", "hard_rule");

  const row = db
    .prepare("SELECT COUNT(*) AS n FROM agent_lessons WHERE escrow_id = ?")
    .get(escrowId) as { n: number };
  assert.equal(row.n, 1, "the insert must be readable through the shared connection");
  assert.equal(db.name, ":memory:", "and it must have landed in memory, not on disk");
});

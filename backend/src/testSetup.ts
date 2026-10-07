// ── Test bootstrap ─────────────────────────────────────────────────────────────
// WHY THIS EXISTS
// ───────────────
// `npm test` must never open the production `aegis.db`. The test suites import
// modules that reach `db.ts` at module scope (`tools.ts` → `agentLessons.ts` →
// `db.ts`), so the decision has to be made BEFORE any of them is evaluated — an
// `import { db } from "./db.js"` assertion inside a test is already too late, and so
// is any `process.env` assignment in the middle of a file.
//
// It is wired in as a `--import` (see the `test` script in package.json), which node
// evaluates before the test files, and which it passes on to the per-file child
// processes it spawns. That is the equivalent of vitest's `test.env` / `setupFiles`
// for this project's runner.
//
// `NODE_ENV` is set as well as `AEGIS_DB_PATH`: `db.ts` accepts either signal, so a
// developer running a single file by hand (`node --import tsx src/foo.test.ts`, or
// an IDE runner) is protected by the NODE_ENV check even without this file, while
// this file's explicit AEGIS_DB_PATH wins even if something else set NODE_ENV.
//
// `:memory:` rather than a temp file: the suites only need somewhere to put rows
// they create themselves, and an in-memory database cannot be left behind, cannot be
// committed by accident, and cannot outlive the process to be read by the next run.

process.env.NODE_ENV = process.env.NODE_ENV ?? "test";
process.env.AEGIS_DB_PATH = process.env.AEGIS_DB_PATH ?? ":memory:";

// Loud on purpose: if this file ever stops being loaded, the pollution comes back
// silently, and the only warning is a `test-%` row in the production DB months later.
console.log(
  `[Test]    bootstrap loaded — AEGIS_DB_PATH=${process.env.AEGIS_DB_PATH} ` +
    `(the real aegis.db is not touched)`
);

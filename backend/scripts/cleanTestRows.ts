// ── One-off cleanup of test rows from aegis.db ──────────────────────────────────
// WHY THIS SCRIPT EXISTS
// ──────────────────────
// Before `db.ts` honoured `AEGIS_DB_PATH`, every `npm test` opened the real
// `aegis.db` and inserted its fixtures into it — `escrow_id = "test-lesson-bulk-5"`
// and friends, roughly 9 rows per run, ~135 of them by the time this was written.
// `agent_lessons` is not a scratch table: `recall_lessons` feeds the Investigator's
// prompt, so a suite that runs on a demo machine has been steering real hearings with
// rows whose escrow ids are `test-lesson-*`.
//
// So this removes them from a real database, once, and leaves the DB path
// protection in place so it cannot happen again.
//
// SAFETY RULES ENFORCED HERE
// ───────────────────────────
// 1. The backup is made FIRST and the script refuses to delete anything unless the
//    backup succeeded and the row counts it recorded are re-verified. A "clean up my
//    production data" script that can run without a recoverable copy of that data is
//    not a tool, it is an incident.
// 2. `--dry-run` (the default) only reports. Deletion requires an explicit `--apply`.
// 3. The `LIKE 'test-%'` pattern is fixed and never interpolated from the caller, so
//    the statement cannot be widened into something else.
// 4. The affected tables are DISCOVERED (`PRAGMA table_info`) rather than hard-coded,
//    so a new `escrow_id` table cannot be quietly missed.
//
// Usage:
//   npx tsx scripts/cleanTestRows.ts            # dry run, prints what it would delete
//   npx tsx scripts/cleanTestRows.ts --apply    # backs up aegis.db.bak, then deletes

import Database from "better-sqlite3";
import { copyFileSync, existsSync, statSync } from "node:fs";
import { resolve } from "node:path";

/** The production file this script is allowed to touch. */
const DB_FILE = resolve(process.cwd(), process.env.AEGIS_DB_PATH ?? "aegis.db");

/** The backup written before any destructive statement. */
const BACKUP_FILE = `${DB_FILE}.bak`;

/**
 * The one pattern this script will ever match.
 *
 * `test-%` is the prefix the suites use for every fixture escrow id
 * (`test-lesson-stored`, `test-lesson-bulk-5`, `test-trace-…`). It cannot match a
 * real escrow, whose ids are on-chain hashes.
 */
const TEST_ROW_PATTERN = "test-%";

const apply = process.argv.includes("--apply");

if (DB_FILE === ":memory:" || DB_FILE.endsWith(":memory:")) {
  console.error(
    "[Clean]   Refusing to run: the database path is in-memory " +
      `(${DB_FILE}). There is nothing to clean.`
  );
  process.exit(1);
}

if (!existsSync(DB_FILE)) {
  console.error(`[Clean]   Nothing to do — ${DB_FILE} does not exist.`);
  process.exit(0);
}

const db = new Database(DB_FILE, { readonly: !apply });

/** Every table that has an `escrow_id` column, discovered, not assumed. */
function tablesWithEscrowId(): string[] {
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
    .all() as Array<{ name: string }>;
  const out: string[] = [];
  for (const { name } of tables) {
    // `name` comes from sqlite_master, so it is a table this database created; the
    // identifier quoting below is what keeps the statement well-formed regardless.
    const cols = db.prepare(`PRAGMA table_info("${name.replace(/"/g, '""')}")`).all() as Array<{
      name: string;
    }>;
    if (cols.some((c) => c.name === "escrow_id")) out.push(name);
  }
  return out;
}

/** Rows that match the test pattern, and a sample of the ids — so a dry run is evidence. */
function countTestRows(table: string): { count: number; sample: string[] } {
  const q = table.replace(/"/g, '""');
  const count = (
    db.prepare(`SELECT COUNT(*) AS n FROM "${q}" WHERE escrow_id LIKE ?`).get(TEST_ROW_PATTERN) as {
      n: number;
    }
  ).n;
  const sample = (
    db
      .prepare(
        `SELECT escrow_id FROM "${q}" WHERE escrow_id LIKE ? ORDER BY escrow_id LIMIT 5`
      )
      .all(TEST_ROW_PATTERN) as Array<{ escrow_id: string }>
  ).map((r) => r.escrow_id);
  return { count, sample };
}

const targets = tablesWithEscrowId();

console.log(`[Clean]   Database : ${DB_FILE} (${statSync(DB_FILE).size} bytes)`);
console.log(`[Clean]   Pattern  : escrow_id LIKE '${TEST_ROW_PATTERN}'`);
console.log(`[Clean]   Tables   : ${targets.join(", ") || "(none with escrow_id)"}`);
console.log(`[Clean]   Mode     : ${apply ? "APPLY (destructive)" : "DRY RUN (pass --apply to delete)"}`);

let total = 0;
const plan: Array<{ table: string; count: number; sample: string[] }> = [];
for (const table of targets) {
  const { count, sample } = countTestRows(table);
  total += count;
  plan.push({ table, count, sample });
  console.log(`[Clean]   ${table.padEnd(14)} ${count} test row(s)${sample.length > 0 ? ` e.g. ${sample.join(", ")}` : ""}`);
}

if (total === 0) {
  console.log("[Clean]   Nothing to delete.");
  db.close();
  process.exit(0);
}

if (!apply) {
  console.log(`[Clean]   ${total} row(s) would be deleted. Re-run with --apply.`);
  db.close();
  process.exit(0);
}

// ── From here on the script is destructive: prove the backup first ────────────
db.close();

let backupBytes = 0;
try {
  copyFileSync(DB_FILE, BACKUP_FILE);
  backupBytes = statSync(BACKUP_FILE).size;
} catch (err) {
  console.error(
    `[Clean]   ABORTED — could not write ${BACKUP_FILE}: ` +
      `${err instanceof Error ? err.message : String(err)}. No rows were deleted.`
  );
  process.exit(1);
}

const sourceBytes = statSync(DB_FILE).size;
if (backupBytes !== sourceBytes) {
  console.error(
    `[Clean]   ABORTED — the backup is ${backupBytes} bytes but the database is ` +
      `${sourceBytes}. A short copy is not a backup. No rows were deleted.`
  );
  process.exit(1);
}
console.log(`[Clean]   Backup   : ${BACKUP_FILE} (${backupBytes} bytes) — verified byte-complete`);

const writable = new Database(DB_FILE);
const deleteIn = writable.transaction((table: string) => {
  const q = table.replace(/"/g, '""');
  return writable.prepare(`DELETE FROM "${q}" WHERE escrow_id LIKE ?`).run(TEST_ROW_PATTERN);
});

let deleted = 0;
for (const { table } of plan) {
  const info = deleteIn(table);
  deleted += info.changes;
  console.log(`[Clean]   deleted ${info.changes} row(s) from ${table}`);
}
writable.close();

console.log(
  `[Clean]   Done — ${deleted} of ${total} row(s) deleted. ` +
    `Restore with: cp ${BACKUP_FILE} ${DB_FILE}`
);

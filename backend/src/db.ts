import Database from "better-sqlite3";

/**
 * Where the SQLite file lives.
 *
 * The test branch is a SAFETY property, not a convenience. `agentLessons.test.ts` and
 * `tools.test.ts` import this module, so without it `npm test` opened the real
 * `aegis.db` and INSERTED ~135 dummy lessons (`escrow_id = "test-lesson-bulk-5"`, …)
 * into the production decision history on every run. That is not a test artifact you
 * notice later: it poisons the very memory the Investigator recalls from, so a
 * hearing can be steered by rows a test wrote, and the `decisions` audit trail mixes
 * demo data with real ones.
 *
 * `AEGIS_DB_PATH` is checked FIRST so a run can be pointed at a specific file
 * (a scratch copy, a demo database) without editing code, and `NODE_ENV=test` is
 * checked alongside `VITEST` because this project runs its suite with node's built-in
 * test runner — the two are equivalent signals, and either one means "in-memory".
 *
 * `NODE_TEST_CONTEXT` is the important one, and it is checked because of what it
 * prevents. `NODE_ENV` and `VITEST` are things a developer has to REMEMBER to set, and
 * forgetting is exactly what happened here: a bare `npx tsx --test src/some.test.ts`
 * carries neither, so it opened the real `aegis.db` and the suite's `DELETE FROM
 * decisions` in `beforeEach` wiped the demo history. `NODE_TEST_CONTEXT` is set by
 * node's own test runner in every test file, needs no cooperation, and cannot be
 * forgotten — so any `node --test` / `tsx --test` invocation lands in memory even
 * without the `--import ./src/testSetup.js` bootstrap.
 */
const DB_PATH =
  process.env.AEGIS_DB_PATH ??
  (process.env.VITEST ||
  process.env.NODE_ENV === "test" ||
  process.env.NODE_TEST_CONTEXT
    ? ":memory:"
    : "aegis.db");

/** Shared connection to the AEGIS SQLite file. Exported for read-only modules
 *  (e.g. agentMemory) so the process keeps a single connection. */
export const db: Database.Database = new Database(DB_PATH);

/** The resolved path, so a test (or a log line) can assert where it is writing. */
export { DB_PATH };

if (DB_PATH === ":memory:") {
  console.log("[DB]      Using an in-memory database (test mode) — aegis.db is NOT touched.");
}

// ── Schema ────────────────────────────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS decisions (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    escrow_id   TEXT    NOT NULL,
    sender      TEXT    NOT NULL,
    recipient   TEXT    NOT NULL,
    amount      TEXT    NOT NULL,
    eligible    INTEGER NOT NULL,
    confidence  REAL    NOT NULL,
    reasoning   TEXT    NOT NULL,
    risk_level  TEXT,
    decided_by  TEXT,
    risk_flags  TEXT,
    tx_hash     TEXT,
    tools_used  TEXT,
    debate      TEXT,
    status      TEXT    NOT NULL DEFAULT 'final',
    human_vote  INTEGER,
    human_reason TEXT,
    created_at  TEXT    DEFAULT CURRENT_TIMESTAMP
  )
`);

// Migrate existing databases that may not have the new columns
const existingColumns = db
  .prepare("PRAGMA table_info(decisions)")
  .all() as Array<{ name: string }>;

const colNames = existingColumns.map((c) => c.name);

if (!colNames.includes("risk_level")) {
  db.exec("ALTER TABLE decisions ADD COLUMN risk_level TEXT");
}
if (!colNames.includes("decided_by")) {
  db.exec("ALTER TABLE decisions ADD COLUMN decided_by TEXT");
}
if (!colNames.includes("risk_flags")) {
  db.exec("ALTER TABLE decisions ADD COLUMN risk_flags TEXT");
}
if (!colNames.includes("tools_used")) {
  db.exec("ALTER TABLE decisions ADD COLUMN tools_used TEXT");
}
if (!colNames.includes("debate")) {
  db.exec("ALTER TABLE decisions ADD COLUMN debate TEXT");
}
if (!colNames.includes("status")) {
  db.exec("ALTER TABLE decisions ADD COLUMN status TEXT NOT NULL DEFAULT 'final'");
}
if (!colNames.includes("human_vote")) {
  db.exec("ALTER TABLE decisions ADD COLUMN human_vote INTEGER");
}
if (!colNames.includes("human_reason")) {
  db.exec("ALTER TABLE decisions ADD COLUMN human_reason TEXT");
}

// ── De-dup: 1 escrow = 1 decision ────────────────────────────────────────────
// The poller may reprocess after a tsx restart (in-memory Set is empty) —
// UNIQUE prevents two pending_human rows for the same escrow.
db.exec(`
  DELETE FROM decisions
  WHERE id NOT IN (
    SELECT MIN(id) FROM decisions GROUP BY escrow_id
  )
`);
db.exec(`
  CREATE UNIQUE INDEX IF NOT EXISTS idx_decisions_escrow_id
  ON decisions(escrow_id)
`);

// ── Interfaces ────────────────────────────────────────────────────────────────
export type DecisionStatus = "final" | "pending_human";

export interface DecisionRecord {
  escrowId: string;
  sender: string;
  recipient: string;
  amount: string;
  eligible: boolean;
  confidence: number;
  reasoning: string;
  riskLevel?: string;
  decidedBy?: string;
  riskFlags?: string[];
  txHash?: string;
  /** Tools the AI executed for this decision (tool calling). */
  toolsUsed?: string[];
  /** Multi-agent hearing transcript (Investigator → Advocate → Judge). */
  debate?: unknown;
  /** final = already on-chain; pending_human = hold, awaiting a vote. */
  status?: DecisionStatus;
  humanReason?: string | undefined;
}

export interface PendingHumanRow {
  id: number;
  escrow_id: string;
  sender: string;
  recipient: string;
  amount: string;
  eligible: number;
  confidence: number;
  reasoning: string;
  risk_level: string | null;
  decided_by: string | null;
  debate: string | null;
  status: string;
  human_reason: string | null;
  human_vote: number | null;
  tx_hash: string | null;
  created_at: string;
}

// ── Queries ───────────────────────────────────────────────────────────────────
export function saveDecision(record: DecisionRecord): void {
  const existing = getDecisionByEscrowId(record.escrowId) as
    | { id?: number }
    | undefined;
  if (existing) {
    console.warn(
      `[DB] skip saveDecision — escrow_id already exists: ${record.escrowId.slice(0, 14)}…`
    );
    return;
  }

  const stmt = db.prepare(`
    INSERT INTO decisions
      (escrow_id, sender, recipient, amount, eligible, confidence, reasoning,
       risk_level, decided_by, risk_flags, tx_hash, tools_used, debate,
       status, human_reason)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  stmt.run(
    record.escrowId,
    record.sender,
    record.recipient,
    record.amount,
    record.eligible ? 1 : 0,
    record.confidence,
    record.reasoning,
    record.riskLevel ?? null,
    record.decidedBy ?? null,
    record.riskFlags ? JSON.stringify(record.riskFlags) : null,
    record.txHash ?? null,
    record.toolsUsed && record.toolsUsed.length > 0
      ? JSON.stringify(record.toolsUsed)
      : null,
    record.debate !== undefined ? JSON.stringify(record.debate) : null,
    record.status ?? "final",
    record.humanReason ?? null
  );
}

/** Clamp a caller-supplied LIMIT into a safe, bounded integer. */
function toLimit(limit: number): number {
  return Math.max(1, Math.min(500, Math.floor(limit)));
}

export function getAllDecisions(limit: number = 50): unknown[] {
  return db
    .prepare("SELECT * FROM decisions ORDER BY created_at DESC, id DESC LIMIT ?")
    .all(toLimit(limit));
}

export function getDecisionsCount(): number {
  const row = db.prepare("SELECT COUNT(*) AS n FROM decisions").get() as
    | { n: number }
    | undefined;
  return row?.n ?? 0;
}

/** Escrow history involving a given address (sender OR recipient). */
export function getAllDecisionsForAddress(address: string, limit: number): unknown[] {
  const addr = address.toLowerCase();
  return db
    .prepare(
      `SELECT * FROM decisions
       WHERE LOWER(sender) = ? OR LOWER(recipient) = ?
       ORDER BY created_at DESC, id DESC LIMIT ?`
    )
    .all(addr, addr, toLimit(limit));
}

export function getDecisionsCountForAddress(address: string): number {
  const addr = address.toLowerCase();
  const row = db
    .prepare(
      "SELECT COUNT(*) AS n FROM decisions WHERE LOWER(sender) = ? OR LOWER(recipient) = ?"
    )
    .get(addr, addr) as { n: number } | undefined;
  return row?.n ?? 0;
}

/** Set of escrow_id values that ever involved an address — used to filter the hearing archive. */
export function getEscrowIdsInvolving(address: string): Set<string> {
  const addr = address.toLowerCase();
  const rows = db
    .prepare(
      "SELECT escrow_id FROM decisions WHERE LOWER(sender) = ? OR LOWER(recipient) = ?"
    )
    .all(addr, addr) as Array<{ escrow_id: string }>;
  return new Set(rows.map((r) => r.escrow_id));
}

export function getDecisionByEscrowId(escrowId: string): unknown {
  return db
    .prepare("SELECT * FROM decisions WHERE escrow_id = ?")
    .get(escrowId);
}

/** Escrows still waiting for a human vote (1 row per escrow_id). */
export function getPendingHumanDecisions(): PendingHumanRow[] {
  return db
    .prepare(
      `SELECT * FROM decisions
       WHERE status = 'pending_human'
         AND id IN (
           SELECT MIN(id) FROM decisions
           WHERE status = 'pending_human'
           GROUP BY escrow_id
         )
       ORDER BY created_at DESC`
    )
    .all() as PendingHumanRow[];
}

export function getPendingHumanByEscrowId(
  escrowId: string
): PendingHumanRow | undefined {
  return db
    .prepare(
      `SELECT * FROM decisions
       WHERE escrow_id = ? AND status = 'pending_human'
       ORDER BY id ASC LIMIT 1`
    )
    .get(escrowId) as PendingHumanRow | undefined;
}

/**
 * Finalize after the human vote: update the pending row → final + on-chain tx.
 *
 * `eligible` is the OUTCOME column: eligible=1 means the funds were actually
 * released to the recipient. `human_vote` is the operator's opinion.
 *
 * These are not always the same, and conflating them corrupts the agent memory:
 * when an escrow has already expired, the vote cannot be executed and the funds
 * go back to the sender, so `eligible` must be 0 even if the operator pressed
 * APPROVE. Hence the separate `fundsReleased` parameter (defaults to the vote).
 */
export function finalizeHumanDecision(input: {
  escrowId: string;
  humanVote: boolean;
  /** Whether the funds actually went to the recipient. Default = humanVote. */
  fundsReleased?: boolean;
  humanReason: string;
  finalReason: string;
  decidedBy: string;
  txHash: string;
}): boolean {
  const released = input.fundsReleased ?? input.humanVote;
  const info = db
    .prepare(
      `UPDATE decisions SET
        eligible = ?,
        reasoning = ?,
        decided_by = ?,
        tx_hash = ?,
        status = 'final',
        human_vote = ?,
        human_reason = ?
      WHERE escrow_id = ? AND status = 'pending_human'`
    )
    .run(
      released ? 1 : 0,
      input.finalReason,
      input.decidedBy,
      input.txHash,
      input.humanVote ? 1 : 0,
      input.humanReason,
      input.escrowId
    );
  return info.changes > 0;
}

// ── Counterparty similarity (tool: find_similar_rejected) ─────────────────────
export interface SimilarRejectedEntry {
  /** The 1-hop counterparty address. */
  address: string;
  /** Escrows this address shares with the queried address (either direction). */
  sharedEscrows: number;
  /** How many of those were REJECTED. */
  sharedRejected: number;
  /**
   * How many REJECTED escrows this address is involved in at all (as sender OR
   * recipient). This is the "shared sender with a rejected recipient" signal: a
   * counterparty that has been on the losing side of an escrow elsewhere.
   */
  totalRejections: number;
  /** Which side of a shared escrow it appeared on. */
  role: "sender" | "recipient" | "both";
  /** Most recent rejected escrow_id involving this counterparty, for auditing. */
  lastRejectedEscrowId: string | null;
  /**
   * Who rejected those escrows. CRITICAL for interpretation: `fail_safe` means
   * the AI could not analyse it and we blocked defensively — that is NOT a risk
   * finding. `human_veto` means a person declined it. `rules`/`goplus` mean a
   * deterministic or third-party check decided.
   */
  decidedBy: string[];
}

export interface SimilarRejectedResult {
  address: string;
  /** Counterparties inspected (bounded). */
  examined: number;
  /** True when the sample was truncated, so counts are a LOWER BOUND. */
  truncated: boolean;
  matches: SimilarRejectedEntry[];
  note: string;
}

/** Cap on how many counterparties one query inspects. */
const SIMILARITY_SCAN_LIMIT = 25;

/**
 * 1-hop lookup: which addresses that have shared an escrow with this one were
 * themselves rejected by AEGIS?
 *
 * Strictly one hop and strictly read-only. Two properties matter:
 *  - Ground truth only. `status = 'final'` excludes `pending_human` rows, which
 *    store the AI's *recommendation*; including them would let the system
 *    remember its own guess as evidence against a counterparty (the exact
 *    self-confirming loop `getAddressMemory` avoids).
 *  - `decided_by` is reported so the model can tell a human veto from a
 *    fail-safe. A fail-safe row means "we could not analyse it", which is NOT
 *    evidence that the counterparty is dangerous.
 */
export function findSimilarRejectedEscrows(address: string): SimilarRejectedResult {
  const addr = address.toLowerCase();

  const shared = db
    .prepare(
      "SELECT escrow_id, LOWER(sender) AS sender, LOWER(recipient) AS recipient, " +
      "eligible, decided_by FROM decisions " +
      "WHERE status = 'final' AND (LOWER(sender) = ? OR LOWER(recipient) = ?) " +
      "ORDER BY created_at DESC, id DESC LIMIT ?"
    )
    .all(addr, addr, SIMILARITY_SCAN_LIMIT * 4) as Array<{
    escrow_id: string;
    sender: string;
    recipient: string;
    eligible: number;
    decided_by: string | null;
  }>;

  const map = new Map<
    string,
    { sharedEscrows: number; sharedRejected: number; roles: Set<"sender" | "recipient"> }
  >();
  for (const row of shared) {
    const role: "sender" | "recipient" =
      row.sender === addr ? "sender" : "recipient";
    const other = role === "sender" ? row.recipient : row.sender;
    if (!other || other === addr) continue;
    let entry = map.get(other);
    if (!entry) {
      entry = { sharedEscrows: 0, sharedRejected: 0, roles: new Set() };
      map.set(other, entry);
    }
    entry.sharedEscrows += 1;
    entry.roles.add(role);
    if (row.eligible === 0) entry.sharedRejected += 1;
    if (map.size >= SIMILARITY_SCAN_LIMIT) break;
  }

  const truncated = map.size >= SIMILARITY_SCAN_LIMIT;
  const counterparties = [...map.keys()];
  const matches: SimilarRejectedEntry[] = [];

  if (counterparties.length > 0) {
    const placeholders = counterparties.map(() => "?").join(",");
    const rejectedRows = db
      .prepare(
        "SELECT escrow_id, LOWER(sender) AS sender, LOWER(recipient) AS recipient, decided_by " +
        "FROM decisions WHERE status = 'final' AND eligible = 0 " +
        `AND (LOWER(sender) IN (${placeholders}) OR LOWER(recipient) IN (${placeholders})) ` +
        "ORDER BY created_at DESC, id DESC LIMIT 400"
      )
      .all(...counterparties, ...counterparties) as Array<{
      escrow_id: string;
      sender: string;
      recipient: string;
      decided_by: string | null;
    }>;

    const totals = new Map<string, { n: number; lastId: string | null; by: string[] }>();
    for (const row of rejectedRows) {
      for (const side of [row.sender, row.recipient]) {
        if (!counterparties.includes(side)) continue;
        let t = totals.get(side);
        if (!t) {
          t = { n: 0, lastId: null, by: [] };
          totals.set(side, t);
        }
        t.n += 1;
        if (t.lastId === null) t.lastId = row.escrow_id;
        if (row.decided_by && !t.by.includes(row.decided_by)) {
          t.by.push(row.decided_by);
        }
      }
    }

    for (const [other, entry] of map) {
      const total = totals.get(other);
      if (!total || total.n === 0) continue;
      matches.push({
        address: other,
        sharedEscrows: entry.sharedEscrows,
        sharedRejected: entry.sharedRejected,
        totalRejections: total.n,
        role:
          entry.roles.size > 1
            ? "both"
            : entry.roles.has("sender")
              ? "sender"
              : "recipient",
        lastRejectedEscrowId: total.lastId,
        decidedBy: total.by,
      });
    }
  }

  matches.sort((a, b) => b.totalRejections - a.totalRejections);

  return {
    address,
    examined: counterparties.length,
    truncated,
    matches,
    note:
      "AEGIS internal DATABASE history — NOT on-chain data, and FINAL decisions only. " +
      "Read `decidedBy` before drawing any conclusion: a 'fail_safe' row means the AI could not " +
      "analyse that escrow, which is NOT a risk finding, while 'human_veto' means a person " +
      "declined it. This is a CONTEXT signal: it describes other addresses that shared an escrow " +
      "with this one, and it can never by itself decide this escrow.",
  };
}

// ── Tool-calling history queries ──────────────────────────────────────────────
export interface SenderEscrowSummary {
  total: number;
  approved: number;
  rejected: number;
  /** Other recipients that this sender has ever sent escrows to. */
  otherRecipients: string[];
  recent: Array<{
    recipient: string;
    amount: string;
    eligible: boolean;
    createdAt: string;
  }>;
}

export interface RecipientEscrowSummary {
  total: number;
  approved: number;
  rejected: number;
  /** Number of distinct senders that have ever sent to this recipient. */
  distinctSenders: number;
  recent: Array<{
    sender: string;
    amount: string;
    eligible: boolean;
    decidedBy: string | null;
    createdAt: string;
  }>;
}

/** AEGIS escrow history from the SENDER side (tool: get_sender_db_history). */
export function getSenderEscrowHistory(sender: string): SenderEscrowSummary {
  const addr = sender.toLowerCase();

  const agg = db
    .prepare(
      "SELECT COUNT(*) AS total, " +
      "COALESCE(SUM(CASE WHEN eligible = 1 THEN 1 ELSE 0 END), 0) AS approved, " +
      "COALESCE(SUM(CASE WHEN eligible = 0 THEN 1 ELSE 0 END), 0) AS rejected " +
      "FROM decisions WHERE LOWER(sender) = ?"
    )
    .get(addr) as { total: number; approved: number; rejected: number };

  const otherRows = db
    .prepare(
      "SELECT recipient FROM decisions WHERE LOWER(sender) = ? " +
      "GROUP BY recipient ORDER BY MAX(created_at) DESC LIMIT 10"
    )
    .all(addr) as Array<{ recipient: string }>;

  const recentRows = db
    .prepare(
      "SELECT recipient, amount, eligible, created_at FROM decisions " +
      "WHERE LOWER(sender) = ? ORDER BY created_at DESC LIMIT 10"
    )
    .all(addr) as Array<{
    recipient: string;
    amount: string;
    eligible: number;
    created_at: string;
  }>;

  return {
    total: agg?.total ?? 0,
    approved: agg?.approved ?? 0,
    rejected: agg?.rejected ?? 0,
    otherRecipients: otherRows.map((r) => r.recipient),
    recent: recentRows.map((r) => ({
      recipient: r.recipient,
      amount: r.amount,
      eligible: r.eligible === 1,
      createdAt: r.created_at,
    })),
  };
}

/** AEGIS escrow history from the RECIPIENT side, across senders (tool: get_recipient_db_history). */
export function getRecipientEscrowHistory(
  recipient: string
): RecipientEscrowSummary {
  const addr = recipient.toLowerCase();

  const agg = db
    .prepare(
      "SELECT COUNT(*) AS total, " +
      "COALESCE(SUM(CASE WHEN eligible = 1 THEN 1 ELSE 0 END), 0) AS approved, " +
      "COALESCE(SUM(CASE WHEN eligible = 0 THEN 1 ELSE 0 END), 0) AS rejected, " +
      "COUNT(DISTINCT LOWER(sender)) AS distinctSenders " +
      "FROM decisions WHERE LOWER(recipient) = ?"
    )
    .get(addr) as {
    total: number;
    approved: number;
    rejected: number;
    distinctSenders: number;
  };

  const recentRows = db
    .prepare(
      "SELECT sender, amount, eligible, decided_by, created_at FROM decisions " +
      "WHERE LOWER(recipient) = ? ORDER BY created_at DESC LIMIT 10"
    )
    .all(addr) as Array<{
    sender: string;
    amount: string;
    eligible: number;
    decided_by: string | null;
    created_at: string;
  }>;

  return {
    total: agg?.total ?? 0,
    approved: agg?.approved ?? 0,
    rejected: agg?.rejected ?? 0,
    distinctSenders: agg?.distinctSenders ?? 0,
    recent: recentRows.map((r) => ({
      sender: r.sender,
      amount: r.amount,
      eligible: r.eligible === 1,
      decidedBy: r.decided_by,
      createdAt: r.created_at,
    })),
  };
}

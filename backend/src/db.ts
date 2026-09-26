import Database from "better-sqlite3";
import { logger } from "./logger.js";
import { config } from "./config.js";

// Satu koneksi tunggal untuk seluruh proses (lihat getDb()). Dua koneksi
// terpisah ke file yang sama = risiko SQLITE_BUSY saat write concurrent.
const db = new Database(config.DB_PATH);

// Mode yang aman untuk concurrent read (poller) + write (saveDecision).
db.pragma("journal_mode = WAL");
db.pragma("busy_timeout = 5000");
db.pragma("synchronous = NORMAL");

/** Koneksi SQLite tunggal — dipakai juga oleh agentMemory.ts. */
export function getDb(): Database.Database {
  return db;
}

/** Tutup koneksi dengan rapi saat shutdown. */
export function closeDb(): void {
  db.close();
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
// Poller bisa proses ulang setelah tsx restart (Set in-memory kosong) —
// UNIQUE mencegah dua baris pending_human untuk escrow yang sama.
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
  /** Nama tool yang dieksekusi AI pada keputusan ini (tool calling). */
  toolsUsed?: string[];
  /** Transkrip sidang multi-agent (Investigator → Advocate → Judge). */
  debate?: unknown;
  /** final = sudah on-chain; pending_human = hold, tunggu vote. */
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
    logger.warn(
      `[DB] skip saveDecision — escrow_id sudah ada: ${record.escrowId.slice(0, 14)}…`
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

export function getAllDecisions(limit: number = 50): unknown[] {
  return db
    .prepare("SELECT * FROM decisions ORDER BY created_at DESC, id DESC LIMIT ?")
    .all(Math.max(1, Math.min(500, Math.floor(limit))));
}

export function getDecisionsCount(): number {
  const row = db.prepare("SELECT COUNT(*) AS n FROM decisions").get() as
    | { n: number }
    | undefined;
  return row?.n ?? 0;
}

/** Riwayat escrow yang melibatkan address tertentu (sender ATAU recipient). */
export function getAllDecisionsForAddress(address: string, limit: number): unknown[] {
  const addr = address.toLowerCase();
  return db
    .prepare(
      `SELECT * FROM decisions
       WHERE LOWER(sender) = ? OR LOWER(recipient) = ?
       ORDER BY created_at DESC, id DESC LIMIT ?`
    )
    .all(addr, addr, Math.max(1, Math.min(500, Math.floor(limit))));
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

/** Set escrow_id yang pernah melibatkan address — dipakai filter arsip sidang. */
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

/** Escrow yang masih menunggu vote manusia (1 baris per escrow_id). */
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
 * Finalisasi setelah vote manusia: update baris pending → final + tx on-chain.
 * eligible = vote manusia (bukan rekomendasi AI).
 */
export function finalizeHumanDecision(input: {
  escrowId: string;
  humanVote: boolean;
  humanReason: string;
  finalReason: string;
  decidedBy: string;
  txHash: string;
}): boolean {
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
      input.humanVote ? 1 : 0,
      input.finalReason,
      input.decidedBy,
      input.txHash,
      input.humanVote ? 1 : 0,
      input.humanReason,
      input.escrowId
    );
  return info.changes > 0;
}

// ── Tool-calling history queries ──────────────────────────────────────────────
export interface SenderEscrowSummary {
  total: number;
  approved: number;
  rejected: number;
  /** Penerima lain yang pernah dikirimi escrow oleh pengirim ini. */
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
  /** Jumlah pengirim berbeda yang pernah mengirim ke penerima ini. */
  distinctSenders: number;
  recent: Array<{
    sender: string;
    amount: string;
    eligible: boolean;
    decidedBy: string | null;
    createdAt: string;
  }>;
}

/** Riwayat escrow AEGIS dari sisi PENGIRIM (tool: get_sender_db_history). */
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

/** Riwayat escrow AEGIS dari sisi PENERIMA, lintas pengirim (tool: get_recipient_db_history). */
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

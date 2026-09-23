import Database from "better-sqlite3";

const db = new Database("aegis.db");

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

// ── Interfaces ────────────────────────────────────────────────────────────────
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
}

// ── Queries ───────────────────────────────────────────────────────────────────
export function saveDecision(record: DecisionRecord): void {
  const stmt = db.prepare(`
    INSERT INTO decisions
      (escrow_id, sender, recipient, amount, eligible, confidence, reasoning,
       risk_level, decided_by, risk_flags, tx_hash, tools_used)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
      : null
  );
}

export function getAllDecisions(): unknown[] {
  return db
    .prepare("SELECT * FROM decisions ORDER BY created_at DESC")
    .all();
}

export function getDecisionByEscrowId(escrowId: string): unknown {
  return db
    .prepare("SELECT * FROM decisions WHERE escrow_id = ?")
    .get(escrowId);
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

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
}

// ── Queries ───────────────────────────────────────────────────────────────────
export function saveDecision(record: DecisionRecord): void {
  const stmt = db.prepare(`
    INSERT INTO decisions
      (escrow_id, sender, recipient, amount, eligible, confidence, reasoning,
       risk_level, decided_by, risk_flags, tx_hash)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
    record.txHash ?? null
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

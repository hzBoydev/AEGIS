import Database from "better-sqlite3";

const db = new Database("aegis.db");

db.exec(`
  CREATE TABLE IF NOT EXISTS decisions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    escrow_id TEXT NOT NULL,
    sender TEXT NOT NULL,
    recipient TEXT NOT NULL,
    amount TEXT NOT NULL,
    eligible INTEGER NOT NULL,
    confidence INTEGER NOT NULL,
    reasoning TEXT NOT NULL,
    tx_hash TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  )
`);

export interface DecisionRecord {
  escrowId: string;
  sender: string;
  recipient: string;
  amount: string;
  eligible: boolean;
  confidence: number;
  reasoning: string;
  txHash?: string;
}

export function saveDecision(record: DecisionRecord) {
  const stmt = db.prepare(`
    INSERT INTO decisions (escrow_id, sender, recipient, amount, eligible, confidence, reasoning, tx_hash)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  stmt.run(
    record.escrowId,
    record.sender,
    record.recipient,
    record.amount,
    record.eligible ? 1 : 0,
    record.confidence,
    record.reasoning,
    record.txHash || null
  );
}

export function getAllDecisions() {
  return db.prepare(`SELECT * FROM decisions ORDER BY created_at DESC`).all();
}

export function getDecisionByEscrowId(escrowId: string) {
  return db.prepare(`SELECT * FROM decisions WHERE escrow_id = ?`).get(escrowId);
}

export default db;

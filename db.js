import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const db = new Database(path.join(__dirname, 'kiosk.db'));

db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    app_transaction_id TEXT NOT NULL UNIQUE,
    mode TEXT NOT NULL,
    phone_last4 TEXT,
    status TEXT NOT NULL,
    created_at TEXT NOT NULL
  )
`);

const insertStmt = db.prepare(`
  INSERT INTO sessions (app_transaction_id, mode, phone_last4, status, created_at)
  VALUES (@appTransactionId, @mode, @phoneLast4, @status, @createdAt)
`);

const updateStatusStmt = db.prepare(`
  UPDATE sessions SET status = ? WHERE app_transaction_id = ?
`);

const recentStmt = db.prepare(`
  SELECT id AS customerNumber, app_transaction_id AS appTransactionId, mode,
         phone_last4 AS phoneLast4, status, created_at AS createdAt
  FROM sessions
  ORDER BY id DESC
  LIMIT 20
`);

const pendingCountStmt = db.prepare(`
  SELECT COUNT(*) AS count FROM sessions WHERE status = 'pending'
`);

const findByTransactionIdStmt = db.prepare(`
  SELECT id AS customerNumber, app_transaction_id AS appTransactionId, mode,
         phone_last4 AS phoneLast4, status, created_at AS createdAt
  FROM sessions WHERE app_transaction_id = ?
`);

export function logSession({ appTransactionId, mode, phoneLast4, createdAt, status }) {
  insertStmt.run({ appTransactionId, mode, phoneLast4: phoneLast4 ?? null, status, createdAt });
}

export function updateSessionStatus(appTransactionId, status) {
  updateStatusStmt.run(status, appTransactionId);
}

export function getRecentSessions() {
  return recentStmt.all();
}

export function getPendingCount() {
  return pendingCountStmt.get().count;
}

export function getSessionByTransactionId(appTransactionId) {
  return findByTransactionIdStmt.get(appTransactionId);
}

import { getConnection } from '@/modules/database/connection.js';

function connection() {
  const db = getConnection();
  db.exec(`CREATE TABLE IF NOT EXISTS chat_send_receipts (
    receipt_key TEXT PRIMARY KEY, fingerprint TEXT NOT NULL,
    response TEXT, created_at INTEGER NOT NULL
  )`);
  return db;
}

/** Used by WebSocket to persist send admission across disconnects and server restarts. */
export const chatReceiptsDb = {
  claim(key: string, fingerprint: string) {
    const db = connection();
    const inserted = db.prepare('INSERT OR IGNORE INTO chat_send_receipts VALUES (?, ?, NULL, ?)')
      .run(key, fingerprint, Date.now()).changes === 1;
    const row = db.prepare('SELECT fingerprint, response FROM chat_send_receipts WHERE receipt_key = ?')
      .get(key) as { fingerprint: string; response: string | null };
    return { inserted, ...row };
  },
  settle(key: string, response: string) {
    connection().prepare('UPDATE chat_send_receipts SET response = ? WHERE receipt_key = ?').run(response, key);
  },
};

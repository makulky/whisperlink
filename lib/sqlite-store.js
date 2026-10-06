import { DatabaseSync } from 'node:sqlite';

export function openDb(path = ':memory:') {
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS secrets (
      id         TEXT PRIMARY KEY,
      ciphertext TEXT NOT NULL,
      iv         TEXT NOT NULL,
      salt       TEXT,
      expires_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS secrets_expires ON secrets (expires_at);
  `);

  const insertStmt = db.prepare(
    'INSERT INTO secrets (id, ciphertext, iv, salt, expires_at) VALUES (?, ?, ?, ?, ?)'
  );
  const metaStmt = db.prepare(
    'SELECT salt IS NOT NULL AS has_password FROM secrets WHERE id = ? AND expires_at > ?'
  );
  // Lectura y borrado en una sola sentencia: dos peticiones simultáneas nunca
  // pueden obtener el mismo secreto.
  const consumeStmt = db.prepare(
    'DELETE FROM secrets WHERE id = ? AND expires_at > ? RETURNING ciphertext, iv, salt'
  );
  const purgeStmt = db.prepare('DELETE FROM secrets WHERE expires_at <= ?');

  return {
    create({ id, ciphertext, iv, salt, expiresAt }) {
      insertStmt.run(id, ciphertext, iv, salt ?? null, expiresAt);
    },
    meta(id, now = Date.now()) {
      const row = metaStmt.get(id, now);
      return row ? { hasPassword: row.has_password === 1 } : null;
    },
    consume(id, now = Date.now()) {
      const row = consumeStmt.get(id, now);
      return row ? { ciphertext: row.ciphertext, iv: row.iv, salt: row.salt } : null;
    },
    purge(now = Date.now()) {
      return Number(purgeStmt.run(now).changes);
    },
    close() {
      db.close();
    },
  };
}

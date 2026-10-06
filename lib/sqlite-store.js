// Almacén local con SQLite (node:sqlite). Para desarrollo y servidores propios.
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
  const hits = new Map(); // límite de peticiones en memoria: clave -> { count, resetAt }

  return {
    create({ id, ciphertext, iv, salt, ttlMs }, now = Date.now()) {
      insertStmt.run(id, ciphertext, iv, salt ?? null, now + ttlMs);
    },
    meta(id, now = Date.now()) {
      const row = metaStmt.get(id, now);
      return row ? { hasPassword: row.has_password === 1 } : null;
    },
    consume(id, now = Date.now()) {
      const row = consumeStmt.get(id, now);
      return row ? { ciphertext: row.ciphertext, iv: row.iv, salt: row.salt } : null;
    },
    hit(key, windowMs, now = Date.now()) {
      const entry = hits.get(key);
      if (!entry || entry.resetAt <= now) {
        hits.set(key, { count: 1, resetAt: now + windowMs });
        return 1;
      }
      return ++entry.count;
    },
    purge(now = Date.now()) {
      for (const [key, entry] of hits) if (entry.resetAt <= now) hits.delete(key);
      return Number(purgeStmt.run(now).changes);
    },
    close() {
      db.close();
    },
  };
}

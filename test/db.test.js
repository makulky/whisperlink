import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../lib/sqlite-store.js';

const sample = (id, ttlMs, salt = null) => ({ id, ciphertext: 'abc', iv: 'iv', salt, ttlMs });

test('consume devuelve el secreto una sola vez', () => {
  const db = openDb();
  db.create(sample('a', 1000), 1000);
  assert.deepEqual(db.meta('a', 1000), { hasPassword: false });
  assert.deepEqual(db.consume('a', 1000), { ciphertext: 'abc', iv: 'iv', salt: null });
  assert.equal(db.consume('a', 1000), null);
  assert.equal(db.meta('a', 1000), null);
});

test('meta indica si tiene contraseña', () => {
  const db = openDb();
  db.create(sample('p', 1000, 'salt'), 1000);
  assert.deepEqual(db.meta('p', 1000), { hasPassword: true });
});

test('los caducados no se devuelven y purge los borra', () => {
  const db = openDb();
  db.create(sample('old', 0), 1000);
  db.create(sample('new', 4000), 1000);
  assert.equal(db.meta('old', 1000), null);
  assert.equal(db.consume('old', 1500), null);
  assert.equal(db.purge(1500), 1);
  assert.ok(db.meta('new', 1500));
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../db.js';

const sample = (id, expiresAt, salt = null) => ({ id, ciphertext: 'abc', iv: 'iv', salt, expiresAt });

test('consume devuelve el secreto una sola vez', () => {
  const db = openDb();
  db.create(sample('a', 2000));
  assert.deepEqual(db.meta('a', 1000), { hasPassword: false });
  assert.deepEqual(db.consume('a', 1000), { ciphertext: 'abc', iv: 'iv', salt: null });
  assert.equal(db.consume('a', 1000), null);
  assert.equal(db.meta('a', 1000), null);
});

test('meta indica si tiene contraseña', () => {
  const db = openDb();
  db.create(sample('p', 2000, 'salt'));
  assert.deepEqual(db.meta('p', 1000), { hasPassword: true });
});

test('los caducados no se devuelven y purge los borra', () => {
  const db = openDb();
  db.create(sample('old', 1000));
  db.create(sample('new', 5000));
  assert.equal(db.meta('old', 1000), null);
  assert.equal(db.consume('old', 1500), null);
  assert.equal(db.purge(1500), 1);
  assert.ok(db.meta('new', 1500));
});

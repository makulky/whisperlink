import test from 'node:test';
import assert from 'node:assert/strict';
import { encryptSecret, decryptSecret, isValidKey, toB64u, fromB64u } from '../public/crypto.js';

test('base64url ida y vuelta', () => {
  const bytes = crypto.getRandomValues(new Uint8Array(57));
  assert.deepEqual(fromB64u(toB64u(bytes)), bytes);
  assert.doesNotMatch(toB64u(bytes), /[+/=]/);
});

test('cifra y descifra sin contraseña (incluye unicode)', async () => {
  const text = 'hola 🔐 ñandú';
  const { key, payload } = await encryptSecret(text);
  assert.ok(isValidKey(key));
  assert.equal(payload.salt, null);
  assert.equal(await decryptSecret(payload, key), text);
});

test('con contraseña: necesita clave y contraseña correctas', async () => {
  const { key, payload } = await encryptSecret('secreto', 'pw1');
  assert.ok(payload.salt);
  assert.equal(await decryptSecret(payload, key, 'pw1'), 'secreto');
  await assert.rejects(decryptSecret(payload, key, 'pw2'));
  await assert.rejects(decryptSecret(payload, key, ''));
});

test('clave equivocada falla', async () => {
  const { payload } = await encryptSecret('x');
  const { key: otherKey } = await encryptSecret('y');
  await assert.rejects(decryptSecret(payload, otherKey));
  assert.equal(isValidKey('corta'), false);
  assert.equal(isValidKey('no+válida'), false);
});

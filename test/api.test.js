import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../server.js';
import { openDb } from '../lib/sqlite-store.js';
import { encryptSecret, decryptSecret } from '../public/crypto.js';

let server, base, clock = 1_000_000;

before(async () => {
  server = createApp({ db: openDb(), now: () => clock, log: () => {} });
  await new Promise((resolve) => server.listen(0, resolve));
  base = `http://localhost:${server.address().port}`;
});

after(() => new Promise((resolve) => server.close(resolve)));

const post = (path, body) => fetch(base + path, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: body === undefined ? undefined : JSON.stringify(body),
});

async function createSecret(text, password, ttl = '1h') {
  const { key, payload } = await encryptSecret(text, password);
  const res = await post('/api/secrets', { ...payload, ttl });
  assert.equal(res.status, 201);
  return { key, id: (await res.json()).id };
}

test('flujo completo: crear, metadatos, revelar una vez', async () => {
  const { key, id } = await createSecret('top secret');

  const meta = await fetch(`${base}/api/secrets/${id}`);
  assert.equal(meta.status, 200);
  assert.deepEqual(await meta.json(), { exists: true, hasPassword: false });

  const first = await post(`/api/secrets/${id}/reveal`);
  assert.equal(first.status, 200);
  assert.equal(await decryptSecret(await first.json(), key), 'top secret');

  assert.equal((await post(`/api/secrets/${id}/reveal`)).status, 404);
  assert.equal((await fetch(`${base}/api/secrets/${id}`)).status, 404);
});

test('GET a /reveal no consume el secreto', async () => {
  const { id } = await createSecret('x');
  assert.equal((await fetch(`${base}/api/secrets/${id}/reveal`)).status, 405);
  assert.equal((await post(`/api/secrets/${id}/reveal`)).status, 200);
});

test('secreto con contraseña', async () => {
  const { key, id } = await createSecret('pw secret', 'hunter2');
  assert.deepEqual(await (await fetch(`${base}/api/secrets/${id}`)).json(), { exists: true, hasPassword: true });
  const payload = await (await post(`/api/secrets/${id}/reveal`)).json();
  assert.equal(await decryptSecret(payload, key, 'hunter2'), 'pw secret');
});

test('caduca según el TTL', async () => {
  const { id } = await createSecret('efímero', '', '1h');
  clock += 3_600_001;
  assert.equal((await post(`/api/secrets/${id}/reveal`)).status, 404);
});

test('validación de entrada', async () => {
  const { payload } = await encryptSecret('x');
  assert.equal((await post('/api/secrets', { ...payload, ttl: '99y' })).status, 400);
  assert.equal((await post('/api/secrets', { ...payload, iv: 'bad', ttl: '1h' })).status, 400);
  assert.equal((await post('/api/secrets', { ...payload, ciphertext: 'a'.repeat(95_000), ttl: '1h' })).status, 413);
  assert.equal((await post('/api/secrets', { ...payload, ciphertext: 'a'.repeat(200_000), ttl: '1h' })).status, 413);
  assert.equal((await fetch(`${base}/api/secrets/no-es-un-id`)).status, 404);
});

test('páginas estáticas y cabeceras de seguridad', async () => {
  const home = await fetch(base + '/');
  assert.equal(home.status, 200);
  assert.match(home.headers.get('content-security-policy'), /script-src 'self'/);
  assert.equal(home.headers.get('referrer-policy'), 'no-referrer');
  assert.equal(home.headers.get('cache-control'), 'no-store');

  const view = await fetch(`${base}/s/${'A'.repeat(22)}`);
  assert.equal(view.status, 200);
  assert.match(await view.text(), /view\.js/);

  assert.equal((await fetch(base + '/../server.js')).status, 404);
});

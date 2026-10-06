import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { openRedis, redisConfigFromEnv } from '../lib/redis-store.js';
import { createHandler, SECURITY_HEADERS } from '../lib/handler.js';
import { encryptSecret, decryptSecret } from '../public/crypto.js';

// Imitación mínima de la API REST de Upstash con caducidad controlada por un reloj.
function fakeUpstash(token = 't0k') {
  const data = new Map(); // key -> { value, expiresAt }
  const clock = { now: 0 };
  const alive = (key) => {
    const entry = data.get(key);
    if (entry && entry.expiresAt !== null && entry.expiresAt <= clock.now) data.delete(key);
    return data.get(key);
  };
  const commands = {
    SET(key, value, px, ms, nx) {
      assert.equal(px, 'PX');
      if (nx === 'NX' && alive(key)) return null;
      data.set(key, { value, expiresAt: clock.now + Number(ms) });
      return 'OK';
    },
    GET: (key) => alive(key)?.value ?? null,
    GETDEL(key) {
      const value = alive(key)?.value ?? null;
      data.delete(key);
      return value;
    },
    INCR(key) {
      const entry = alive(key) ?? { value: '0', expiresAt: null };
      entry.value = String(Number(entry.value) + 1);
      data.set(key, entry);
      return Number(entry.value);
    },
    PEXPIRE(key, ms) {
      const entry = alive(key);
      if (!entry) return 0;
      entry.expiresAt = clock.now + Number(ms);
      return 1;
    },
  };
  async function fetch(url, init) {
    if (init.headers.Authorization !== `Bearer ${token}`) return new Response('{}', { status: 401 });
    const [cmd, ...args] = JSON.parse(init.body);
    return Response.json({ result: commands[cmd](...args) });
  }
  return { fetch, clock, data };
}

test('redisConfigFromEnv acepta las variables de Vercel y de Upstash', () => {
  assert.deepEqual(redisConfigFromEnv({ KV_REST_API_URL: 'u', KV_REST_API_TOKEN: 't' }), { url: 'u', token: 't' });
  assert.deepEqual(redisConfigFromEnv({ UPSTASH_REDIS_REST_URL: 'u', UPSTASH_REDIS_REST_TOKEN: 't' }), { url: 'u', token: 't' });
  assert.equal(redisConfigFromEnv({}), null);
});

test('almacén Redis: un solo uso, contraseña y caducidad', async () => {
  const fake = fakeUpstash();
  const store = openRedis({ url: 'https://x.upstash.io/', token: 't0k', fetch: fake.fetch });

  await store.create({ id: 'a', ciphertext: 'c', iv: 'i', salt: null, ttlMs: 1000 });
  assert.deepEqual(await store.meta('a'), { hasPassword: false });
  assert.deepEqual(await store.consume('a'), { ciphertext: 'c', iv: 'i', salt: null });
  assert.equal(await store.consume('a'), null);

  await store.create({ id: 'p', ciphertext: 'c', iv: 'i', salt: 's', ttlMs: 1000 });
  assert.deepEqual(await store.meta('p'), { hasPassword: true });
  fake.clock.now = 1000;
  assert.equal(await store.meta('p'), null);
  assert.equal(await store.consume('p'), null);
});

test('almacén Redis: límite de peticiones por ventana', async () => {
  const fake = fakeUpstash();
  const store = openRedis({ url: 'https://x', token: 't0k', fetch: fake.fetch });
  assert.equal(await store.hit('ip', 60_000), 1);
  assert.equal(await store.hit('ip', 60_000), 2);
  fake.clock.now = 60_000;
  assert.equal(await store.hit('ip', 60_000), 1);
});

test('almacén Redis: error de autenticación se propaga', async () => {
  const fake = fakeUpstash();
  const store = openRedis({ url: 'https://x', token: 'malo', fetch: fake.fetch });
  await assert.rejects(store.meta('a'), /401/);
});

test('flujo HTTP completo con Redis y IP del proxy', async () => {
  const fake = fakeUpstash();
  const store = openRedis({ url: 'https://x', token: 't0k', fetch: fake.fetch });
  const server = http.createServer(createHandler({ store, trustProxy: true, log: () => {} }));
  await new Promise((resolve) => server.listen(0, resolve));
  const base = `http://localhost:${server.address().port}`;
  try {
    const { key, payload } = await encryptSecret('desde vercel', 'pw');
    const created = await fetch(`${base}/api/secrets`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Real-IP': '203.0.113.7' },
      body: JSON.stringify({ ...payload, ttl: '1h' }),
    });
    assert.equal(created.status, 201);
    const { id } = await created.json();
    assert.ok(fake.data.has('wl:rate:203.0.113.7'));

    const meta = await (await fetch(`${base}/api/secrets/${id}`)).json();
    assert.deepEqual(meta, { exists: true, hasPassword: true });

    const revealed = await fetch(`${base}/api/secrets/${id}/reveal`, { method: 'POST' });
    assert.equal(await decryptSecret(await revealed.json(), key, 'pw'), 'desde vercel');
    assert.equal((await fetch(`${base}/api/secrets/${id}/reveal`, { method: 'POST' })).status, 404);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('vercel.json tiene las mismas cabeceras de seguridad que el código', () => {
  const config = JSON.parse(readFileSync(new URL('../vercel.json', import.meta.url), 'utf8'));
  const headers = Object.fromEntries(config.headers[0].headers.map(({ key, value }) => [key, value]));
  assert.equal(config.headers[0].source, '/(.*)');
  assert.deepEqual(headers, SECURITY_HEADERS);
});

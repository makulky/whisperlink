// Almacén con Redis vía la API REST de Upstash (sin dependencias, solo fetch).
// Es el que se usa en Vercel, donde el sistema de archivos no persiste.
// Redis gestiona la caducidad (PX) y GETDEL lee y borra de forma atómica.

const SECRET_PREFIX = 'wl:secret:';
const RATE_PREFIX = 'wl:rate:';

export function redisConfigFromEnv(env = process.env) {
  const url = env.KV_REST_API_URL ?? env.UPSTASH_REDIS_REST_URL;
  const token = env.KV_REST_API_TOKEN ?? env.UPSTASH_REDIS_REST_TOKEN;
  return url && token ? { url, token } : null;
}

export function openRedis({ url, token, fetch: fetchImpl = globalThis.fetch }) {
  const base = url.replace(/\/+$/, '');

  async function call(path, body) {
    const res = await fetchImpl(base + path, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`Redis respondió ${res.status}`);
    return res.json();
  }

  async function command(...args) {
    const { result, error } = await call('', args);
    if (error) throw new Error(`Redis: ${error}`);
    return result;
  }

  return {
    async create({ id, ciphertext, iv, salt, ttlMs }) {
      const value = JSON.stringify({ ciphertext, iv, salt: salt ?? null });
      const ok = await command('SET', SECRET_PREFIX + id, value, 'PX', String(ttlMs), 'NX');
      if (ok !== 'OK') throw new Error('Colisión de id');
    },
    async meta(id) {
      const value = await command('GET', SECRET_PREFIX + id);
      return value ? { hasPassword: JSON.parse(value).salt !== null } : null;
    },
    async consume(id) {
      const value = await command('GETDEL', SECRET_PREFIX + id);
      return value ? JSON.parse(value) : null;
    },
    async hit(key, windowMs) {
      const count = await command('INCR', RATE_PREFIX + key);
      if (count === 1) await command('PEXPIRE', RATE_PREFIX + key, String(windowMs));
      return count;
    },
  };
}

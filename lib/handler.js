// Manejador HTTP compartido por el servidor local (server.js) y Vercel (api/index.js).
// El almacenamiento se inyecta: SQLite en local, Redis en Vercel.
import { randomBytes } from 'node:crypto';

export const MAX_BODY_BYTES = 100_000;
const MAX_CIPHERTEXT_CHARS = 90_000; // ~64 KB tras decodificar base64url
const TTLS = { '1h': 3_600_000, '1d': 86_400_000, '7d': 604_800_000 };
export const RATE_LIMIT = { windowMs: 60_000, max: 30 };

const ID_RE = /^[A-Za-z0-9_-]{22}$/;   // 16 bytes
const IV_RE = /^[A-Za-z0-9_-]{16}$/;   // 12 bytes
const SALT_RE = /^[A-Za-z0-9_-]{22}$/; // 16 bytes
const B64U_RE = /^[A-Za-z0-9_-]+$/;
export const VIEW_PATH_RE = /^\/s\/[A-Za-z0-9_-]{22}$/;

// Si cambias algo aquí, cambia también vercel.json (un test comprueba que coinciden).
export const SECURITY_HEADERS = {
  'Content-Security-Policy':
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; " +
    "connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cache-Control': 'no-store',
};

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export function send(res, status, body, type = 'application/json; charset=utf-8') {
  const payload = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(status, { ...SECURITY_HEADERS, 'Content-Type': type });
  res.end(payload);
}

async function readJson(req) {
  if (!String(req.headers['content-type'] ?? '').startsWith('application/json')) {
    throw new HttpError(415, 'Se esperaba application/json');
  }
  if (Number(req.headers['content-length']) > MAX_BODY_BYTES) {
    throw new HttpError(413, 'Secreto demasiado grande');
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    // Seguimos leyendo (sin guardar) para poder responder limpiamente;
    // si el cliente insiste demasiado, cerramos la conexión.
    if (size > 10 * MAX_BODY_BYTES) req.destroy();
    if (size <= MAX_BODY_BYTES) chunks.push(chunk);
  }
  if (size > MAX_BODY_BYTES) throw new HttpError(413, 'Secreto demasiado grande');
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'JSON inválido');
  }
}

function validateSecret(body) {
  const { ciphertext, iv, salt = null, ttl } = body ?? {};
  if (typeof ciphertext !== 'string' || !B64U_RE.test(ciphertext)) throw new HttpError(400, 'ciphertext inválido');
  if (ciphertext.length > MAX_CIPHERTEXT_CHARS) throw new HttpError(413, 'Secreto demasiado grande');
  if (typeof iv !== 'string' || !IV_RE.test(iv)) throw new HttpError(400, 'iv inválido');
  if (salt !== null && (typeof salt !== 'string' || !SALT_RE.test(salt))) throw new HttpError(400, 'salt inválido');
  if (!Object.hasOwn(TTLS, ttl)) throw new HttpError(400, 'ttl inválido');
  return { ciphertext, iv, salt, ttlMs: TTLS[ttl] };
}

/**
 * @param {object} opts
 * @param {object} opts.store        create / meta / consume / hit (síncronos o async)
 * @param {boolean} [opts.trustProxy] usar x-real-ip / x-forwarded-for (detrás de Vercel o un proxy)
 * @param {Function} [opts.serveStatic] (req, res, pathname) => boolean; solo en el servidor local
 */
export function createHandler({ store, now = Date.now, log = console.log, trustProxy = false, serveStatic }) {
  function clientIp(req) {
    if (trustProxy) {
      const ip = req.headers['x-real-ip'] ?? String(req.headers['x-forwarded-for'] ?? '').split(',')[0].trim();
      if (ip) return ip;
    }
    return req.socket?.remoteAddress ?? 'unknown';
  }

  async function enforceRateLimit(req) {
    const count = await store.hit(clientIp(req), RATE_LIMIT.windowMs, now());
    if (count > RATE_LIMIT.max) throw new HttpError(429, 'Demasiadas peticiones');
  }

  async function route(req, res) {
    const { pathname } = new URL(req.url, 'http://localhost');
    const method = req.method;

    if (method === 'GET' && serveStatic?.(req, res, pathname)) return;

    if (pathname === '/api/secrets' && method === 'POST') {
      await enforceRateLimit(req);
      const { ciphertext, iv, salt, ttlMs } = validateSecret(await readJson(req));
      const id = randomBytes(16).toString('base64url');
      await store.create({ id, ciphertext, iv, salt, ttlMs }, now());
      return send(res, 201, { id });
    }

    const api = pathname.match(/^\/api\/secrets\/([^/]+)(\/reveal)?$/);
    if (api) {
      const [, id, reveal] = api;
      if (!ID_RE.test(id)) throw new HttpError(404, 'No encontrado');

      if (!reveal && method === 'GET') {
        const meta = await store.meta(id, now());
        if (!meta) throw new HttpError(404, 'No encontrado');
        return send(res, 200, { exists: true, hasPassword: meta.hasPassword });
      }
      // POST (no GET) para que los previsualizadores de enlaces no lo consuman.
      if (reveal && method === 'POST') {
        await enforceRateLimit(req);
        const secret = await store.consume(id, now());
        if (!secret) throw new HttpError(404, 'No encontrado');
        return send(res, 200, secret);
      }
      throw new HttpError(405, 'Método no permitido');
    }

    throw new HttpError(404, 'No encontrado');
  }

  return async function handler(req, res) {
    try {
      await route(req, res);
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 500;
      if (status === 500) log('error', err);
      // Si no hemos leído el cuerpo entero, la conexión no es reutilizable.
      if (!req.complete) res.setHeader('Connection', 'close');
      if (!res.headersSent) send(res, status, { error: status === 500 ? 'Error interno' : err.message });
      else res.destroy();
    } finally {
      // Nunca registramos ids de secretos.
      const route = new URL(req.url, 'http://localhost').pathname.replace(/[A-Za-z0-9_-]{22}/, ':id');
      log(`${req.method} ${route} ${res.statusCode}`);
    }
  };
}

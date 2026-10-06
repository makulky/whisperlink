import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { openDb } from './db.js';

const PUBLIC_DIR = new URL('./public/', import.meta.url);
const MAX_BODY_BYTES = 100_000;
const MAX_CIPHERTEXT_CHARS = 90_000; // ~64 KB tras decodificar base64url
const TTLS = { '1h': 3_600_000, '1d': 86_400_000, '7d': 604_800_000 };
const RATE_LIMIT = { windowMs: 60_000, max: 30 };

const ID_RE = /^[A-Za-z0-9_-]{22}$/;   // 16 bytes
const IV_RE = /^[A-Za-z0-9_-]{16}$/;   // 12 bytes
const SALT_RE = /^[A-Za-z0-9_-]{22}$/; // 16 bytes
const B64U_RE = /^[A-Za-z0-9_-]+$/;

const SECURITY_HEADERS = {
  'Content-Security-Policy':
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; " +
    "connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cache-Control': 'no-store',
};

const STATIC_TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };
const STATIC_ROUTES = {
  '/': 'index.html',
  '/style.css': 'style.css',
  '/crypto.js': 'crypto.js',
  '/create.js': 'create.js',
  '/view.js': 'view.js',
};

function loadStatic(file) {
  const ext = file.slice(file.lastIndexOf('.'));
  return { body: readFileSync(new URL(file, PUBLIC_DIR)), type: STATIC_TYPES[ext] };
}

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function send(res, status, body, type = 'application/json; charset=utf-8') {
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

export function createApp({ db, now = Date.now, log = console.log } = {}) {
  const staticFiles = Object.fromEntries(
    Object.entries(STATIC_ROUTES).map(([route, file]) => [route, loadStatic(file)])
  );
  const viewPage = loadStatic('view.html');
  const hits = new Map(); // ip -> { count, resetAt }

  function rateLimited(ip) {
    const t = now();
    const entry = hits.get(ip);
    if (!entry || entry.resetAt <= t) {
      hits.set(ip, { count: 1, resetAt: t + RATE_LIMIT.windowMs });
      return false;
    }
    return ++entry.count > RATE_LIMIT.max;
  }

  async function handle(req, res) {
    const { pathname } = new URL(req.url, 'http://localhost');
    const method = req.method;

    if (method === 'GET' && Object.hasOwn(staticFiles, pathname)) {
      const { body, type } = staticFiles[pathname];
      return send(res, 200, body, type);
    }

    const view = pathname.match(/^\/s\/([^/]+)$/);
    if (method === 'GET' && view && ID_RE.test(view[1])) {
      return send(res, 200, viewPage.body, viewPage.type);
    }

    if (pathname === '/api/secrets' && method === 'POST') {
      if (rateLimited(req.socket.remoteAddress)) throw new HttpError(429, 'Demasiadas peticiones');
      const { ciphertext, iv, salt, ttlMs } = validateSecret(await readJson(req));
      const id = randomBytes(16).toString('base64url');
      db.create({ id, ciphertext, iv, salt, expiresAt: now() + ttlMs });
      return send(res, 201, { id });
    }

    const api = pathname.match(/^\/api\/secrets\/([^/]+)(\/reveal)?$/);
    if (api) {
      const [, id, reveal] = api;
      if (!ID_RE.test(id)) throw new HttpError(404, 'No encontrado');

      if (!reveal && method === 'GET') {
        const meta = db.meta(id, now());
        if (!meta) throw new HttpError(404, 'No encontrado');
        return send(res, 200, { exists: true, hasPassword: meta.hasPassword });
      }
      // POST (no GET) para que los previsualizadores de enlaces no lo consuman.
      if (reveal && method === 'POST') {
        if (rateLimited(req.socket.remoteAddress)) throw new HttpError(429, 'Demasiadas peticiones');
        const secret = db.consume(id, now());
        if (!secret) throw new HttpError(404, 'No encontrado');
        return send(res, 200, secret);
      }
      throw new HttpError(405, 'Método no permitido');
    }

    throw new HttpError(404, 'No encontrado');
  }

  const server = http.createServer(async (req, res) => {
    try {
      await handle(req, res);
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
  });

  const sweeper = setInterval(() => {
    db.purge(now());
    const t = now();
    for (const [ip, entry] of hits) if (entry.resetAt <= t) hits.delete(ip);
  }, 60_000);
  sweeper.unref();
  server.on('close', () => clearInterval(sweeper));

  return server;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT ?? 3000);
  const db = openDb(process.env.DB_PATH ?? 'whisperlink.db');
  db.purge();
  createApp({ db }).listen(port, () => {
    console.log(`WhisperLink escuchando en http://localhost:${port}`);
  });
}

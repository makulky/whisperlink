// Servidor local: sirve los estáticos de public/ y la API.
// Usa Redis si hay credenciales de Upstash en el entorno; si no, SQLite.
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createHandler, send, VIEW_PATH_RE } from './lib/handler.js';
import { openRedis, redisConfigFromEnv } from './lib/redis-store.js';

const PUBLIC_DIR = new URL('./public/', import.meta.url);
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

function staticServer() {
  const files = Object.fromEntries(
    Object.entries(STATIC_ROUTES).map(([route, file]) => [route, loadStatic(file)])
  );
  const viewPage = loadStatic('view.html');
  return (req, res, pathname) => {
    const file = Object.hasOwn(files, pathname) ? files[pathname] : VIEW_PATH_RE.test(pathname) ? viewPage : null;
    if (!file) return false;
    send(res, 200, file.body, file.type);
    return true;
  };
}

export function createApp({ db, now = Date.now, log = console.log, trustProxy = false } = {}) {
  const server = http.createServer(createHandler({ store: db, now, log, trustProxy, serveStatic: staticServer() }));
  if (db.purge) {
    const sweeper = setInterval(() => db.purge(now()), 60_000);
    sweeper.unref();
    server.on('close', () => clearInterval(sweeper));
  }
  return server;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT ?? 3000);
  const redis = redisConfigFromEnv();
  let db;
  if (redis) {
    db = openRedis(redis);
  } else {
    const { openDb } = await import('./lib/sqlite-store.js');
    db = openDb(process.env.DB_PATH ?? 'whisperlink.db');
    db.purge();
  }
  createApp({ db, trustProxy: process.env.TRUST_PROXY === '1' }).listen(port, () => {
    console.log(`WhisperLink escuchando en http://localhost:${port} (almacén: ${redis ? 'Redis' : 'SQLite'})`);
  });
}

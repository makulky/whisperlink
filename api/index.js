// Función serverless de Vercel. vercel.json reescribe /api/* hacia aquí;
// los estáticos de public/ los sirve directamente la CDN de Vercel.
import { createHandler } from '../lib/handler.js';
import { openRedis, redisConfigFromEnv } from '../lib/redis-store.js';

const config = redisConfigFromEnv();

export default config
  ? createHandler({ store: openRedis(config), trustProxy: true })
  : (req, res) => {
      console.error('Faltan KV_REST_API_URL / KV_REST_API_TOKEN: conecta una base Upstash Redis al proyecto.');
      res.writeHead(503, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ error: 'Almacenamiento no configurado' }));
    };

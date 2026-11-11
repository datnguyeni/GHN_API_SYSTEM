import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ApiError, integer } from './contract.mjs';
import { GhnCarrier, MockCarrier, CarrierError } from './carrier.mjs';
import { ShippingService } from './service.mjs';
import { openStore } from './store.mjs';
import { loadConfig } from './config.mjs';

async function jsonBody(req) {
  if (!req.headers['content-type']?.toLowerCase().startsWith('application/json')) throw new ApiError(415, 'JSON_REQUIRED');
  let size = 0; const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 256 * 1024) throw new ApiError(413, 'BODY_TOO_LARGE');
    chunks.push(chunk);
  }
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error();
    return body;
  } catch { throw new ApiError(400, 'INVALID_JSON'); }
}
export function createApp(service, { staticDir = resolve('dist'), mode = 'live' } = {}) {
  const reply = (res, status, data) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }); res.end(JSON.stringify(data)); };
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost'), path = url.pathname;
      if (req.method === 'GET' && path === '/health') { reply(res, 200, { status: 'ok', mode }); return; }
      const webhook = path.match(/^\/webhooks\/ghn\/([A-Za-z0-9_-]+)$/);
      if (webhook && req.method === 'POST') { reply(res, 200, await service.webhook(webhook[1], req.headers['x-ghn-webhook-secret'], await jsonBody(req))); return; }
      if (path.startsWith('/internal/')) {
        const client = service.authenticate(req.headers.authorization);
        const prefix = '/internal/shipping/ghn';
        const route = path.slice(prefix.length);
        if (!path.startsWith(prefix + '/')) throw new ApiError(404, 'NOT_FOUND');
        if (route === '/shops' && req.method === 'GET') { reply(res, 200, service.shops(client)); return; }
        const location = route.match(/^\/shops\/([A-Za-z0-9_-]+)\/(provinces|wards)$/);
        if (location && req.method === 'GET') {
          const province = location[2] === 'wards' ? integer(Number(url.searchParams.get('provinceId')), 'provinceId', 1, Number.MAX_SAFE_INTEGER) : undefined;
          reply(res, 200, await service.carrier.locations(service.shop(client, location[1]), province)); return;
        }
        if (req.method === 'POST' && route === '/create-order') {
          const result = await service.create(client, req.headers['idempotency-key'], await jsonBody(req));
          reply(res, result.status, result.body); return;
        }
        if (req.method === 'POST' && route === '/preview') { reply(res, 200, await service.preview(client, await jsonBody(req))); return; }
        if (req.method === 'GET' && route === '/shipments') { reply(res, 200, service.list(client, url.searchParams.get('referenceCode'))); return; }
        const shipment = route.match(/^\/shipments\/([a-f0-9-]{36})(\/reconcile)?$/);
        if (shipment && ((!shipment[2] && req.method === 'GET') || (shipment[2] && req.method === 'POST'))) {
          reply(res, 200, shipment[2] ? await service.reconcile(client, shipment[1]) : service.get(client, shipment[1])); return;
        }
        throw new ApiError(404, 'NOT_FOUND');
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') throw new ApiError(404, 'NOT_FOUND');
      const root = resolve(staticDir), file = resolve(root, '.' + decodeURIComponent(path === '/' ? '/index.html' : path));
      if (!file.startsWith(root + sep)) throw new ApiError(404, 'NOT_FOUND');
      try {
        if (!(await stat(file)).isFile()) throw new Error();
        const data = await readFile(file);
        const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };
        res.writeHead(200, { 'Content-Type': types[extname(file)] ?? 'application/octet-stream', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' });
        res.end(req.method === 'HEAD' ? undefined : data); return;
      } catch { throw new ApiError(404, 'NOT_FOUND'); }
    } catch (error) {
      if (!res.headersSent) reply(res, error instanceof ApiError ? error.status : error instanceof CarrierError ? 502 : 500,
        { code: error instanceof ApiError || error instanceof CarrierError ? error.code : 'INTERNAL_ERROR',
          message: error instanceof ApiError ? error.message : 'Không nhận được kết quả hợp lệ; tra cứu lại vận đơn.' });
    }
  });
  server.requestTimeout = 30000;
  server.headersTimeout = 10000;
  return server;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const config = loadConfig(process.env.GHN_CONFIG_FILE);
  const mode = process.env.GHN_MODE ?? 'live';
  if (!['live', 'mock'].includes(mode)) throw new Error('GHN_MODE must be live or mock');
  if (mode === 'live' && [...config.clients.map(c => c.token), ...config.shops.flatMap(s => [s.token, s.webhookSecret])].some(value => /^(demo-|REPLACE_)/.test(value))) throw new Error('Replace example credentials before running live; use npm run demo for mock mode');
  const db = openStore(process.env.GHN_DB_PATH ?? 'data/shipping.sqlite');
  const server = createApp(new ShippingService(db, config, mode === 'mock' ? new MockCarrier() : new GhnCarrier()), { mode });
  server.listen(Number(process.env.PORT ?? 8080), process.env.HOST ?? '127.0.0.1', () => console.log(`GHN service listening (${mode})`));
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close(() => { db.close(); process.exit(0); }));
}

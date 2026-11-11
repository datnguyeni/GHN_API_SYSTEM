import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from './store.mjs';
import { validateConfig } from './config.mjs';
import { ShippingService } from './service.mjs';
import { MockCarrier } from './carrier.mjs';
import { createApp } from './server.mjs';
import { WebhookDispatcher, signature, verifySignature, replayDelivery, deliveries } from './outbound-webhooks.mjs';

const secret = 'crm-outbound-signing-secret-1234567890';
function configuration() {
  const config = JSON.parse(readFileSync(new URL('../config/demo.json', import.meta.url), 'utf8'));
  config.clients[0].webhook = { enabled: true, url: 'https://crm.example.test/hooks/shipping', secret, baseDelayMs: 100, maxDelayMs: 400, timeoutMs: 100, maxAttempts: 3 };
  return validateConfig(config);
}
function input() {
  return { referenceCode: 'WEB-123', shopCode: 'HCM-01', recipient: { name: 'An', phone: '0901234567', address: '123 Street', provinceId: 1000001, wardId: 2000001 }, weight: 1000, length: 30, width: 20, height: 10, codAmount: 250000, insuranceValue: 250000, items: [{ name: 'Áo', quantity: 1 }] };
}
function setup(t, config = configuration()) {
  const db = openStore(':memory:'); t.after(() => db.close());
  return { db, config, client: config.clients[0], service: new ShippingService(db, config, new MockCarrier()) };
}
async function startHttp(t, handler) {
  const server = createServer(handler); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  return `http://127.0.0.1:${server.address().port}`;
}

test('configuration is opt-in; validates HTTPS, credentials, timeouts and secret', () => {
  const config = configuration();
  assert.equal(config.clients[0].webhook.enabled, true);
  for (const update of [{ url: 'http://crm.example.test/hook' }, { url: 'https://user:pass@crm.example.test' }, { url: 'file:///x' }, { url: 'https://crm.example.test/#secret' }, { secret: 'short' }, { secret: 'REPLACE_WITH_RANDOM_SECRET_32_CHARS_MIN' }, { timeoutMs: 0 }, { maxAttempts: 1.5 }, { baseDelayMs: 1000, maxDelayMs: 500 }]) {
    const changed = configuration(); Object.assign(changed.clients[0].webhook, update);
    assert.throws(() => validateConfig(changed));
  }
  config.clients[0].webhook.url = 'http://127.0.0.1:9000/hook'; assert.doesNotThrow(() => validateConfig(config));
  delete config.clients[0].webhook; assert.doesNotThrow(() => validateConfig(config));
});

test('state transitions enqueue once, only for owner; stale and repeated statuses stay local', async t => {
  const { db, service, config, client } = setup(t);
  config.clients.push({ id: 'other', token: 'other-access-token-1234567890123456', shops: ['HCM-01'], webhook: { ...client.webhook, url: 'https://other.example.test/hook' } });
  const shipment = (await service.create(client, 'one', input())).body;
  await service.create(client, 'one', input()); await service.reconcile(client, shipment.id);
  assert.equal(deliveries(db, client).length, 1);
  const event = { OrderCode: shipment.trackingCode, Status: 'delivered', Time: '2026-01-03T00:00:00Z' };
  await service.webhook('HCM-01', config.shops[0].webhookSecret, event);
  await service.webhook('HCM-01', config.shops[0].webhookSecret, event);
  await service.webhook('HCM-01', config.shops[0].webhookSecret, { ...event, Status: 'delivering', Time: '2026-01-02T00:00:00Z' });
  await service.webhook('HCM-01', config.shops[0].webhookSecret, { ...event, Time: '2026-01-04T00:00:00Z' });
  const rows = db.prepare('SELECT * FROM webhook_delivery ORDER BY sequence').all();
  assert.equal(rows.length, 2); assert.equal(rows[0].client, client.id); assert.equal(rows[1].client, client.id);
  assert.equal(deliveries(db, config.clients[1]).length, 0);
  const payload = JSON.parse(rows[1].payload);
  assert.equal(payload.eventType, 'shipment.status_changed'); assert.equal(payload.carrierStatus, 'delivered');
  assert.equal(payload.referenceCode, 'WEB-123'); assert.equal(payload.shipmentId, shipment.id);
  assert.equal(payload.eventId, rows[1].id); assert.equal(payload.sequence, rows[1].sequence);
  assert.equal(payload.recipient, undefined); assert.equal(payload.token, undefined);
});

test('shipment/event/outbox roll back together when enqueue fails', async t => {
  const { db, service, client, config } = setup(t);
  const shipment = (await service.create(client, 'atomic', input())).body;
  db.exec("CREATE TRIGGER fail_outbox BEFORE INSERT ON webhook_delivery BEGIN SELECT RAISE(ABORT,'simulated disk write failure'); END;");
  await assert.rejects(service.webhook('HCM-01', config.shops[0].webhookSecret, { OrderCode: shipment.trackingCode, Status: 'delivered', Time: '2026-01-03T00:00:00Z' }));
  assert.equal(service.get(client, shipment.id).carrierStatus, 'ready_to_pick');
  assert.equal(db.prepare('SELECT count(*) AS n FROM event').get().n, 0);
  assert.equal(deliveries(db, client).length, 1);
});

test('real HTTP receiver verifies exact bytes and HMAC; dispatcher records acknowledgement', async t => {
  let received;
  const origin = await startHttp(t, async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks), timestamp = req.headers['x-ghn-service-timestamp'];
    // Independent receiver implementation, not the production helper.
    const expected = 'sha256=' + createHmac('sha256', secret).update(timestamp + '.').update(raw).digest('hex');
    assert.equal(req.headers['x-ghn-service-signature'], expected);
    assert.equal(req.headers.authorization, undefined);
    received = JSON.parse(raw); assert.equal(req.headers['x-ghn-service-event-id'], received.eventId);
    res.writeHead(204); res.end();
  });
  const config = configuration(); config.clients[0].webhook.url = origin + '/shipping'; config.clients[0].webhook.timeoutMs = 1000;
  const { db, service, client } = setup(t, config);
  await service.create(client, 'http-delivery', input());
  const dispatcher = new WebhookDispatcher(db, config); await dispatcher.tick();
  assert.equal(received.eventType, 'shipment.created');
  const [delivery] = deliveries(db, client);
  assert.equal(delivery.status, 'DELIVERED'); assert.equal(delivery.attempts, 1); assert.equal(delivery.lastHttpStatus, 204);
});

test('signature verification rejects payload tampering, stale timestamps and malformed signatures', () => {
  const timestamp = '1770000000', now = Number(timestamp) * 1000, body = '{"eventId":"one"}';
  const signed = signature(secret, timestamp, body);
  assert.equal(verifySignature(secret, timestamp, signed, Buffer.from(body), now), true);
  assert.equal(verifySignature(secret, timestamp, signed, body + ' ', now), false);
  assert.equal(verifySignature(secret, timestamp, signed, body, now + 301000), false);
  assert.equal(verifySignature(secret, timestamp, 'sha256=00', body, now), false);
  assert.equal(verifySignature(secret, undefined, signed, body, now), false);
});

test('retry uses backoff and stable event ID/body; exhausts then allows scoped manual retry', async t => {
  const { db, service, config, client } = setup(t);
  await service.create(client, 'retry', input());
  let now = Date.now() + 1000; const sent = [];
  const dispatcher = new WebhookDispatcher(db, config, { clock: () => now, fetcher: async (_url, options) => { sent.push(options); return new Response('private CRM error', { status: 503 }); } });
  await dispatcher.tick(); assert.equal(deliveries(db, client)[0].attempts, 1);
  await dispatcher.tick(); assert.equal(sent.length, 1);
  now += 100; await dispatcher.tick(); assert.equal(sent.length, 2);
  now += 200; await dispatcher.tick(); assert.equal(sent.length, 3);
  const failed = deliveries(db, client)[0]; assert.equal(failed.status, 'FAILED');
  assert.equal(failed.lastError, 'HTTP_503'); assert.equal(JSON.stringify(failed).includes('private CRM error'), false);
  assert.equal(sent[0].body, sent[2].body);
  assert.equal(sent[0].headers['X-GHN-Service-Event-Id'], sent[2].headers['X-GHN-Service-Event-Id']);
  assert.throws(() => replayDelivery(db, { ...client, id: 'other' }, failed.eventId), e => e.code === 'WEBHOOK_DELIVERY_NOT_FOUND');
  replayDelivery(db, client, failed.eventId);
  dispatcher.fetch = async () => new Response(null, { status: 204 });
  await dispatcher.tick(); assert.equal(deliveries(db, client)[0].status, 'DELIVERED');
  assert.throws(() => replayDelivery(db, client, failed.eventId), e => e.code === 'WEBHOOK_DELIVERY_NOT_FAILED');
});

test('slow or unavailable receiver never blocks creating a shipment and retries without leaking errors', async t => {
  const { db, service, config, client } = setup(t);
  const created = await service.create(client, 'offline', input());
  assert.equal(created.body.state, 'CREATED'); assert.equal(deliveries(db, client)[0].attempts, 0);
  const dispatcher = new WebhookDispatcher(db, config, { fetcher: async () => { throw new Error('secret CRM URL or token'); } });
  await dispatcher.tick();
  assert.equal(deliveries(db, client)[0].lastError, 'NETWORK_OR_TIMEOUT');
  assert.equal(service.get(client, created.body.id).state, 'CREATED');
});

test('real stalled HTTP receiver is aborted at configured timeout', async t => {
  const origin = await startHttp(t, req => { req.resume(); });
  const config = configuration(); config.clients[0].webhook.url = origin + '/stalled';
  const { db, service, client } = setup(t, config);
  await service.create(client, 'stalled', input());
  await new WebhookDispatcher(db, config).tick();
  assert.equal(deliveries(db, client)[0].status, 'PENDING');
  assert.equal(deliveries(db, client)[0].lastError, 'NETWORK_OR_TIMEOUT');
});

test('automatic worker starts dispatching and waits for an in-flight request on shutdown', async t => {
  const { db, service, config, client } = setup(t);
  await service.create(client, 'lifecycle', input());
  let release, calls = 0; const gate = new Promise(resolve => { release = resolve; });
  const dispatcher = new WebhookDispatcher(db, config, { fetcher: async () => { calls++; await gate; return new Response(null, { status: 204 }); } });
  dispatcher.start(); dispatcher.start(); assert.equal(calls, 1);
  let stopped = false;
  const shutdown = dispatcher.stop().then(() => { stopped = true; });
  await Promise.resolve(); assert.equal(stopped, false);
  release(); await shutdown;
  assert.equal(deliveries(db, client)[0].status, 'DELIVERED');
  await dispatcher.tick(); assert.equal(calls, 1);
});

test('dispatcher keeps per-shipment order while allowing other clients/shipments to proceed', async t => {
  const { db, service, config, client } = setup(t);
  const first = (await service.create(client, 'first', input())).body;
  service.recordEvent(config.shops[0], first.trackingCode, 'delivered', '2026-01-03T00:00:00Z');
  const second = (await service.create(client, 'second', { ...input(), referenceCode: 'WEB-456' })).body;
  const sent = [];
  const dispatcher = new WebhookDispatcher(db, config, { fetcher: async (_url, options) => {
    const data = JSON.parse(options.body); sent.push(data);
    return new Response(null, { status: data.shipmentId === first.id ? 503 : 204 });
  } });
  await dispatcher.tick();
  assert.deepEqual(sent.map(s => s.shipmentId), [first.id, second.id]);
  assert.equal(deliveries(db, client).find(d => d.eventType === 'shipment.status_changed').attempts, 0);
});

test('disabled configuration sends nothing; changed URL requires explicit retry of failed delivery', async t => {
  const { db, service, config, client } = setup(t);
  await service.create(client, 'before-disable', input());
  client.webhook.enabled = false;
  await service.create(client, 'disabled', input());
  let calls = 0;
  const dispatcher = new WebhookDispatcher(db, config, { fetcher: async () => { calls++; return new Response(null, { status: 204 }); } });
  await dispatcher.tick(); assert.equal(calls, 0); assert.equal(deliveries(db, client).length, 1);
  client.webhook.enabled = true; client.webhook.url = 'https://new-crm.example.test/hook';
  await dispatcher.tick(); assert.equal(calls, 0);
  const delivery = deliveries(db, client)[0]; assert.equal(delivery.lastError, 'ENDPOINT_CHANGED');
  replayDelivery(db, client, delivery.eventId); await dispatcher.tick();
  assert.equal(calls, 1); assert.equal(deliveries(db, client)[0].status, 'DELIVERED');
});

test('queue persists across restart and expired in-flight delivery resumes with same ID', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'ghn-outbound-')), filename = join(directory, 'queue.sqlite');
  let db = openStore(filename);
  t.after(() => { db.close(); assert.ok(directory.startsWith(join(tmpdir(), 'ghn-outbound-'))); rmSync(directory, { recursive: true, force: true, maxRetries: 3 }); });
  const config = configuration(), client = config.clients[0];
  await new ShippingService(db, config, new MockCarrier()).create(client, 'restart', input());
  const id = deliveries(db, client)[0].eventId;
  db.prepare("UPDATE webhook_delivery SET status='IN_FLIGHT',attempts=1,lease_until=?").run(new Date(Date.now() - 1000).toISOString());
  db.close(); db = openStore(filename);
  let sent;
  const dispatcher = new WebhookDispatcher(db, config, { fetcher: async (_url, options) => { sent = JSON.parse(options.body); return new Response(null, { status: 204 }); } });
  await dispatcher.tick(); assert.equal(sent.eventId, id);
  assert.equal(deliveries(db, client)[0].status, 'DELIVERED'); assert.equal(deliveries(db, client)[0].attempts, 2);
});

test('concurrent ticks do not dispatch the same row twice', async t => {
  const { db, service, config, client } = setup(t); await service.create(client, 'concurrent', input());
  let release, calls = 0; const gate = new Promise(resolve => { release = resolve; });
  const dispatcher = new WebhookDispatcher(db, config, { fetcher: async () => { calls++; await gate; return new Response(null, { status: 204 }); } });
  const first = dispatcher.tick(); await dispatcher.tick(); assert.equal(calls, 1);
  release(); await first; assert.equal(deliveries(db, client)[0].status, 'DELIVERED');
});

test('authenticated HTTP endpoints reveal no secrets and enforce delivery ownership', async t => {
  const { db, service, client, config } = setup(t);
  const other = { ...client, id: 'other', token: 'other-service-token-12345678901234' }; config.clients.push(other);
  await service.create(client, 'api', input());
  const delivery = deliveries(db, client)[0];
  db.prepare("UPDATE webhook_delivery SET status='FAILED' WHERE id=?").run(delivery.eventId);
  const app = createApp(service); app.listen(0, '127.0.0.1'); await once(app, 'listening');
  t.after(async () => { app.closeAllConnections(); await new Promise(resolve => app.close(resolve)); });
  const origin = `http://127.0.0.1:${app.address().port}/internal/shipping/ghn`;
  const headers = { Authorization: `Bearer ${client.token}` };
  assert.equal((await fetch(origin + '/webhook')).status, 401);
  const settings = await (await fetch(origin + '/webhook', { headers })).json();
  assert.equal(settings.enabled, true); assert.equal(settings.secret, undefined); assert.equal(settings.secretConfigured, true);
  const isolated = await (await fetch(origin + '/webhook/deliveries', { headers: { Authorization: `Bearer ${other.token}` } })).json();
  assert.deepEqual(isolated, []);
  assert.equal((await fetch(origin + '/webhook/deliveries/' + delivery.eventId + '/retry', { method: 'POST', headers: { Authorization: `Bearer ${other.token}` } })).status, 404);
  assert.equal((await fetch(origin + '/webhook/deliveries/' + delivery.eventId + '/retry', { method: 'POST', headers })).status, 202);
});

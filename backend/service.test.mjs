import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { openStore } from './store.mjs';
import { ShippingService } from './service.mjs';
import { MockCarrier, GhnCarrier, CarrierError } from './carrier.mjs';
import { validateConfig } from './config.mjs';
import { createApp } from './server.mjs';

const fixture = () => validateConfig(JSON.parse(readFileSync(new URL('../config/demo.json', import.meta.url), 'utf8')));
const body = () => ({ referenceCode: 'WEB-123', shopCode: 'HCM-01', recipient: { name: 'An', phone: '0901234567', address: '123 Street', provinceId: 1000001, wardId: 2000001 }, weight: 1000, length: 30, width: 20, height: 10, codAmount: 250000, insuranceValue: 250000, serviceTypeId: 2, paymentTypeId: 1, items: [{ name: 'Áo', quantity: 1 }] });
function setup(t, carrier = new MockCarrier()) {
  const db = openStore(':memory:'), config = fixture(), service = new ShippingService(db, config, carrier);
  t.after(() => db.close());
  return { db, config, service, client: config.clients[0] };
}
const rejectsCode = async (promise, code) => assert.rejects(promise, e => e.code === code);

test('create is independent of CRM and maps payload with configured sender', async t => {
  let captured, calls = 0;
  const carrier = new MockCarrier();
  carrier.create = async (_shop, payload) => { calls++; captured = payload; return { order_code: 'GHN123', total_fee: 40000, token: 'never-return-me' }; };
  const { service, client } = setup(t, carrier);
  const first = await service.create(client, 'web-123-shipment-1', body());
  assert.equal(first.status, 201);
  assert.equal(first.body.referenceCode, 'WEB-123');
  assert.equal(first.body.result.totalFee, 40000);
  assert.equal(captured.from_name, 'Shop demo');
  assert.equal(captured.to_province_name, 'Tỉnh demo');
  assert.equal(captured.client_order_code, first.body.id);
  assert.equal(captured.cod_amount, 250000);
  assert.equal(JSON.stringify(first).includes('never-return-me'), false);
  const second = await service.create(client, 'web-123-shipment-1', { ...body(), ignoredCrmProperty: 'not-needed' });
  assert.equal(second.body.id, first.body.id);
  assert.equal(second.status, 200); assert.equal(calls, 1);
  await rejectsCode(service.create(client, 'web-123-shipment-1', { ...body(), codAmount: 1 }), 'IDEMPOTENCY_CONFLICT');
});

test('concurrent requests reserve before network and only call create once', async t => {
  let release, calls = 0;
  const blocker = new Promise(resolve => { release = resolve; });
  const carrier = new MockCarrier();
  carrier.create = async () => { calls++; await blocker; return { order_code: 'ONE' }; };
  const { service, client } = setup(t, carrier);
  const first = service.create(client, 'same-key', body());
  const second = await service.create(client, 'same-key', body());
  assert.equal(second.status, 202); assert.equal(second.body.state, 'CREATING');
  release(); await first; assert.equal(calls, 1);
});

test('timeout stays UNKNOWN across restart and same key never creates twice', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'ghn-service-'));
  const path = join(directory, 'shipping.sqlite'), config = fixture(), client = config.clients[0];
  let db = openStore(path), calls = 0;
  const carrier = new MockCarrier();
  carrier.create = async () => { calls++; throw new CarrierError('GHN_UNAVAILABLE', true); };
  let service = new ShippingService(db, config, carrier);
  const first = await service.create(client, 'timeout', body());
  assert.equal(first.body.state, 'UNKNOWN'); assert.equal(first.status, 202);
  db.close(); db = openStore(path);
  t.after(() => {
    db.close();
    assert.ok(directory.startsWith(join(tmpdir(), 'ghn-service-')));
    rmSync(directory, { recursive: true, force: true, maxRetries: 3 });
  });
  service = new ShippingService(db, config, carrier);
  const replay = await service.create(client, 'timeout', body());
  assert.equal(replay.body.id, first.body.id); assert.equal(calls, 1);
  const recovered = await service.reconcile(client, first.body.id);
  assert.equal(recovered.state, 'CREATED'); assert.equal(calls, 1);
  db.prepare("UPDATE shipment SET state='CREATING' WHERE id=?").run(first.body.id);
  db.close(); db = openStore(path);
  assert.equal(db.prepare('SELECT state FROM shipment WHERE id=?').get(first.body.id).state, 'UNKNOWN');
});

test('known rejection is stored; lookup failure never resets UNKNOWN', async t => {
  const carrier = new MockCarrier();
  carrier.create = async () => { throw new CarrierError('GHN_REJECTED'); };
  const { service, client, db } = setup(t, carrier);
  const rejected = await service.create(client, 'rejected', body());
  assert.equal(rejected.status, 422); assert.equal(rejected.body.state, 'REJECTED');
  carrier.create = async () => { throw new CarrierError('GHN_UNAVAILABLE', true); };
  const pending = await service.create(client, 'unknown', body());
  carrier.lookup = async () => { throw new CarrierError('GHN_REJECTED'); };
  await rejectsCode(service.reconcile(client, pending.body.id), 'GHN_REJECTED');
  assert.equal(db.prepare('SELECT state FROM shipment WHERE id=?').get(pending.body.id).state, 'UNKNOWN');
});

test('clients are isolated even when using same shop and idempotency key', async t => {
  const { service, client } = setup(t);
  const other = { id: 'other', shops: ['HCM-01'] };
  const a = await service.create(client, 'same', body());
  const b = await service.create(other, 'same', body());
  assert.notEqual(a.body.id, b.body.id);
  assert.equal(service.list(other, null).length, 1);
  assert.throws(() => service.get(other, a.body.id), e => e.code === 'SHIPMENT_NOT_FOUND');
  await rejectsCode(service.create({ id: 'denied', shops: [] }, 'key', body()), 'SHOP_ACCESS_DENIED');
});

test('invalid contract does not create; invalid GHN address is rejected before create', async t => {
  let calls = 0;
  const carrier = new MockCarrier(); carrier.create = async () => { calls++; return { order_code: 'X' }; };
  const { service, client } = setup(t, carrier);
  await rejectsCode(service.create(client, '', body()), 'INVALID_FIELD');
  await rejectsCode(service.create(client, 'negative', { ...body(), codAmount: -1 }), 'INVALID_FIELD');
  await rejectsCode(service.create(client, 'decimal', { ...body(), weight: 1.5 }), 'INVALID_FIELD');
  await rejectsCode(service.create(client, 'large', { ...body(), weight: 20000 }), 'INVALID_SERVICE');
  await rejectsCode(service.create(client, 'heavy', { ...body(), serviceTypeId: 5 }), 'INVALID_FIELD');
  const result = await service.create(client, 'wrong-ward', { ...body(), recipient: { ...body().recipient, wardId: 999 } });
  assert.equal(result.body.state, 'REJECTED'); assert.equal(result.body.error, 'INVALID_WARD'); assert.equal(calls, 0);
});

test('webhook authentication, deduplication, monotonic timestamps and lookup sync', async t => {
  const { service, client, config } = setup(t);
  const shipment = (await service.create(client, 'event', body())).body;
  const event = { ShopID: 123456, OrderCode: shipment.trackingCode, Status: 'delivered', Time: '2026-01-02T00:00:00Z' };
  const secret = config.shops[0].webhookSecret;
  await rejectsCode(service.webhook('HCM-01', 'wrong', event), 'UNAUTHORIZED');
  await rejectsCode(service.webhook('HCM-01', secret, { ...event, ShopID: 2 }), 'SHOP_MISMATCH');
  await service.webhook('HCM-01', secret, event); await service.webhook('HCM-01', secret, event);
  await service.webhook('HCM-01', secret, { ...event, Status: 'delivering', Time: '2026-01-01T00:00:00Z' });
  assert.equal(service.get(client, shipment.id).carrierStatus, 'delivered');
  assert.equal(service.get(client, shipment.id).events.length, 2);
  await service.reconcile(client, shipment.id);
  assert.equal(service.get(client, shipment.id).carrierStatus, 'delivered');
  await rejectsCode(service.webhook('HCM-01', secret, { ...event, Time: 'invalid' }), 'INVALID_EVENT_TIME');
  await rejectsCode(service.webhook('HCM-01', secret, { ...event, OrderCode: 'OTHER' }), 'SHIPMENT_NOT_FOUND');
});

test('early webhook recovers UNKNOWN only after provider verifies client order code', async t => {
  const carrier = new MockCarrier();
  carrier.create = async () => { throw new CarrierError('GHN_UNAVAILABLE', true); };
  const { service, client, config } = setup(t, carrier);
  const shipment = (await service.create(client, 'early', body())).body;
  const event = { ClientOrderCode: shipment.id, OrderCode: 'WRONG', Status: 'delivered', Time: '2026-01-02T00:00:00Z' };
  await rejectsCode(service.webhook('HCM-01', config.shops[0].webhookSecret, event), 'TRACKING_MISMATCH');
  assert.equal(service.get(client, shipment.id).state, 'UNKNOWN');
  await service.webhook('HCM-01', config.shops[0].webhookSecret, { ...event, OrderCode: 'DEMO-' + shipment.id });
  assert.equal(service.get(client, shipment.id).state, 'CREATED');
});

test('HTTP contract: auth, JSON, create, list, reconcile, health and static UI', async t => {
  const { service, client } = setup(t);
  // Use the source HTML fixture so tests also pass before the first Vite build.
  const server = createApp(service, { mode: 'mock', staticDir: fileURLToPath(new URL('../', import.meta.url)) }); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const auth = { Authorization: `Bearer ${client.token}`, 'Content-Type': 'application/json' };
  const path = origin + '/internal/shipping/ghn';
  assert.equal((await fetch(path + '/shops')).status, 401);
  const shops = await (await fetch(path + '/shops', { headers: auth })).json();
  assert.equal(shops[0].token, undefined); assert.equal(shops[0].webhookSecret, undefined);
  assert.equal((await fetch(path + '/create-order', { method: 'POST', headers: auth, body: 'no-json' })).status, 400);
  assert.equal((await fetch(path + '/create-order', { method: 'POST', headers: auth, body: JSON.stringify(body()) })).status, 400);
  const response = await fetch(path + '/create-order', { method: 'POST', headers: { ...auth, 'Idempotency-Key': 'http' }, body: JSON.stringify(body()) });
  assert.equal(response.status, 201); const shipment = await response.json();
  assert.equal((await fetch(path + '/shipments/' + shipment.id, { headers: auth })).status, 200);
  assert.equal((await (await fetch(path + '/shipments?referenceCode=WEB-123', { headers: auth })).json()).length, 1);
  assert.equal((await fetch(path + '/shipments/' + shipment.id + '/reconcile', { method: 'POST', headers: auth })).status, 200);
  assert.equal((await (await fetch(origin + '/health')).json()).mode, 'mock');
  assert.equal((await fetch(origin + '/')).status, 200);
});

test('carrier uses fixed GHN origins, no redirects, sanitizes provider errors', async () => {
  const shop = fixture().shops[0]; let url, options;
  const carrier = new GhnCarrier(async (u, o) => { url = u; options = o; return new Response(JSON.stringify({ code: 200, data: { order_code: 'GHN1' } })); });
  await carrier.create(shop, { client_order_code: 'id' });
  assert.equal(url, 'https://dev-online-gateway.ghn.vn/shiip/public-api/v2/shipping-order/create');
  assert.equal(options.redirect, 'error'); assert.equal(options.headers.Token, shop.token);
  await carrier.lookup(shop, 'internal-id');
  assert.equal(url, 'https://dev-online-gateway.ghn.vn/shiip/public-api/v2/shipping-order/detail-by-client-code?client_order_code=internal-id');
  assert.equal(options.method, 'GET');
  const failure = new GhnCarrier(async () => new Response('secret token recipient', { status: 503 }));
  await assert.rejects(failure.create(shop, {}), e => e.unknown && e.code === 'GHN_HTTP_503' && !e.message.includes('secret'));
  const invalid = new GhnCarrier(async () => new Response('not-json'));
  await assert.rejects(invalid.create(shop, {}), e => e.unknown && e.code === 'GHN_INVALID_RESPONSE');
});

test('preview validates addresses, returns fee and does not reserve shipment', async t => {
  const { service, client } = setup(t);
  assert.equal((await service.preview(client, body())).totalFee, 32000);
  assert.equal(service.list(client, null).length, 0);
  await rejectsCode(service.preview(client, { ...body(), recipient: { ...body().recipient, provinceId: 999 } }), 'INVALID_PROVINCE');
  service.carrier.preview = async () => ({});
  await rejectsCode(service.preview(client, body()), 'GHN_INVALID_RESPONSE');
});

test('reconcile updates carrier events but rejects conflicting tracking codes', async t => {
  const carrier = new MockCarrier();
  const { service, client } = setup(t, carrier);
  const shipment = (await service.create(client, 'sync', body())).body;
  carrier.lookup = async () => ({ order_code: shipment.trackingCode, status: 'delivered', updated_date: '2026-01-03T00:00:00Z' });
  assert.equal((await service.reconcile(client, shipment.id)).carrierStatus, 'delivered');
  carrier.lookup = async () => ({ order_code: 'WRONG', status: 'delivering' });
  await rejectsCode(service.reconcile(client, shipment.id), 'TRACKING_MISMATCH');
  assert.equal(service.get(client, shipment.id).carrierStatus, 'delivered');
});

test('provider response without tracking is UNKNOWN and cannot be recreated with same key', async t => {
  const carrier = new MockCarrier(); let calls = 0;
  carrier.create = async () => { calls++; return {}; };
  const { service, client } = setup(t, carrier);
  const first = await service.create(client, 'missing', body());
  assert.equal(first.body.state, 'UNKNOWN');
  await service.create(client, 'missing', body()); assert.equal(calls, 1);
});

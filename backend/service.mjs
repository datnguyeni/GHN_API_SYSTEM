import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { ApiError, canonical, contract, text } from './contract.mjs';
import { CarrierError } from './carrier.mjs';

const digest = value => createHash('sha256').update(value).digest('hex');
export function secretEqual(a, b) {
  return typeof a === 'string' && typeof b === 'string' && timingSafeEqual(Buffer.from(digest(a)), Buffer.from(digest(b)));
}
function publicShipment(row, db) {
  return { id: row.id, referenceCode: row.reference_code, shopCode: row.shop, state: row.state,
    trackingCode: row.tracking, carrierStatus: row.carrier_status, carrierUpdatedAt: row.carrier_time,
    result: row.result ? JSON.parse(row.result) : null, error: row.error,
    createdAt: row.created_at, updatedAt: row.updated_at,
    events: db.prepare('SELECT status,occurred_at AS occurredAt,received_at AS receivedAt FROM event WHERE shipment_id=? ORDER BY occurred_at DESC LIMIT 100').all(row.id) };
}
function carrierResult(data) {
  // Whitelist provider fields; raw responses can contain credentials and recipient data.
  const result = {};
  if (typeof data?.order_code === 'string' && data.order_code.length <= 150) result.trackingCode = data.order_code;
  if (Number.isFinite(data?.total_fee) && data.total_fee >= 0) result.totalFee = data.total_fee;
  if (typeof data?.expected_delivery_time === 'string') result.expectedDeliveryTime = data.expected_delivery_time;
  return result;
}
export class ShippingService {
  constructor(db, config, carrier) { this.db = db; this.config = config; this.carrier = carrier; }
  authenticate(header) {
    const token = typeof header === 'string' && header.startsWith('Bearer ') ? header.slice(7) : '';
    const client = this.config.clients.find(c => secretEqual(c.token, token));
    if (!client) throw new ApiError(401, 'UNAUTHORIZED');
    return client;
  }
  shop(client, code) {
    const shop = this.config.shops.find(s => s.code === code);
    if (!shop || !client.shops.includes(code)) throw new ApiError(403, 'SHOP_ACCESS_DENIED');
    return shop;
  }
  shops(client) {
    return this.config.shops.filter(s => client.shops.includes(s.code)).map(s => ({ code: s.code, name: s.name, environment: s.environment, shopId: s.shopId, sender: s.sender }));
  }
  row(client, id) {
    const row = this.db.prepare('SELECT * FROM shipment WHERE id=? AND client=?').get(id, client.id);
    if (!row) throw new ApiError(404, 'SHIPMENT_NOT_FOUND');
    this.shop(client, row.shop);
    return row;
  }
  get(client, id) { return publicShipment(this.row(client, id), this.db); }
  list(client, referenceCode) {
    const rows = referenceCode === null
      ? this.db.prepare('SELECT * FROM shipment WHERE client=? ORDER BY created_at DESC LIMIT 200').all(client.id)
      : this.db.prepare('SELECT * FROM shipment WHERE client=? AND reference_code=? ORDER BY created_at DESC LIMIT 200').all(client.id, referenceCode);
    return rows.filter(row => client.shops.includes(row.shop)).map(row => publicShipment(row, this.db));
  }
  async preview(client, body) {
    const shop = this.shop(client, body?.shopCode);
    const input = contract(body, shop);
    const payload = await this.carrier.payload(shop, input, randomUUID());
    const result = carrierResult(await this.carrier.preview(shop, payload));
    if (result.totalFee === undefined) throw new CarrierError('GHN_INVALID_RESPONSE', true);
    return result;
  }
  async create(client, key, body) {
    text(key, 'Idempotency-Key', 200);
    const shop = this.shop(client, body?.shopCode);
    const input = contract(body, shop);
    const hash = digest(canonical(input));
    const existing = this.db.prepare('SELECT * FROM shipment WHERE client=? AND idem_key=?').get(client.id, key);
    if (existing) {
      if (existing.hash !== hash) throw new ApiError(409, 'IDEMPOTENCY_CONFLICT');
      return { status: ['CREATING', 'UNKNOWN'].includes(existing.state) ? 202 : 200, body: publicShipment(existing, this.db) };
    }
    const id = randomUUID(), now = new Date().toISOString();
    // Synchronous durable reservation precedes ALL awaits. No automatic create retry.
    this.db.prepare(`INSERT INTO shipment(id,client,idem_key,hash,reference_code,shop,payload,state,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,'CREATING',?,?)`).run(id, client.id, key, hash, input.referenceCode, shop.code, JSON.stringify(input), now, now);
    let sent = false;
    try {
      const payload = await this.carrier.payload(shop, input, id);
      sent = true;
      const data = await this.carrier.create(shop, payload);
      const result = carrierResult(data);
      if (!result.trackingCode) throw new CarrierError('GHN_INVALID_RESPONSE', true);
      this.complete(id, result, 'ready_to_pick');
    } catch (error) {
      const unknown = sent && (!(error instanceof CarrierError) || error.unknown);
      const code = error instanceof ApiError || error instanceof CarrierError ? error.code : 'INTERNAL_ERROR';
      // A verified webhook may have completed the shipment while the request was pending.
      this.db.prepare("UPDATE shipment SET state=?,error=?,updated_at=? WHERE id=? AND state='CREATING'")
        .run(unknown ? 'UNKNOWN' : 'REJECTED', code, new Date().toISOString(), id);
    }
    const out = this.get(client, id);
    return { status: out.state === 'CREATED' ? 201 : ['UNKNOWN', 'CREATING'].includes(out.state) ? 202 : 422, body: out };
  }
  complete(id, result, status) {
    const current = this.db.prepare('SELECT * FROM shipment WHERE id=?').get(id);
    if (current.tracking && current.tracking !== result.trackingCode) throw new ApiError(409, 'TRACKING_MISMATCH');
    this.db.prepare(`UPDATE shipment SET state='CREATED',tracking=?,result=?,error=NULL,
      carrier_status=coalesce(carrier_status,?),updated_at=? WHERE id=?`)
      .run(result.trackingCode, JSON.stringify({ ...(current.result ? JSON.parse(current.result) : {}), ...result }), status, new Date().toISOString(), id);
  }
  async reconcile(client, id) {
    const row = this.row(client, id), shop = this.shop(client, row.shop);
    if (row.state === 'REJECTED') throw new ApiError(409, 'SHIPMENT_REJECTED');
    // Lookup by the immutable provider client_order_code. Never repeat create on uncertainty.
    const data = await this.carrier.lookup(shop, id);
    const result = carrierResult(data);
    if (!result.trackingCode) throw new CarrierError('GHN_INVALID_RESPONSE', true);
    this.complete(id, result, typeof data.status === 'string' ? data.status : 'ready_to_pick');
    if (data.status && data.updated_date) this.recordEvent(shop, result.trackingCode, data.status, data.updated_date);
    return this.get(client, id);
  }
  recordEvent(shop, tracking, status, occurredAt) {
    text(tracking, 'OrderCode', 150); text(status, 'Status', 100);
    if (typeof occurredAt !== 'string' || !Number.isFinite(Date.parse(occurredAt))) throw new ApiError(400, 'INVALID_EVENT_TIME');
    const time = new Date(occurredAt).toISOString();
    if (Date.parse(time) > Date.now() + 300000) throw new ApiError(400, 'INVALID_EVENT_TIME');
    const id = digest(canonical({ shop: shop.code, tracking, status, time }));
    const row = this.db.prepare('SELECT * FROM shipment WHERE shop=? AND tracking=?').get(shop.code, tracking);
    if (!row) throw new ApiError(404, 'SHIPMENT_NOT_FOUND');
    const now = new Date().toISOString();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('INSERT OR IGNORE INTO event VALUES(?,?,?,?,?,?,?)')
        .run(id, row.id, shop.code, tracking, status, time, now);
      this.db.prepare(`UPDATE shipment SET carrier_status=?,carrier_time=?,updated_at=?
        WHERE id=? AND (carrier_time IS NULL OR carrier_time < ?)`)
        .run(status, time, now, row.id, time);
      this.db.exec('COMMIT');
    } catch (e) { this.db.exec('ROLLBACK'); throw e; }
    return { accepted: true };
  }
  async webhook(shopCode, secret, body) {
    const shop = this.config.shops.find(s => s.code === shopCode);
    if (!shop || !secretEqual(shop.webhookSecret, secret)) throw new ApiError(401, 'UNAUTHORIZED');
    text(body?.OrderCode, 'OrderCode', 150);
    text(body?.Status, 'Status', 100);
    if (typeof body?.Time !== 'string' || !Number.isFinite(Date.parse(body.Time)) || Date.parse(body.Time) > Date.now() + 300000) throw new ApiError(400, 'INVALID_EVENT_TIME');
    if (body?.ShopID !== undefined && String(body.ShopID) !== String(shop.shopId)) throw new ApiError(400, 'SHOP_MISMATCH');
    // If GHN's webhook arrives before create returns, resolve through GHN itself first.
    if (!this.db.prepare('SELECT id FROM shipment WHERE shop=? AND tracking=?').get(shop.code, body?.OrderCode ?? '')) {
      const row = typeof body?.ClientOrderCode === 'string' && this.db.prepare('SELECT * FROM shipment WHERE shop=? AND id=?').get(shop.code, body.ClientOrderCode);
      if (row && ['CREATING', 'UNKNOWN'].includes(row.state)) {
        const result = carrierResult(await this.carrier.lookup(shop, row.id));
        if (result.trackingCode !== body.OrderCode) throw new ApiError(409, 'TRACKING_MISMATCH');
        this.complete(row.id, result, 'ready_to_pick');
      }
    }
    return this.recordEvent(shop, body?.OrderCode, body?.Status, body?.Time);
  }
}

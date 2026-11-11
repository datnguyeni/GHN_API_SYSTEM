import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { ApiError } from './contract.mjs';
import { transaction } from './store.mjs';

export const webhookDefaults = { timeoutMs: 10000, maxAttempts: 12, baseDelayMs: 5000, maxDelayMs: 3600000 };

export function validateWebhookConfig(input) {
  if (input === undefined) return;
  if (!input || typeof input !== 'object' || Array.isArray(input) || typeof input.enabled !== 'boolean') throw new Error('webhook.enabled must be true or false');
  const config = { ...webhookDefaults, ...input };
  for (const [key, min, max] of [['timeoutMs', 100, 30000], ['maxAttempts', 1, 50], ['baseDelayMs', 100, 3600000], ['maxDelayMs', 100, 86400000]]) {
    if (!Number.isInteger(config[key]) || config[key] < min || config[key] > max) throw new Error(`Invalid webhook.${key}`);
  }
  if (config.maxDelayMs < config.baseDelayMs) throw new Error('webhook.maxDelayMs must be >= baseDelayMs');
  if (config.enabled) {
    let url;
    try { url = new URL(config.url); } catch { throw new Error('Invalid webhook.url'); }
    const localHttp = url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if ((!localHttp && url.protocol !== 'https:') || url.username || url.password || url.hash) throw new Error('Webhook URL requires HTTPS (HTTP allowed only for loopback), without credentials or fragment');
    if (typeof config.secret !== 'string' || config.secret.length < 32 || /^REPLACE_/.test(config.secret)) throw new Error('Webhook signing secret requires 32+ characters; replace example secret');
  }
  return config;
}

export function signature(secret, timestamp, rawBody) {
  return 'sha256=' + createHmac('sha256', secret).update(timestamp + '.').update(rawBody).digest('hex');
}
// Receivers must supply the original bytes, before JSON parsing or reformatting.
export function verifySignature(secret, timestamp, received, rawBody, now = Date.now()) {
  if (typeof timestamp !== 'string' || !/^[0-9]{10,}$/.test(timestamp) || Math.abs(now / 1000 - Number(timestamp)) > 300 || typeof received !== 'string' || !/^sha256=[a-f0-9]{64}$/.test(received)) return false;
  return timingSafeEqual(Buffer.from(signature(secret, timestamp, rawBody)), Buffer.from(received));
}

// Call inside the same transaction that commits the shipment state.
export function enqueueWebhook(db, config, shipment, eventType, dedupKey, occurredAt) {
  const target = config.clients.find(c => c.id === shipment.client)?.webhook;
  if (!target?.enabled) return;
  const id = randomUUID(), now = new Date().toISOString();
  const inserted = db.prepare(`INSERT OR IGNORE INTO webhook_delivery
    (id,dedup_key,client,shipment_id,event_type,endpoint,payload,next_attempt_at,created_at)
    VALUES(?,?,?,?,?,?,'',?,?)`).run(id, dedupKey, shipment.client, shipment.id, eventType, target.url, now, now);
  if (!inserted.changes) return;
  const payload = { schemaVersion: 1, eventId: id, sequence: Number(inserted.lastInsertRowid), eventType,
    occurredAt, shipmentId: shipment.id, referenceCode: shipment.reference_code, shopCode: shipment.shop,
    trackingCode: shipment.tracking, state: shipment.state, carrierStatus: shipment.carrier_status,
    carrierUpdatedAt: shipment.carrier_time };
  db.prepare('UPDATE webhook_delivery SET payload=? WHERE id=?').run(JSON.stringify(payload), id);
}

export function webhookInfo(client) {
  const config = client.webhook;
  if (!config) return { enabled: false, secretConfigured: false };
  return { enabled: config.enabled, url: config.url ?? '', timeoutMs: config.timeoutMs,
    maxAttempts: config.maxAttempts, baseDelayMs: config.baseDelayMs, maxDelayMs: config.maxDelayMs,
    secretConfigured: typeof config.secret === 'string' && config.secret.length >= 32 };
}
export function deliveries(db, client) {
  return db.prepare(`SELECT id AS eventId,sequence,shipment_id AS shipmentId,event_type AS eventType,
    status,attempts,next_attempt_at AS nextAttemptAt,last_http_status AS lastHttpStatus,
    last_error AS lastError,created_at AS createdAt,delivered_at AS deliveredAt
    FROM webhook_delivery WHERE client=? ORDER BY sequence DESC LIMIT 200`).all(client.id);
}
export function replayDelivery(db, client, id) {
  if (!client.webhook?.enabled) throw new ApiError(409, 'WEBHOOK_DISABLED');
  const result = db.prepare(`UPDATE webhook_delivery SET status='PENDING',attempts=0,next_attempt_at=?,
    lease_until=NULL,last_http_status=NULL,last_error=NULL,endpoint=? WHERE id=? AND client=? AND status='FAILED'`)
    .run(new Date().toISOString(), client.webhook.url, id, client.id);
  if (!result.changes) {
    if (!db.prepare('SELECT id FROM webhook_delivery WHERE id=? AND client=?').get(id, client.id)) throw new ApiError(404, 'WEBHOOK_DELIVERY_NOT_FOUND');
    throw new ApiError(409, 'WEBHOOK_DELIVERY_NOT_FAILED');
  }
  return { eventId: id, status: 'PENDING' };
}

export class WebhookDispatcher {
  constructor(db, config, { fetcher = fetch, clock = Date.now } = {}) {
    this.db = db; this.config = config; this.fetch = fetcher; this.clock = clock;
    this.running = false; this.stopped = false;
  }
  claim() {
    const now = new Date(this.clock()).toISOString();
    const clients = this.config.clients.filter(c => c.webhook?.enabled).map(c => c.id);
    if (!clients.length) return;
    return transaction(this.db, () => {
      this.db.prepare("UPDATE webhook_delivery SET status='PENDING',lease_until=NULL WHERE status='IN_FLIGHT' AND lease_until<=?").run(now);
      const row = this.db.prepare(`SELECT w.* FROM webhook_delivery w
        WHERE w.status='PENDING' AND w.next_attempt_at<=? AND w.client IN (${clients.map(() => '?').join(',')})
        AND NOT EXISTS(SELECT 1 FROM webhook_delivery earlier WHERE earlier.shipment_id=w.shipment_id
          AND earlier.sequence<w.sequence AND earlier.status IN ('PENDING','IN_FLIGHT'))
        ORDER BY w.sequence LIMIT 1`).get(now, ...clients);
      if (!row) return;
      const target = this.config.clients.find(c => c.id === row.client).webhook;
      if (row.endpoint !== target.url || row.attempts >= target.maxAttempts) {
        this.db.prepare("UPDATE webhook_delivery SET status='FAILED',last_error=?,lease_until=NULL WHERE id=?")
          .run(row.endpoint !== target.url ? 'ENDPOINT_CHANGED' : 'MAX_ATTEMPTS_REACHED', row.id);
        return { skipped: true };
      }
      const lease = new Date(this.clock() + target.timeoutMs + 5000).toISOString();
      this.db.prepare("UPDATE webhook_delivery SET status='IN_FLIGHT',attempts=attempts+1,lease_until=? WHERE id=?").run(lease, row.id);
      return { ...row, attempts: row.attempts + 1, target };
    });
  }
  async tick() {
    if (this.running || this.stopped) return;
    this.running = true;
    try {
      for (let count = 0; count < 20 && !this.stopped; count++) {
        const row = this.claim();
        if (!row) break;
        if (row.skipped) continue;
        const timestamp = String(Math.floor(this.clock() / 1000));
        let httpStatus = null, error = null;
        try {
          const response = await this.fetch(row.endpoint, {
            method: 'POST', redirect: 'error', signal: AbortSignal.timeout(row.target.timeoutMs),
            headers: { 'Content-Type': 'application/json', 'X-GHN-Service-Event-Id': row.id,
              'X-GHN-Service-Timestamp': timestamp, 'X-GHN-Service-Signature': signature(row.target.secret, timestamp, row.payload),
              'X-GHN-Service-Attempt': String(row.attempts) }, body: row.payload
          });
          httpStatus = response.status;
          if (!response.ok) error = `HTTP_${response.status}`;
          // Response bodies are neither logged nor stored; they can contain sensitive CRM data.
          try { await response.body?.cancel(); } catch { /* Headers already acknowledged. */ }
        } catch { error = 'NETWORK_OR_TIMEOUT'; }
        const now = this.clock();
        if (!error) {
          this.db.prepare("UPDATE webhook_delivery SET status='DELIVERED',delivered_at=?,last_http_status=?,last_error=NULL,lease_until=NULL WHERE id=?")
            .run(new Date(now).toISOString(), httpStatus, row.id);
        } else {
          const delay = Math.min(row.target.maxDelayMs, row.target.baseDelayMs * 2 ** (row.attempts - 1));
          this.db.prepare(`UPDATE webhook_delivery SET status=?,next_attempt_at=?,last_http_status=?,last_error=?,lease_until=NULL WHERE id=?`)
            .run(row.attempts >= row.target.maxAttempts ? 'FAILED' : 'PENDING', new Date(now + delay).toISOString(), httpStatus, error, row.id);
        }
      }
    } finally { this.running = false; }
  }
  start() {
    if (this.timer) return;
    const poll = () => {
      if (!this.running && !this.stopped) this.active = this.tick().catch(() => console.error('WEBHOOK_DISPATCH_ERROR'));
    };
    this.timer = setInterval(poll, 1000); this.timer.unref(); poll();
  }
  async stop() {
    this.stopped = true; clearInterval(this.timer);
    await this.active;
  }
}

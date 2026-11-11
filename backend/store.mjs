import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export function openStore(filename) {
  if (filename !== ':memory:') mkdirSync(dirname(filename), { recursive: true });
  const db = new DatabaseSync(filename, { timeout: 5000 });
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
    CREATE TABLE IF NOT EXISTS shipment (
      id TEXT PRIMARY KEY, client TEXT NOT NULL, idem_key TEXT NOT NULL, hash TEXT NOT NULL,
      reference_code TEXT NOT NULL, shop TEXT NOT NULL, payload TEXT NOT NULL,
      state TEXT NOT NULL, tracking TEXT, carrier_status TEXT, carrier_time TEXT,
      result TEXT, error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      UNIQUE(client, idem_key), UNIQUE(shop, tracking)
    );
    CREATE TABLE IF NOT EXISTS event (
      id TEXT PRIMARY KEY, shipment_id TEXT REFERENCES shipment(id), shop TEXT NOT NULL,
      tracking TEXT NOT NULL, status TEXT NOT NULL, occurred_at TEXT NOT NULL,
      received_at TEXT NOT NULL, UNIQUE(shop,id)
    );
    CREATE TABLE IF NOT EXISTS webhook_delivery (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
      dedup_key TEXT NOT NULL UNIQUE, client TEXT NOT NULL,
      shipment_id TEXT NOT NULL REFERENCES shipment(id), event_type TEXT NOT NULL,
      endpoint TEXT NOT NULL, payload TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'PENDING', attempts INTEGER NOT NULL DEFAULT 0,
      next_attempt_at TEXT NOT NULL, lease_until TEXT,
      last_http_status INTEGER, last_error TEXT,
      created_at TEXT NOT NULL, delivered_at TEXT
    );
    CREATE INDEX IF NOT EXISTS webhook_due ON webhook_delivery(status,next_attempt_at);
    CREATE INDEX IF NOT EXISTS webhook_client ON webhook_delivery(client,sequence);
    CREATE INDEX IF NOT EXISTS webhook_shipment ON webhook_delivery(shipment_id,sequence);`);
  // A process may have stopped after GHN accepted a request. Never create it again.
  db.prepare("UPDATE shipment SET state='UNKNOWN',error='PROCESS_INTERRUPTED' WHERE state='CREATING'").run();
  return db;
}

export function transaction(db, work) {
  db.exec('BEGIN IMMEDIATE');
  try { const result = work(); db.exec('COMMIT'); return result; }
  catch (error) { db.exec('ROLLBACK'); throw error; }
}

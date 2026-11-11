package vn.ghn.shipping;

import java.util.*;
import java.util.function.Supplier;
import javax.sql.DataSource;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.stereotype.Component;
import org.springframework.transaction.support.TransactionTemplate;

/** One SQLite connection per process. The monitor protects DB work, never network calls. */
@Component
public class Store {
  private final JdbcTemplate jdbc;
  private final TransactionTemplate transactions;
  public Store(DataSource source) {
    jdbc = new JdbcTemplate(source);
    transactions = new TransactionTemplate(new DataSourceTransactionManager(source));
    jdbc.execute("PRAGMA busy_timeout=5000"); jdbc.execute("PRAGMA journal_mode=WAL"); jdbc.execute("PRAGMA foreign_keys=ON");
    jdbc.execute("""
      CREATE TABLE IF NOT EXISTS shipment (
        id TEXT PRIMARY KEY, client TEXT NOT NULL, idem_key TEXT NOT NULL, hash TEXT NOT NULL,
        reference_code TEXT NOT NULL, shop TEXT NOT NULL, payload TEXT NOT NULL,
        state TEXT NOT NULL, tracking TEXT, carrier_status TEXT, carrier_time TEXT,
        result TEXT, error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        UNIQUE(client,idem_key), UNIQUE(shop,tracking))
      """);
    jdbc.execute("""
      CREATE TABLE IF NOT EXISTS event (
        id TEXT PRIMARY KEY, shipment_id TEXT REFERENCES shipment(id), shop TEXT NOT NULL,
        tracking TEXT NOT NULL, status TEXT NOT NULL, occurred_at TEXT NOT NULL,
        received_at TEXT NOT NULL, UNIQUE(shop,id))
      """);
    jdbc.execute("""
      CREATE TABLE IF NOT EXISTS webhook_delivery (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, dedup_key TEXT NOT NULL UNIQUE,
        client TEXT NOT NULL, shipment_id TEXT NOT NULL REFERENCES shipment(id), event_type TEXT NOT NULL,
        endpoint TEXT NOT NULL,payload TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'PENDING',
        attempts INTEGER NOT NULL DEFAULT 0,next_attempt_at TEXT NOT NULL,lease_until TEXT,
        last_http_status INTEGER,last_error TEXT,created_at TEXT NOT NULL,delivered_at TEXT)
      """);
    jdbc.execute("CREATE INDEX IF NOT EXISTS webhook_due ON webhook_delivery(status,next_attempt_at)");
    jdbc.execute("CREATE INDEX IF NOT EXISTS webhook_client ON webhook_delivery(client,sequence)");
    jdbc.execute("CREATE INDEX IF NOT EXISTS webhook_shipment ON webhook_delivery(shipment_id,sequence)");
    update("UPDATE shipment SET state='UNKNOWN',error='PROCESS_INTERRUPTED' WHERE state='CREATING'");
  }
  public synchronized int update(String sql,Object... args) { return jdbc.update(sql,args); }
  public synchronized List<Map<String,Object>> query(String sql,Object... args) { return jdbc.queryForList(sql,args); }
  public synchronized Map<String,Object> one(String sql,Object... args) { var rows=query(sql,args); return rows.isEmpty()?null:rows.getFirst(); }
  public synchronized <T> T tx(Supplier<T> action) { return transactions.execute(status -> action.get()); }
  synchronized void execute(String sql) { jdbc.execute(sql); }
}

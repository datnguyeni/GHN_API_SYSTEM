package vn.ghn.shipping;

import com.fasterxml.jackson.databind.ObjectMapper;
import java.nio.charset.StandardCharsets;
import java.security.*;
import java.time.Instant;
import java.util.*;
import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;
import org.springframework.stereotype.Component;
import static vn.ghn.shipping.JsonSupport.*;

@Component
public class OutboundWebhooks {
  final Store db;
  final ServiceConfig config;
  final ObjectMapper json;
  public OutboundWebhooks(Store db,ServiceConfig config,ObjectMapper json) { this.db=db;this.config=config;this.json=json; }
  public static String signature(String secret,String timestamp,byte[] body) {
    try {
      var mac=Mac.getInstance("HmacSHA256");mac.init(new SecretKeySpec(secret.getBytes(StandardCharsets.UTF_8),"HmacSHA256"));
      mac.update((timestamp+".").getBytes(StandardCharsets.UTF_8));return "sha256="+HexFormat.of().formatHex(mac.doFinal(body));
    } catch(GeneralSecurityException e){throw new IllegalStateException("HMAC_FAILED");}
  }
  public static boolean verify(String secret,String timestamp,String signature,byte[] body,Instant now) {
    if(timestamp==null || !timestamp.matches("[0-9]{10,}") || signature==null || !signature.matches("sha256=[a-f0-9]{64}"))return false;
    try { long age=Math.subtractExact(now.getEpochSecond(),Long.parseLong(timestamp));if(age < -300 || age > 300)return false; }
    catch(ArithmeticException|NumberFormatException e){return false;}
    return MessageDigest.isEqual(signature(secret,timestamp,body).getBytes(StandardCharsets.US_ASCII),signature.getBytes(StandardCharsets.US_ASCII));
  }
  /** Invoked within the same database transaction as the state change. */
  void enqueue(Map<String,Object> shipment,String type,String dedup,String occurredAt) {
    var client=config.clients().stream().filter(c->c.id().equals(str(shipment,"client"))).findFirst().orElse(null);
    if(client==null || client.webhook()==null || !client.webhook().enabled())return;
    String id=UUID.randomUUID().toString(),now=now();
    int inserted=db.update("""
      INSERT OR IGNORE INTO webhook_delivery(id,dedup_key,client,shipment_id,event_type,endpoint,payload,next_attempt_at,created_at)
      VALUES(?,?,?,?,?,?,'',?,?)
      """,id,dedup,client.id(),shipment.get("id"),type,client.webhook().url(),now,now);
    if(inserted==0)return;
    Object sequence=db.one("SELECT sequence FROM webhook_delivery WHERE id=?",id).get("sequence");
    var body=map("schemaVersion",1,"eventId",id,"sequence",sequence,"eventType",type,"occurredAt",occurredAt,
      "shipmentId",shipment.get("id"),"referenceCode",shipment.get("reference_code"),"shopCode",shipment.get("shop"),
      "trackingCode",shipment.get("tracking"),"state",shipment.get("state"),"carrierStatus",shipment.get("carrier_status"),"carrierUpdatedAt",shipment.get("carrier_time"));
    db.update("UPDATE webhook_delivery SET payload=? WHERE id=?",write(json,body),id);
  }
  public Map<String,Object> info(ServiceConfig.Client client) {
    var c=client.webhook();if(c==null)return map("enabled",false,"secretConfigured",false);
    return map("enabled",c.enabled(),"url",c.url(),"timeoutMs",c.timeoutMs(),"maxAttempts",c.maxAttempts(),"baseDelayMs",c.baseDelayMs(),"maxDelayMs",c.maxDelayMs(),"secretConfigured",c.secret().length()>=32);
  }
  public List<Map<String,Object>> deliveries(ServiceConfig.Client client) {
    return db.query("""
      SELECT id AS eventId,sequence,shipment_id AS shipmentId,event_type AS eventType,
        status,attempts,next_attempt_at AS nextAttemptAt,last_http_status AS lastHttpStatus,
        last_error AS lastError,created_at AS createdAt,delivered_at AS deliveredAt
      FROM webhook_delivery WHERE client=? ORDER BY sequence DESC LIMIT 200
      """,client.id());
  }
  public Map<String,Object> replay(ServiceConfig.Client client,String id) {
    if(client.webhook()==null || !client.webhook().enabled())throw new ApiProblem(409,"WEBHOOK_DISABLED");
    return db.tx(()->{
      int updated=db.update("""
        UPDATE webhook_delivery SET status='PENDING',attempts=0,next_attempt_at=?,lease_until=NULL,
          last_http_status=NULL,last_error=NULL,endpoint=? WHERE id=? AND client=? AND status='FAILED'
        """,now(),client.webhook().url(),id,client.id());
      if(updated==0){
        if(db.one("SELECT id FROM webhook_delivery WHERE id=? AND client=?",id,client.id())==null)throw new ApiProblem(404,"WEBHOOK_DELIVERY_NOT_FOUND");
        throw new ApiProblem(409,"WEBHOOK_DELIVERY_NOT_FAILED");
      }
      return map("eventId",id,"status","PENDING");
    });
  }
}

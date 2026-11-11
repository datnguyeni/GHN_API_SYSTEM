package vn.ghn.shipping;

import com.fasterxml.jackson.databind.*;
import com.fasterxml.jackson.databind.node.ObjectNode;
import java.time.Instant;
import java.util.*;
import org.springframework.stereotype.Service;
import static vn.ghn.shipping.JsonSupport.*;

@Service
public class ShippingService {
  final Store db;
  final ServiceConfig config;
  final Carrier carrier;
  final ObjectMapper json;
  final OutboundWebhooks outbox;
  public ShippingService(Store db,ServiceConfig config,Carrier carrier,ObjectMapper json,OutboundWebhooks outbox){this.db=db;this.config=config;this.carrier=carrier;this.json=json;this.outbox=outbox;}
  public record Result(int status,Map<String,Object> body) {}
  public ServiceConfig.Client authenticate(String authorization) {
    String token=authorization!=null && authorization.startsWith("Bearer ")?authorization.substring(7):"";
    return config.clients().stream().filter(c->equal(c.token(),token)).findFirst().orElseThrow(()->new ApiProblem(401,"UNAUTHORIZED"));
  }
  public ServiceConfig.Shop shop(ServiceConfig.Client client,String code) {
    return config.shops().stream().filter(s->s.code().equals(code) && client.shops().contains(code)).findFirst().orElseThrow(()->new ApiProblem(403,"SHOP_ACCESS_DENIED"));
  }
  public List<Map<String,Object>> shops(ServiceConfig.Client client) {
    return config.shops().stream().filter(s->client.shops().contains(s.code())).map(s->map("code",s.code(),"name",s.name(),"environment",s.environment(),"shopId",s.shopId(),"sender",s.sender())).toList();
  }
  private Map<String,Object> row(ServiceConfig.Client client,String id) {
    var row=db.one("SELECT * FROM shipment WHERE id=? AND client=?",id,client.id());
    if(row==null)throw new ApiProblem(404,"SHIPMENT_NOT_FOUND");shop(client,str(row,"shop"));return row;
  }
  private Map<String,Object> view(Map<String,Object> row) {
    return map("id",row.get("id"),"referenceCode",row.get("reference_code"),"shopCode",row.get("shop"),"state",row.get("state"),
      "trackingCode",row.get("tracking"),"carrierStatus",row.get("carrier_status"),"carrierUpdatedAt",row.get("carrier_time"),
      "result",row.get("result")==null?null:read(json,str(row,"result")),"error",row.get("error"),"createdAt",row.get("created_at"),"updatedAt",row.get("updated_at"),
      "events",db.query("SELECT status,occurred_at AS occurredAt,received_at AS receivedAt FROM event WHERE shipment_id=? ORDER BY occurred_at DESC LIMIT 100",row.get("id")));
  }
  public Map<String,Object> get(ServiceConfig.Client client,String id){return view(row(client,id));}
  public List<Map<String,Object>> list(ServiceConfig.Client client,String reference) {
    var rows=reference==null?db.query("SELECT * FROM shipment WHERE client=? ORDER BY created_at DESC LIMIT 200",client.id())
      :db.query("SELECT * FROM shipment WHERE client=? AND reference_code=? ORDER BY created_at DESC LIMIT 200",client.id(),reference);
    return rows.stream().filter(r->client.shops().contains(str(r,"shop"))).map(this::view).toList();
  }
  private ObjectNode result(JsonNode data) {
    var out=json.createObjectNode();
    if(data.path("order_code").isTextual() && !data.path("order_code").asText().isBlank() && data.path("order_code").asText().length()<=150)out.set("trackingCode",data.path("order_code"));
    if(data.path("total_fee").isNumber() && data.path("total_fee").decimalValue().signum()>=0)out.set("totalFee",data.path("total_fee"));
    if(data.path("expected_delivery_time").isTextual())out.set("expectedDeliveryTime",data.path("expected_delivery_time"));
    return out;
  }
  public JsonNode preview(ServiceConfig.Client client,JsonNode body) {
    var shop=shop(client,body.path("shopCode").asText());var input=Contract.normalize(body,shop);
    var result=result(carrier.preview(shop,carrier.payload(shop,input,UUID.randomUUID().toString())));
    if(!result.has("totalFee"))throw new CarrierFailure("GHN_INVALID_RESPONSE",true);return result;
  }
  public Result create(ServiceConfig.Client client,String key,JsonNode body) {
    if(key==null || key.isBlank() || key.length()>200)throw new ApiProblem(400,"INVALID_FIELD");
    var shop=shop(client,body.path("shopCode").asText());var input=Contract.normalize(body,shop);
    String fingerprint=hash(write(json,sorted(input))),id=UUID.randomUUID().toString();
    var existing=db.tx(()->{
      var previous=db.one("SELECT * FROM shipment WHERE client=? AND idem_key=?",client.id(),key);
      if(previous!=null){if(!fingerprint.equals(previous.get("hash")))throw new ApiProblem(409,"IDEMPOTENCY_CONFLICT");return previous;}
      String now=now();
      db.update("""
        INSERT INTO shipment(id,client,idem_key,hash,reference_code,shop,payload,state,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,'CREATING',?,?)
        """,id,client.id(),key,fingerprint,input.path("referenceCode").asText(),shop.code(),write(json,input),now,now);
      return null;
    });
    if(existing!=null)return new Result(Set.of("CREATING","UNKNOWN").contains(str(existing,"state"))?202:200,view(existing));
    boolean sent=false;
    try {
      var payload=carrier.payload(shop,input,id);sent=true;var result=result(carrier.create(shop,payload));
      if(!result.has("trackingCode"))throw new CarrierFailure("GHN_INVALID_RESPONSE",true);
      complete(id,result,"ready_to_pick");
    } catch(Exception error) {
      boolean unknown=sent && (!(error instanceof CarrierFailure failure) || failure.unknown);
      String code=error instanceof ApiProblem p?p.code:error instanceof CarrierFailure c?c.code:"INTERNAL_ERROR";
      db.update("UPDATE shipment SET state=?,error=?,updated_at=? WHERE id=? AND state='CREATING'",unknown?"UNKNOWN":"REJECTED",code,now(),id);
    }
    var output=get(client,id);String state=(String)output.get("state");
    return new Result(state.equals("CREATED")?201:Set.of("UNKNOWN","CREATING").contains(state)?202:422,output);
  }
  void complete(String id,ObjectNode result,String status) {
    db.tx(()->{
      var current=db.one("SELECT * FROM shipment WHERE id=?",id);
      if(current.get("tracking")!=null && !current.get("tracking").equals(result.path("trackingCode").asText()))throw new ApiProblem(409,"TRACKING_MISMATCH");
      var merged=current.get("result")==null?json.createObjectNode():(ObjectNode)read(json,str(current,"result"));merged.setAll(result);
      String now=now();
      db.update("UPDATE shipment SET state='CREATED',tracking=?,result=?,error=NULL,carrier_status=coalesce(carrier_status,?),updated_at=? WHERE id=?",
        result.path("trackingCode").asText(),write(json,merged),status,now,id);
      if(!"CREATED".equals(current.get("state")))outbox.enqueue(db.one("SELECT * FROM shipment WHERE id=?",id),"shipment.created","created:"+id,now);
      return null;
    });
  }
  public Map<String,Object> reconcile(ServiceConfig.Client client,String id) {
    var row=row(client,id);if("REJECTED".equals(row.get("state")))throw new ApiProblem(409,"SHIPMENT_REJECTED");
    var shop=shop(client,str(row,"shop"));var data=carrier.lookup(shop,id);var result=result(data);
    if(!result.has("trackingCode"))throw new CarrierFailure("GHN_INVALID_RESPONSE",true);
    complete(id,result,data.path("status").asText("ready_to_pick"));
    if(data.path("status").isTextual() && data.path("updated_date").isTextual())recordEvent(shop,result.path("trackingCode").asText(),data.path("status").asText(),data.path("updated_date").asText());
    return get(client,id);
  }
  public Map<String,Object> recordEvent(ServiceConfig.Shop shop,String tracking,String status,String timeValue) {
    if(tracking==null || tracking.isBlank() || tracking.length()>150 || status==null || status.isBlank() || status.length()>100)throw new ApiProblem(400,"INVALID_FIELD");
    var occurred=instant(timeValue);if(occurred.isAfter(Instant.now().plusSeconds(300)))throw new ApiProblem(400,"INVALID_EVENT_TIME");
    String time=iso(occurred),dedup=hash(write(json,sorted(json.valueToTree(map("shop",shop.code(),"tracking",tracking,"status",status,"time",time)))));
    return db.tx(()->{
      var row=db.one("SELECT * FROM shipment WHERE shop=? AND tracking=?",shop.code(),tracking);
      if(row==null)throw new ApiProblem(404,"SHIPMENT_NOT_FOUND");String now=now();
      db.update("INSERT OR IGNORE INTO event VALUES(?,?,?,?,?,?,?)",dedup,row.get("id"),shop.code(),tracking,status,time,now);
      int updated=db.update("UPDATE shipment SET carrier_status=?,carrier_time=?,updated_at=? WHERE id=? AND (carrier_time IS NULL OR carrier_time < ?)",status,time,now,row.get("id"),time);
      if(updated>0 && !status.equals(row.get("carrier_status")))outbox.enqueue(db.one("SELECT * FROM shipment WHERE id=?",row.get("id")),"shipment.status_changed","status:"+dedup,time);
      return map("accepted",true);
    });
  }
  public Map<String,Object> webhook(String shopCode,String secret,JsonNode body) {
    var shop=config.shops().stream().filter(s->s.code().equals(shopCode) && equal(s.webhookSecret(),secret)).findFirst().orElseThrow(()->new ApiProblem(401,"UNAUTHORIZED"));
    String tracking=text(body,"OrderCode",150),status=text(body,"Status",100),time=text(body,"Time",100);
    if(instant(time).isAfter(Instant.now().plusSeconds(300)))throw new ApiProblem(400,"INVALID_EVENT_TIME");
    if(body.has("ShopID") && !body.path("ShopID").asText().equals(Long.toString(shop.shopId())))throw new ApiProblem(400,"SHOP_MISMATCH");
    if(db.one("SELECT id FROM shipment WHERE shop=? AND tracking=?",shop.code(),tracking)==null && body.path("ClientOrderCode").isTextual()) {
      var row=db.one("SELECT * FROM shipment WHERE shop=? AND id=?",shop.code(),body.path("ClientOrderCode").asText());
      if(row!=null && Set.of("CREATING","UNKNOWN").contains(str(row,"state"))) {
        var result=result(carrier.lookup(shop,str(row,"id")));
        if(!tracking.equals(result.path("trackingCode").asText()))throw new ApiProblem(409,"TRACKING_MISMATCH");
        complete(str(row,"id"),result,"ready_to_pick");
      }
    }
    return recordEvent(shop,tracking,status,time);
  }
}

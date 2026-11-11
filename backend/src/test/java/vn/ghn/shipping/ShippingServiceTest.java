package vn.ghn.shipping;

import com.fasterxml.jackson.databind.*;
import com.fasterxml.jackson.databind.node.*;
import java.nio.file.*;
import java.time.*;
import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.jupiter.api.*;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.jdbc.datasource.SingleConnectionDataSource;
import static org.junit.jupiter.api.Assertions.*;
import static vn.ghn.shipping.JsonSupport.*;

class ShippingServiceTest {
  final ObjectMapper json=new ObjectMapper();
  SingleConnectionDataSource source;
  Store db;
  ServiceConfig config;
  ServiceConfig.Client client;
  OutboundWebhooks outbox;
  ShippingService service;
  JsonNode input;
  @BeforeEach void setup() throws Exception {
    config=ServiceConfig.load(json.readTree(Files.readString(Path.of("../config/demo.json"))),"mock");client=config.clients().getFirst();
    input=json.readTree(getClass().getResourceAsStream("/legacy-contract.json")).path("input");
    source=new SingleConnectionDataSource("jdbc:sqlite::memory:",true);db=new Store(source);use(new MockCarrier(json));
  }
  @AfterEach void close(){source.destroy();}
  void use(Carrier carrier){outbox=new OutboundWebhooks(db,config,json);service=new ShippingService(db,config,carrier,json,outbox);}
  void problem(int status,String code,org.junit.jupiter.api.function.Executable action){var e=assertThrows(ApiProblem.class,action);assertEquals(status,e.status);assertEquals(code,e.code);}
  String id(ShippingService.Result result){return (String)result.body().get("id");}

  @Test void createMapsSenderAndCodWithoutCrm() {
    var calls=new AtomicInteger();
    use(new MockCarrier(json){@Override public JsonNode create(ServiceConfig.Shop shop,JsonNode payload){
      calls.incrementAndGet();assertEquals("Shop demo",payload.path("from_name").asText());assertEquals(250000,payload.path("cod_amount").asInt());
      assertEquals("Tỉnh demo",payload.path("to_province_name").asText());return json.createObjectNode().put("order_code","GHN123").put("total_fee",32000).put("token","never-return-me");
    }});
    var a=service.create(client,"shipment-1",input);var b=service.create(client,"shipment-1",input);
    assertEquals(201,a.status());assertEquals(200,b.status());assertEquals(id(a),id(b));assertEquals(1,calls.get());
    assertFalse(write(json,a.body()).contains("never-return-me"));
    problem(409,"IDEMPOTENCY_CONFLICT",()->service.create(client,"shipment-1",((ObjectNode)input.deepCopy()).put("codAmount",0)));
  }
  @Test void concurrentReservationOnlyCallsGhnOnce() throws Exception {
    var entered=new CountDownLatch(1);var release=new CountDownLatch(1);var calls=new AtomicInteger();
    use(new MockCarrier(json){@Override public JsonNode create(ServiceConfig.Shop shop,JsonNode payload){
      calls.incrementAndGet();entered.countDown();try{if(!release.await(5,TimeUnit.SECONDS))throw new IllegalStateException();}catch(InterruptedException e){throw new IllegalStateException(e);}return super.create(shop,payload);
    }});
    try(var executor=Executors.newVirtualThreadPerTaskExecutor()){
      var first=executor.submit(()->service.create(client,"same",input));assertTrue(entered.await(5,TimeUnit.SECONDS));
      try{var replay=service.create(client,"same",input);assertEquals(202,replay.status());assertEquals("CREATING",replay.body().get("state"));}
      finally{release.countDown();}
      assertEquals(201,first.get(5,TimeUnit.SECONDS).status());assertEquals(1,calls.get());
    }
  }
  @Test void unknownIsNeverCreatedAgainAndLookupCanRecover() {
    var calls=new AtomicInteger();
    use(new MockCarrier(json){@Override public JsonNode create(ServiceConfig.Shop shop,JsonNode payload){calls.incrementAndGet();throw new CarrierFailure("GHN_UNAVAILABLE",true);}});
    var a=service.create(client,"timeout",input);assertEquals(202,a.status());assertEquals("UNKNOWN",a.body().get("state"));
    service.create(client,"timeout",input);assertEquals(1,calls.get());assertEquals("CREATED",service.reconcile(client,id(a)).get("state"));assertEquals(1,calls.get());
  }
  @Test void invalidResponseIsUnknownAndProviderRejectionIsStored() {
    use(new MockCarrier(json){@Override public JsonNode create(ServiceConfig.Shop shop,JsonNode payload){return json.createObjectNode();}});
    assertEquals("UNKNOWN",service.create(client,"missing",input).body().get("state"));
    use(new MockCarrier(json){@Override public JsonNode create(ServiceConfig.Shop shop,JsonNode payload){throw new CarrierFailure("GHN_REJECTED",false);}});
    var rejected=service.create(client,"rejected",input);assertEquals(422,rejected.status());assertEquals("REJECTED",rejected.body().get("state"));
    problem(409,"SHIPMENT_REJECTED",()->service.reconcile(client,id(rejected)));
  }
  @Test void clientsAndShopsAreIsolated() {
    var other=new ServiceConfig.Client("other","other-token-1234567890123456789012",client.shops(),null);
    var a=service.create(client,"same",input);var b=service.create(other,"same",input);assertNotEquals(id(a),id(b));
    assertEquals(1,service.list(other,null).size());problem(404,"SHIPMENT_NOT_FOUND",()->service.get(other,id(a)));
    problem(403,"SHOP_ACCESS_DENIED",()->service.create(new ServiceConfig.Client("denied","x",List.of(),null),"key",input));
    problem(401,"UNAUTHORIZED",()->service.authenticate("Bearer wrong"));assertEquals(client,service.authenticate("Bearer "+client.token()));
  }
  @Test void validatesAmountsWeightsItemsAndAddressesBeforeCreate() {
    problem(400,"INVALID_FIELD",()->service.create(client,"",input));
    problem(400,"INVALID_FIELD",()->service.create(client,"negative",((ObjectNode)input.deepCopy()).put("codAmount",-1)));
    problem(400,"INVALID_FIELD",()->service.create(client,"fraction",((ObjectNode)input.deepCopy()).put("weight",1.5)));
    problem(400,"INVALID_SERVICE",()->service.create(client,"heavy",((ObjectNode)input.deepCopy()).put("weight",20000)));
    var wrong=input.deepCopy();((ObjectNode)wrong.path("recipient")).put("wardId",999);
    var result=service.create(client,"ward",wrong);assertEquals("REJECTED",result.body().get("state"));assertEquals("INVALID_WARD",result.body().get("error"));
    var heavy=(ObjectNode)input.deepCopy();heavy.put("serviceTypeId",5);var item=(ObjectNode)heavy.path("items").get(0);
    item.put("weight",999).put("length",1).put("width",1).put("height",1);
    problem(400,"INVALID_PACKAGE_WEIGHT",()->service.create(client,"heavy-mismatch",heavy));
  }
  @Test void previewDoesNotReserveAndRejectsInvalidFee() {
    assertEquals(32000,service.preview(client,input).path("totalFee").asInt());assertTrue(service.list(client,null).isEmpty());
    use(new MockCarrier(json){@Override public JsonNode preview(ServiceConfig.Shop shop,JsonNode payload){return json.createObjectNode();}});
    assertThrows(CarrierFailure.class,()->service.preview(client,input));
  }
  @Test void incomingWebhookAuthenticatesDeduplicatesAndOrdersEvents() {
    var a=service.create(client,"event",input);var event=event(a,"delivered","2026-01-03T00:00:00Z");String secret=config.shops().getFirst().webhookSecret();
    problem(401,"UNAUTHORIZED",()->service.webhook("HCM-01","wrong",event));
    problem(400,"SHOP_MISMATCH",()->service.webhook("HCM-01",secret,event.deepCopy().put("ShopID",2)));
    service.webhook("HCM-01",secret,event);service.webhook("HCM-01",secret,event);
    service.webhook("HCM-01",secret,event(a,"delivering","2026-01-02T00:00:00Z"));
    var result=service.get(client,id(a));assertEquals("delivered",result.get("carrierStatus"));assertEquals(2,((List<?>)result.get("events")).size());
    service.reconcile(client,id(a));assertEquals("delivered",service.get(client,id(a)).get("carrierStatus"));
    problem(400,"INVALID_EVENT_TIME",()->service.webhook("HCM-01",secret,event.deepCopy().put("Time","bad")));
  }
  ObjectNode event(ShippingService.Result shipment,String status,String time){return json.createObjectNode().put("OrderCode",(String)shipment.body().get("trackingCode")).put("ShopID",123456).put("Status",status).put("Time",time);}
  @Test void earlyWebhookVerifiesTrackingAgainstGhn() {
    use(new MockCarrier(json){@Override public JsonNode create(ServiceConfig.Shop shop,JsonNode payload){throw new CarrierFailure("GHN_UNAVAILABLE",true);}});
    var a=service.create(client,"early",input);var event=event(a,"delivered","2026-01-03T00:00:00Z").put("ClientOrderCode",id(a)).put("OrderCode","WRONG");
    problem(409,"TRACKING_MISMATCH",()->service.webhook("HCM-01",config.shops().getFirst().webhookSecret(),event));
    service.webhook("HCM-01",config.shops().getFirst().webhookSecret(),event.put("OrderCode","DEMO-"+id(a)));
    assertEquals("CREATED",service.get(client,id(a)).get("state"));
  }
  @Test void lookupUpdatesStatusAndRejectsConflictingCode() {
    var a=service.create(client,"lookup",input);
    use(new MockCarrier(json){@Override public JsonNode lookup(ServiceConfig.Shop shop,String id){return json.createObjectNode().put("order_code","DEMO-"+id).put("status","delivered").put("updated_date","2026-01-03T00:00:00Z");}});
    assertEquals("delivered",service.reconcile(client,id(a)).get("carrierStatus"));
    use(new MockCarrier(json){@Override public JsonNode lookup(ServiceConfig.Shop shop,String id){return json.createObjectNode().put("order_code","WRONG");}});
    problem(409,"TRACKING_MISMATCH",()->service.reconcile(client,id(a)));
  }
  @Test void fingerprintAndReplayAreCompatibleWithNodeVersion() throws Exception {
    var legacy=json.readTree(getClass().getResourceAsStream("/legacy-contract.json"));
    var normalized=Contract.normalize(input,config.shops().getFirst());
    assertEquals(legacy.path("canonical").asText(),write(json,sorted(normalized)));
    assertEquals(legacy.path("fingerprint").asText(),hash(write(json,sorted(normalized))));
    String id=UUID.randomUUID().toString();
    db.update("INSERT INTO shipment(id,client,idem_key,hash,reference_code,shop,payload,state,tracking,created_at,updated_at) VALUES(?,?,?,?,?,?,?,'CREATED','OLD-GHN',?,?)",
      id,client.id(),"node-key",legacy.path("fingerprint").asText(),"WEB-123","HCM-01",write(json,legacy.path("normalized")),now(),now());
    var replay=service.create(client,"node-key",input);assertEquals(200,replay.status());assertEquals(id,id(replay));assertEquals("OLD-GHN",replay.body().get("trackingCode"));
  }
  @Test void sqlitePersistsAndInterruptedCreateRecoversAsUnknown(@TempDir Path directory) {
    source.destroy();String url="jdbc:sqlite:"+directory.resolve("shipping.sqlite");source=new SingleConnectionDataSource(url,true);db=new Store(source);use(new MockCarrier(json));
    var a=service.create(client,"persist",input);db.update("UPDATE shipment SET state='CREATING' WHERE id=?",id(a));
    source.destroy();source=new SingleConnectionDataSource(url,true);db=new Store(source);use(new MockCarrier(json));
    assertEquals("UNKNOWN",service.get(client,id(a)).get("state"));assertEquals(id(a),id(service.create(client,"persist",input)));
  }
}

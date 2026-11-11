package vn.ghn.shipping;

import com.fasterxml.jackson.databind.*;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.sun.net.httpserver.HttpServer;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.time.*;
import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.*;
import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;
import org.junit.jupiter.api.*;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.jdbc.datasource.SingleConnectionDataSource;
import static org.junit.jupiter.api.Assertions.*;
import static vn.ghn.shipping.JsonSupport.*;

class OutboundWebhooksTest {
  final ObjectMapper json=new ObjectMapper();
  final String secret="crm-outbound-signing-secret-1234567890";
  SingleConnectionDataSource source;
  Store db;
  ServiceConfig config;
  ServiceConfig.Client client;
  OutboundWebhooks outbox;
  ShippingService service;
  JsonNode input;
  ObjectNode root;
  @BeforeEach void setup() throws Exception {
    root=(ObjectNode)json.readTree(Files.readString(Path.of("../config/demo.json")));
    ((ObjectNode)root.path("clients").get(0)).set("webhook",json.createObjectNode().put("enabled",true).put("url","https://crm.example.test/hooks/shipping")
      .put("secret",secret).put("timeoutMs",100).put("maxAttempts",3).put("baseDelayMs",100).put("maxDelayMs",400));
    config=ServiceConfig.load(root,"mock");client=config.clients().getFirst();
    source=new SingleConnectionDataSource("jdbc:sqlite::memory:",true);db=new Store(source);wire();
    input=json.readTree(getClass().getResourceAsStream("/legacy-contract.json")).path("input");
  }
  void wire(){outbox=new OutboundWebhooks(db,config,json);service=new ShippingService(db,config,new MockCarrier(json),json,outbox);}
  @AfterEach void close(){source.destroy();}
  ShippingService.Result create(String key){return service.create(client,key,input);}
  Map<String,Object> delivery(){return outbox.deliveries(client).getFirst();}
  static class MutableClock extends Clock {
    Instant time=Instant.now().plusSeconds(1);
    @Override public ZoneId getZone(){return ZoneOffset.UTC;}
    @Override public Clock withZone(ZoneId zone){return this;}
    @Override public Instant instant(){return time;}
    void advance(long millis){time=time.plusMillis(millis);}
  }
  void reconfigure(){config=ServiceConfig.load(root,"mock");client=config.clients().getFirst();wire();}
  ObjectNode webhook(){return (ObjectNode)root.path("clients").get(0).path("webhook");}

  @Test void configValidatesUrlSecretsAndRetryLimits(){
    for(String url:List.of("http://crm.example.test/hook","file:///x","https://user:pass@crm.example.test","https://crm.example.test/#fragment")){
      var changed=root.deepCopy();((ObjectNode)changed.path("clients").get(0).path("webhook")).put("url",url);assertThrows(IllegalArgumentException.class,()->ServiceConfig.load(changed,"mock"));
    }
    webhook().put("url","http://127.0.0.1:9000/hook");assertDoesNotThrow(()->ServiceConfig.load(root,"mock"));
    webhook().put("secret","short");assertThrows(IllegalArgumentException.class,()->ServiceConfig.load(root,"mock"));
    webhook().put("enabled",false);assertDoesNotThrow(()->ServiceConfig.load(root,"mock"));
    webhook().put("maxAttempts",0);assertThrows(IllegalArgumentException.class,()->ServiceConfig.load(root,"mock"));
  }
  @Test void notificationsAreDeduplicatedOrderedAndContainNoRecipientData(){
    var a=create("one");create("one");service.reconcile(client,(String)a.body().get("id"));
    var shop=config.shops().getFirst();String tracking=(String)a.body().get("trackingCode");
    service.recordEvent(shop,tracking,"delivered","2026-01-03T00:00:00Z");service.recordEvent(shop,tracking,"delivered","2026-01-03T00:00:00Z");
    service.recordEvent(shop,tracking,"delivering","2026-01-02T00:00:00Z");service.recordEvent(shop,tracking,"delivered","2026-01-04T00:00:00Z");
    assertEquals(2,outbox.deliveries(client).size());
    var payload=read(json,str(db.one("SELECT payload FROM webhook_delivery ORDER BY sequence DESC LIMIT 1"),"payload"));
    assertEquals("shipment.status_changed",payload.path("eventType").asText());assertEquals("WEB-123",payload.path("referenceCode").asText());
    assertEquals("delivered",payload.path("carrierStatus").asText());assertFalse(payload.has("recipient"));assertFalse(payload.has("token"));
    var other=new ServiceConfig.Client("other","x",client.shops(),client.webhook());assertTrue(outbox.deliveries(other).isEmpty());
    assertFalse(write(json,outbox.info(client)).contains(secret));
  }
  @Test void statusAndOutboxCommitAtomically(){
    var a=create("atomic");
    db.execute("CREATE TRIGGER fail_outbox BEFORE INSERT ON webhook_delivery BEGIN SELECT RAISE(ABORT,'simulated failure'); END;");
    assertThrows(Exception.class,()->service.recordEvent(config.shops().getFirst(),(String)a.body().get("trackingCode"),"delivered","2026-01-03T00:00:00Z"));
    assertEquals("ready_to_pick",service.get(client,(String)a.body().get("id")).get("carrierStatus"));
    assertTrue(db.query("SELECT * FROM event").isEmpty());assertEquals(1,outbox.deliveries(client).size());
  }
  @Test void signatureUsesExactUtf8BytesAndRejectsTamperingAndStaleTimestamp() throws Exception {
    byte[] body="{\"name\":\"Áo thun\"}".getBytes(StandardCharsets.UTF_8);String timestamp="1770000000";
    var mac=Mac.getInstance("HmacSHA256");mac.init(new SecretKeySpec(secret.getBytes(StandardCharsets.UTF_8),"HmacSHA256"));
    mac.update((timestamp+".").getBytes(StandardCharsets.UTF_8));String expected="sha256="+HexFormat.of().formatHex(mac.doFinal(body));
    assertEquals(expected,OutboundWebhooks.signature(secret,timestamp,body));
    var now=Instant.ofEpochSecond(Long.parseLong(timestamp));assertTrue(OutboundWebhooks.verify(secret,timestamp,expected,body,now));
    assertFalse(OutboundWebhooks.verify(secret,timestamp,expected,"changed".getBytes(StandardCharsets.UTF_8),now));
    assertFalse(OutboundWebhooks.verify(secret,timestamp,expected,body,now.plusSeconds(301)));
    assertFalse(OutboundWebhooks.verify(secret,timestamp,"sha256=00",body,now));
  }
  @Test void retriesBackOffWithSameEventIdAndBodyThenCanBeReplayed(){
    create("retry");var clock=new MutableClock();var sent=new ArrayList<String>();
    var dispatcher=new WebhookDispatcher(db,config,(url,headers,body,timeout)->{sent.add(body);return 503;},clock);
    dispatcher.tick();assertEquals(1,((Number)delivery().get("attempts")).intValue());dispatcher.tick();assertEquals(1,sent.size());
    clock.advance(100);dispatcher.tick();clock.advance(200);dispatcher.tick();
    assertEquals("FAILED",delivery().get("status"));assertEquals("HTTP_503",delivery().get("lastError"));assertEquals(sent.get(0),sent.get(2));
    String id=(String)delivery().get("eventId");var other=new ServiceConfig.Client("other","x",client.shops(),client.webhook());
    assertEquals("WEBHOOK_DELIVERY_NOT_FOUND",assertThrows(ApiProblem.class,()->outbox.replay(other,id)).code);
    outbox.replay(client,id);new WebhookDispatcher(db,config,(url,headers,body,timeout)->204,clock).tick();assertEquals("DELIVERED",delivery().get("status"));
    assertThrows(ApiProblem.class,()->outbox.replay(client,id));
  }
  @Test void offlineCrmNeverBlocksCreateOrLeaksResponse(){
    var result=create("offline");assertEquals(201,result.status());assertEquals(0,((Number)delivery().get("attempts")).intValue());
    new WebhookDispatcher(db,config,(url,headers,body,timeout)->{throw new java.io.IOException("secret url token");},new MutableClock()).tick();
    assertEquals("PENDING",delivery().get("status"));assertEquals("NETWORK_OR_TIMEOUT",delivery().get("lastError"));
    assertEquals("CREATED",service.get(client,(String)result.body().get("id")).get("state"));
  }
  @Test void blockedShipmentDoesNotBlockOtherShipments(){
    var first=create("first");service.recordEvent(config.shops().getFirst(),(String)first.body().get("trackingCode"),"delivered","2026-01-03T00:00:00Z");var second=create("second");
    var sent=new ArrayList<String>();
    new WebhookDispatcher(db,config,(url,headers,body,timeout)->{String id=read(json,body).path("shipmentId").asText();sent.add(id);return id.equals(first.body().get("id"))?503:204;},new MutableClock()).tick();
    assertEquals(List.of(first.body().get("id"),second.body().get("id")),sent);
    assertEquals(0,((Number)db.one("SELECT attempts FROM webhook_delivery WHERE event_type='shipment.status_changed'").get("attempts")).intValue());
  }
  @Test void disabledWebhookDoesNotSendAndChangedEndpointRequiresReplay(){
    create("before");webhook().put("enabled",false);reconfigure();create("while-disabled");var calls=new AtomicInteger();
    new WebhookDispatcher(db,config,(url,h,b,t)->{calls.incrementAndGet();return 204;},new MutableClock()).tick();assertEquals(0,calls.get());assertEquals(1,outbox.deliveries(client).size());
    webhook().put("enabled",true).put("url","https://new.example.test/hook");reconfigure();
    new WebhookDispatcher(db,config,(url,h,b,t)->{calls.incrementAndGet();return 204;},new MutableClock()).tick();
    assertEquals(0,calls.get());assertEquals("ENDPOINT_CHANGED",delivery().get("lastError"));outbox.replay(client,(String)delivery().get("eventId"));
    new WebhookDispatcher(db,config,(url,h,b,t)->{calls.incrementAndGet();return 204;},new MutableClock()).tick();assertEquals(1,calls.get());assertEquals("DELIVERED",delivery().get("status"));
  }
  @Test void queuePersistsAndExpiredLeaseResumesWithSameEventId(@TempDir Path directory){
    source.destroy();String url="jdbc:sqlite:"+directory.resolve("queue.sqlite");source=new SingleConnectionDataSource(url,true);db=new Store(source);wire();
    create("persist");String id=(String)delivery().get("eventId");
    db.update("UPDATE webhook_delivery SET status='IN_FLIGHT',attempts=1,lease_until=?",iso(Instant.now().minusSeconds(1)));
    source.destroy();source=new SingleConnectionDataSource(url,true);db=new Store(source);wire();
    new WebhookDispatcher(db,config,(u,h,b,t)->{assertEquals(id,read(json,b).path("eventId").asText());return 204;},new MutableClock()).tick();
    assertEquals("DELIVERED",delivery().get("status"));assertEquals(2,((Number)delivery().get("attempts")).intValue());
  }
  @Test void parallelTicksDoNotSendSameEventTwice() throws Exception {
    create("parallel");var entered=new CountDownLatch(1);var release=new CountDownLatch(1);var calls=new AtomicInteger();
    var dispatcher=new WebhookDispatcher(db,config,(u,h,b,t)->{calls.incrementAndGet();entered.countDown();release.await(5,TimeUnit.SECONDS);return 204;},new MutableClock());
    try(var executor=Executors.newVirtualThreadPerTaskExecutor()){
      var first=executor.submit(dispatcher::tick);assertTrue(entered.await(5,TimeUnit.SECONDS));
      try{dispatcher.tick();assertEquals(1,calls.get());}finally{release.countDown();}first.get(5,TimeUnit.SECONDS);
    }
    assertEquals("DELIVERED",delivery().get("status"));
  }
  @Test void realHttpReceiverVerifiesHmacAndReceivesNoServiceToken() throws Exception {
    var received=new AtomicReference<String>();var failure=new AtomicReference<Throwable>();
    var server=HttpServer.create(new InetSocketAddress("127.0.0.1",0),0);
    server.createContext("/hook",exchange->{try{
      var raw=exchange.getRequestBody().readAllBytes();String timestamp=exchange.getRequestHeaders().getFirst("X-GHN-Service-Timestamp");
      assertTrue(OutboundWebhooks.verify(secret,timestamp,exchange.getRequestHeaders().getFirst("X-GHN-Service-Signature"),raw,Instant.now()));
      assertNull(exchange.getRequestHeaders().getFirst("Authorization"));received.set(new String(raw,StandardCharsets.UTF_8));exchange.sendResponseHeaders(204,-1);
    }catch(Throwable e){failure.set(e);}finally{exchange.close();}});
    server.start();try{
      webhook().put("url","http://127.0.0.1:"+server.getAddress().getPort()+"/hook").put("timeoutMs",1000);reconfigure();create("http");
      new WebhookDispatcher(db,config).tick();assertNull(failure.get());assertNotNull(received.get());assertEquals("DELIVERED",delivery().get("status"));
    }finally{server.stop(0);}
  }
  @Test void realStalledHttpReceiverTimesOut() throws Exception {
    var server=HttpServer.create(new InetSocketAddress("127.0.0.1",0),0);
    server.createContext("/hook",exchange->exchange.getRequestBody().readAllBytes());server.start();
    try{
      webhook().put("url","http://127.0.0.1:"+server.getAddress().getPort()+"/hook");reconfigure();create("timeout");new WebhookDispatcher(db,config).tick();
      assertEquals("NETWORK_OR_TIMEOUT",delivery().get("lastError"));assertEquals("PENDING",delivery().get("status"));
    }finally{server.stop(0);}
  }
}

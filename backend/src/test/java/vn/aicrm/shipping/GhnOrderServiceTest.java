package vn.aicrm.shipping;

import com.fasterxml.jackson.databind.ObjectMapper;
import java.math.BigDecimal;
import java.sql.Timestamp;
import java.time.Instant;
import java.util.*;
import org.junit.jupiter.api.*;
import org.springframework.http.HttpMethod;
import org.springframework.http.MediaType;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.security.core.Authentication;
import org.springframework.test.util.ReflectionTestUtils;
import org.springframework.test.web.client.MockRestServiceServer;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.SimpleTransactionStatus;
import org.springframework.web.client.RestClient;
import vn.aicrm.shared.RetailAccess;
import vn.coreplatform.kernel.ModuleRuntime;
import vn.coreplatform.permission.PermissionService;
import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.ArgumentMatchers.*;
import static org.mockito.Mockito.*;
import static org.springframework.test.web.client.match.MockRestRequestMatchers.*;
import static org.springframework.test.web.client.response.MockRestResponseCreators.*;
import static vn.coreplatform.security.SecurityConfig.sha256;

class GhnOrderServiceTest {
  final ObjectMapper json=new ObjectMapper();
  final UUID tenant=UUID.randomUUID(),order=UUID.randomUUID(),issue=UUID.randomUUID(),shop=UUID.randomUUID(),
    account=UUID.randomUUID(),quote=UUID.randomUUID(),warehouse=UUID.randomUUID(),branch=UUID.randomUUID(),
    partner=UUID.randomUUID(),line=UUID.randomUUID(),sku=UUID.randomUUID(),requestId=UUID.randomUUID();
  JdbcTemplate db; RetailAccess r; GhnOrderService service; Authentication auth;
  PlatformTransactionManager transactions; MockRestServiceServer server;
  Map<String,Object> orderRow,issueRow,shopRow,quoteRow;
  Map<String,Object> deliveryRow=new HashMap<>(),requestRow=new HashMap<>();
  final List<String> writes=new ArrayList<>();

  @BeforeEach void setup() throws Exception {
    db=mock(JdbcTemplate.class);auth=mock(Authentication.class);
    r=spy(new RetailAccess(db,mock(PermissionService.class),json,mock(ModuleRuntime.class)));
    doReturn(tenant).when(r).tenant(auth);doReturn(UUID.randomUUID()).when(r).actor(auth);
    doNothing().when(r).gate(eq(auth),anyString(),anyString());
    doNothing().when(r).customerRead(auth,partner);doReturn(Map.of()).when(r).warehouse(auth,warehouse);
    transactions=mock(PlatformTransactionManager.class);
    when(transactions.getTransaction(any())).thenAnswer(inv->new SimpleTransactionStatus());
    service=spy(new GhnOrderService(r,transactions));
    doReturn(Map.of("ok",true)).when(service).detail(auth,order);
    var builder=RestClient.builder();server=MockRestServiceServer.bindTo(builder).build();
    ReflectionTestUtils.setField(service,"http",builder.build());
    orderRow=new HashMap<>(Map.of("id",order,"status","CONFIRMED","preferred_warehouse_id",warehouse,"branch_id",branch,"partner_id",partner));
    issueRow=new HashMap<>(Map.of("id",issue,"sales_order_id",order,"type","ISSUE","status","POSTED","branch_id",branch,"warehouse_id",warehouse));
    shopRow=new HashMap<>(Map.of("id",shop,"shipping_account_id",account,"external_shop_id",123L,"environment","STAGING",
      "warehouse_id",warehouse,"branch_id",branch,"credential_ref","secret","sender_snapshot","{}","return_snapshot","{}"));
    var payload=json.readTree("""
      {"to_name":"Nguyen Van A","to_phone":"0901234567","to_address":"123 Duong A",
       "to_province_name":"Ha Noi","to_ward_name":"Phuong A",
       "weight":1000,"length":20,"width":10,"height":10,"service_type_id":2,"payment_type_id":1,
       "cod_amount":100000,"insurance_value":0,"order_value":100000,"required_note":"KHONGCHOXEMHANG",
       "items":[{"name":"San pham","code":"SP1","quantity":1}]}
      """);
    quoteRow=new HashMap<>(Map.of("id",quote,"valid",true,"request_payload",payload.toString(),"total_fee",new BigDecimal("20000"),
      "issue_id",issue,"shipping_account_id",account,"shipping_shop_id",shop,"external_shop_id",123L,"environment","STAGING"));
    doReturn(issueRow).when(r).one("document",tenant,issue);
    doReturn(Map.of("credential_ref","secret","active",true)).when(r).one("shipping_account",tenant,account);
    when(db.queryForList(anyString(),any(Object[].class))).thenAnswer(inv->{
      String sql=inv.getArgument(0);
      if(sql.contains("from retail.sales_order where"))return List.of(orderRow);
      if(sql.contains("from retail.shipping_quote"))return List.of(quoteRow);
      if(sql.contains("from retail.shipping_shop"))return List.of(shopRow);
      if(sql.contains("from retail.document where"))return List.of(issueRow);
      if(sql.contains("from retail.open_item"))return List.of(Map.of("outstanding",new BigDecimal("100000")));
      if(sql.contains("from retail.line l"))return List.of(Map.of("id",line,"sku_id",sku,"sku_active",true,
        "item_order_id",order,"base_qty",BigDecimal.ONE,"qty",BigDecimal.ONE,"ratio",BigDecimal.ONE,"unit","cai","issued_stock",BigDecimal.ONE));
      if(sql.contains("from retail.delivery")&&sql.contains("for update"))return List.of(deliveryRow);
      if(sql.contains("from retail.shipping_request")&&sql.contains("for update"))return List.of(requestRow);
      return List.of();
    });
    when(db.queryForObject(anyString(),eq(Boolean.class),any(Object[].class))).thenReturn(false);
    when(db.update(anyString(),any(Object[].class))).thenAnswer(inv->{
      String sql=inv.getArgument(0);Object[] args=Arrays.copyOfRange(inv.getArguments(),1,inv.getArguments().length);
      assertEquals(sql.chars().filter(c->c=='?').count(),args.length,"SQL argument mismatch: "+sql);
      writes.add(sql);
      if(sql.contains("insert into retail.delivery(")){
        deliveryRow.putAll(Map.of("id",args[0],"issue_id",issue,"shipping_account_id",account,"integration_status","QUEUED",
          "carrier_environment","STAGING","external_shop_id",123L,"client_order_code",args[9],"cod",new BigDecimal("100000"),"tracking",""));
        deliveryRow.put("sales_order_id",order);
      }
      if(sql.contains("insert into retail.shipping_request")){
        requestRow.putAll(Map.of("id",requestId,"attempt_count",0,"status","QUEUED","request_payload",args[5],"leased",false));
      }
      return 1;
    });
  }
  private com.fasterxml.jackson.databind.node.ObjectNode confirmation() {
    return json.createObjectNode().put("quoteId",quote.toString()).put("acceptedFee",20000).put("codAmount",100000).put("paymentTypeId",1);
  }
  @Test void createsOnlyAfterTwoDurableTransactionsAndSendsStableClientCode() {
    server.expect(requestTo("https://dev-online-gateway.ghn.vn/shiip/public-api/v2/shipping-order/create"))
      .andExpect(method(HttpMethod.POST)).andExpect(header("Token","secret")).andExpect(header("ShopId","123"))
      .andExpect(req->verify(transactions,times(2)).commit(any()))
      .andExpect(jsonPath("$.client_order_code").value(org.hamcrest.Matchers.startsWith("CRM-")))
      .andRespond(withSuccess("{\"code\":200,\"data\":{\"order_code\":\"GHN123\",\"total_fee\":20000}}",MediaType.APPLICATION_JSON));
    service.confirm(auth,order,confirmation());
    server.verify();
    assertTrue(writes.stream().anyMatch(s->s.contains("insert into retail.delivery_item")));
    assertTrue(writes.stream().anyMatch(s->s.contains("status='SUCCEEDED'")));
  }
  @Test void changedCodOrFeeNeverCreatesDelivery() {
    assertThrows(RuntimeException.class,()->service.confirm(auth,order,confirmation().put("codAmount",99999)));
    assertTrue(writes.isEmpty());server.verify();
  }
  @Test void previewValidatesCanonicalNewAddressesAndDoesNotCreateShipment() throws Exception {
    String address="{\"name\":\"Nguyen Van A\",\"phone\":\"0901234567\",\"address\":\"123 A\",\"provinceId\":1,\"wardId\":2}";
    shopRow.put("sender_snapshot",address);shopRow.put("return_snapshot",address);
    for(int i=0;i<3;i++){
      server.expect(requestTo("https://dev-online-gateway.ghn.vn/shiip/public-api/v3/master-data/province/all?offset=0&limit=200"))
        .andRespond(withSuccess("{\"code\":200,\"data\":[{\"_id\":1,\"name\":\"Tinh chuan\",\"status\":1}]}",MediaType.APPLICATION_JSON));
      server.expect(requestTo("https://dev-online-gateway.ghn.vn/shiip/public-api/v3/master-data/ward/all-by-province-id?province_id=1&offset=0&limit=200"))
        .andRespond(withSuccess("{\"code\":200,\"data\":[{\"_id\":2,\"name\":\"Phuong chuan\",\"status\":1}]}",MediaType.APPLICATION_JSON));
    }
    server.expect(requestTo("https://dev-online-gateway.ghn.vn/shiip/public-api/v2/shipping-order/preview"))
      .andExpect(jsonPath("$.is_new_to_address").value(true))
      .andExpect(jsonPath("$.to_province_name").value("Tinh chuan"))
      .andExpect(jsonPath("$.to_ward_name").value("Phuong chuan"))
      .andRespond(withSuccess("{\"code\":200,\"data\":{\"total_fee\":20000,\"fee\":{},\"expected_delivery_time\":\"2026-11-03T08:00:00Z\"}}",MediaType.APPLICATION_JSON));
    var input=json.createObjectNode().put("issueId",issue.toString()).put("shopRecordId",shop.toString())
      .put("weight",1000).put("length",20).put("width",10).put("height",10).put("serviceTypeId",2)
      .put("paymentTypeId",1).put("codAmount",100000).put("insuranceValue",0).put("requiredNote","KHONGCHOXEMHANG");
    input.set("recipient",json.readTree(address));
    input.putArray("items").addObject().put("issueLineId",line.toString()).put("quantity",1);
    service.quote(auth,order,input);server.verify();
    assertTrue(writes.stream().anyMatch(s->s.contains("insert into retail.shipping_quote")));
    assertFalse(writes.stream().anyMatch(s->s.contains("insert into retail.delivery(")));
  }
  @Test void expiredPreviewNeverCreatesDelivery() {
    quoteRow.put("valid",false);
    assertThrows(RuntimeException.class,()->service.confirm(auth,order,confirmation()));
    assertTrue(writes.isEmpty());server.verify();
  }
  @Test void salesFormPreviewReturnsFeeBeforeAnyOrderOrStockWrite() throws Exception {
    doReturn(Map.of("type","QUOTE","status","APPROVED","warehouse_id",warehouse,"branch_id",branch,"partner_id",partner,"total",new BigDecimal("100000")))
      .when(r).documentReference(auth,quote);
    doNothing().when(r).customerReady(auth,partner);
    when(db.queryForList(contains("select l.*,s.name item_name,s.code item_code from retail.line"),eq(tenant),eq(quote)))
      .thenReturn(List.of(Map.of("id",line,"item_name","San pham","item_code","SP1")));
    String address="{\"name\":\"Nguyen Van A\",\"phone\":\"0901234567\",\"address\":\"123 A\",\"provinceId\":1,\"wardId\":2}";
    shopRow.put("sender_snapshot",address);shopRow.put("return_snapshot",address);
    for(int i=0;i<3;i++){
      server.expect(requestTo("https://dev-online-gateway.ghn.vn/shiip/public-api/v3/master-data/province/all?offset=0&limit=200"))
        .andRespond(withSuccess("{\"code\":200,\"data\":[{\"_id\":1,\"name\":\"Tinh chuan\",\"status\":1}]}",MediaType.APPLICATION_JSON));
      server.expect(requestTo("https://dev-online-gateway.ghn.vn/shiip/public-api/v3/master-data/ward/all-by-province-id?province_id=1&offset=0&limit=200"))
        .andRespond(withSuccess("{\"code\":200,\"data\":[{\"_id\":2,\"name\":\"Phuong chuan\",\"status\":1}]}",MediaType.APPLICATION_JSON));
    }
    server.expect(requestTo("https://dev-online-gateway.ghn.vn/shiip/public-api/v2/shipping-order/preview"))
      .andExpect(jsonPath("$.client_order_code").value("CRM-Q-"+quote))
      .andRespond(withSuccess("{\"code\":200,\"data\":{\"total_fee\":20000,\"fee\":{\"main_service\":20000},\"expected_delivery_time\":\"2026-11-08T08:00:00Z\"}}",MediaType.APPLICATION_JSON));
    var input=json.createObjectNode().put("shopRecordId",shop.toString()).put("weight",1000).put("length",20).put("width",10).put("height",10)
      .put("serviceTypeId",2).put("paymentTypeId",1).put("codAmount",100000).put("insuranceValue",0).put("requiredNote","KHONGCHOXEMHANG");
    input.set("recipient",json.readTree(address));input.putArray("items").addObject().put("quoteLineId",line.toString()).put("quantity",1);
    var result=json.valueToTree(service.previewSalesShipping(auth,quote,input));server.verify();
    assertEquals(20000,result.path("totalFee").asInt());assertEquals(1,result.path("paymentTypeId").asInt());
    assertEquals("2026-11-08T08:00:00Z",result.path("expectedDeliveryTime").asText());
    assertFalse(result.has("request"));assertFalse(result.has("shippingAccountId"));assertTrue(writes.isEmpty());
  }
  @Test void salesFormPreviewSurfacesSafeCarrierFailureWithoutSavingAnything() {
    var input=json.createObjectNode();
    doThrow(new GhnOrderService.CarrierFailure("GHN_HTTP_400","GHN chưa hỗ trợ tuyến đã chọn",false))
      .when(service).prepareSalesRequest(auth,quote,input);
    var error=assertThrows(RuntimeException.class,()->service.previewSalesShipping(auth,quote,input));
    assertTrue(error.getMessage().contains("chưa hỗ trợ tuyến"));assertTrue(writes.isEmpty());
  }
  @Test void wrongWarehouseShopNeverCreatesDelivery() {
    shopRow.put("warehouse_id",UUID.randomUUID());
    assertThrows(RuntimeException.class,()->service.confirm(auth,order,confirmation()));
    assertTrue(writes.isEmpty());server.verify();
  }
  @Test void timeoutKeepsRequestForReconciliationInsteadOfLosingIt() {
    server.expect(anything()).andRespond(withException(new java.net.SocketTimeoutException("timeout")));
    service.confirm(auth,order,confirmation());
    verify(db).update(contains("set status=?,lease_until=null"),eq("UNKNOWN"),anyString(),anyString(),eq(tenant),eq(requestId));
    server.verify();
  }
  @Test void uncertainRetryOnlyLooksUpTheOriginalCode() {
    server.expect(anything()).andRespond(withException(new java.net.SocketTimeoutException("timeout")));
    service.confirm(auth,order,confirmation());server.verify();server.reset();
    requestRow.put("attempt_count",1);requestRow.put("status","UNKNOWN");
    deliveryRow.put("integration_status","UNKNOWN");
    String code=deliveryRow.get("client_order_code").toString();
    server.expect(requestTo("https://dev-online-gateway.ghn.vn/shiip/public-api/v2/shipping-order/detail-by-client-code?client_order_code="+code))
      .andExpect(method(HttpMethod.GET))
      .andRespond(withSuccess("{\"code\":200,\"data\":{\"order_code\":\"GHN123\",\"client_order_code\":\""+code+"\",\"shop_id\":123}}",MediaType.APPLICATION_JSON));
    service.retry(auth,order,(UUID)deliveryRow.get("id"));
    server.verify();
    assertEquals(1,writes.stream().filter(s->s.contains("insert into retail.shipping_request")).count());
  }
  @Test void concurrentRepeatOfConfirmationCannotSendTwice() {
    server.expect(anything()).andRespond(withException(new java.net.SocketTimeoutException("timeout")));
    service.confirm(auth,order,confirmation());server.verify();server.reset();
    when(db.queryForList(contains("select delivery_id from retail.shipping_request"),eq(tenant),eq(account),eq("CREATE:"+quote)))
      .thenReturn(List.of(Map.of("delivery_id",deliveryRow.get("id"))));
    requestRow.put("leased",true);
    service.confirm(auth,order,confirmation());
    server.verify();
    assertEquals(1,writes.stream().filter(s->s.contains("insert into retail.delivery(")).count());
  }
  @Test void postedDocumentWithoutMatchingStockMovementCannotShip() {
    when(db.queryForList(contains("from retail.line l"),eq(tenant),eq(issue)))
      .thenReturn(List.of(Map.of("id",line,"sku_active",true,"item_order_id",order,"base_qty",BigDecimal.ONE,"issued_stock",BigDecimal.ZERO)));
    assertThrows(RuntimeException.class,()->service.confirm(auth,order,confirmation()));
    assertTrue(writes.isEmpty());server.verify();
  }
  @Test void wrongWebhookSecretCannotInsertEvent() {
    when(db.queryForList(contains("select webhook_secret_ref"),eq(tenant),eq(account)))
      .thenReturn(List.of(Map.of("webhook_secret_ref","sha256:"+sha256("expected"))));
    assertThrows(RuntimeException.class,()->service.webhook(tenant,account,"wrong",json.createObjectNode()));
    assertTrue(writes.isEmpty());
  }
  @Test void repeatedWebhookStopsAtInboxWithoutApplyingBusinessLogic() {
    when(db.queryForList(contains("select webhook_secret_ref"),eq(tenant),eq(account)))
      .thenReturn(List.of(Map.of("webhook_secret_ref","sha256:"+sha256("expected"))));
    when(db.update(contains("insert into retail.shipping_event"),any(Object[].class))).thenReturn(0);
    var p=json.createObjectNode().put("OrderCode","GHN123").put("ShopID",123).put("Type","Switch_status")
      .put("Time",Instant.now().minusSeconds(5).toString()).put("Status","delivered");
    assertEquals(Map.of("code",200,"duplicate",true),service.webhook(tenant,account,"expected",p));
    assertTrue(writes.isEmpty());
  }
  @Test void deliveredWebhookUpdatesTrackingWithoutPostingMoneyOrStock() {
    UUID delivery=UUID.randomUUID();
    deliveryRow.putAll(Map.of("id",delivery,"sales_order_id",order,"tracking","GHN123","carrier_status","delivering"));
    doReturn(deliveryRow).when(r).one("delivery",tenant,delivery);
    when(db.queryForList(contains("select webhook_secret_ref"),eq(tenant),eq(account)))
      .thenReturn(List.of(Map.of("webhook_secret_ref","sha256:"+sha256("expected"))));
    when(db.queryForList(contains("and (tracking=?"),eq(tenant),eq(account),eq(123L),eq("GHN123"),eq(""),eq("")))
      .thenReturn(List.of(Map.of("id",delivery)));
    var p=json.createObjectNode().put("OrderCode","GHN123").put("ShopID",123).put("Type","Switch_status")
      .put("Time",Instant.now().minusSeconds(5).toString()).put("Status","delivered");
    assertEquals(Map.of("code",200,"matched",true),service.webhook(tenant,account,"expected",p));
    assertTrue(writes.stream().anyMatch(s->s.contains("set carrier_status=")));
    assertTrue(writes.stream().anyMatch(s->s.contains("set shipping_status=")));
    assertFalse(writes.stream().anyMatch(s->s.contains("retail.payment")||s.contains("retail.movement")||s.contains("retail.balance")));
  }
  @Test void separatePartialReturnEventPreventsTreatingWholeOrderAsDelivered() {
    UUID delivery=UUID.randomUUID();Timestamp time=Timestamp.from(Instant.now().minusSeconds(10));
    deliveryRow.putAll(Map.of("id",delivery,"sales_order_id",order,"tracking","GHN123","carrier_status","delivered","carrier_status_at",time));
    doReturn(deliveryRow).when(r).one("delivery",tenant,delivery);
    when(db.queryForList(contains("select webhook_secret_ref"),eq(tenant),eq(account)))
      .thenReturn(List.of(Map.of("webhook_secret_ref","sha256:"+sha256("expected"))));
    when(db.queryForList(contains("and (tracking=?"),eq(tenant),eq(account),eq(123L),eq("GHN123"),eq(""),eq("")))
      .thenReturn(List.of(Map.of("id",delivery)));
    var p=json.createObjectNode().put("OrderCode","GHN123").put("ShopID",123).put("Type","update_partial_return")
      .put("Time",time.toInstant().toString()).put("Status","delivered").put("IsPartialReturn",true);
    service.webhook(tenant,account,"expected",p);
    assertTrue(writes.stream().anyMatch(s->s.contains("carrier_partial_return=true")));
  }
  @Test void lateEventsCannotRegressSuccessButFailedAttemptCanBeRedelivered() {
    Timestamp earlier=Timestamp.from(Instant.parse("2026-01-01T01:00:00Z")),later=Timestamp.from(Instant.parse("2026-01-01T02:00:00Z"));
    assertFalse(GhnOrderService.acceptsStatus("delivering",later,"picked",earlier));
    assertFalse(GhnOrderService.acceptsStatus("delivered",earlier,"delivering",later));
    assertTrue(GhnOrderService.acceptsStatus("delivery_fail",earlier,"delivering",later));
    assertEquals("PARTIAL",GhnOrderService.deliveryState("delivered",true));
    assertEquals("FAILED",GhnOrderService.deliveryState("returned",false));
    assertNull(GhnOrderService.deliveryState("new_unknown_status",false));
  }
  @Test void carrierErrorIdentifiesPreviewAndUnsupportedRouteWithoutExposingProviderPayload() {
    String message=ReflectionTestUtils.invokeMethod(service,"carrierError",400,"/shiip/public-api/v2/shipping-order/preview",
      "{\"code_message\":\"ROUTE_NOT_FOUND_SERVICE\",\"message\":\"secret 0901234567\"}");
    assertTrue(message.contains("kiểm tra phí"));assertTrue(message.contains("chưa hỗ trợ tuyến"));
    assertFalse(message.contains("secret"));assertFalse(message.contains("0901234567"));
  }
  @Test void unrecognizedCarrierErrorNeverEchoesTokenOrCustomerDetails() {
    String message=ReflectionTestUtils.invokeMethod(service,"carrierError",400,"/shiip/public-api/v2/shipping-order/create",
      "{\"message\":\"token-secret Nguyen Van A 0901234567\"}");
    assertTrue(message.contains("tạo vận đơn"));assertFalse(message.contains("token-secret"));assertFalse(message.contains("Nguyen Van A"));
  }
}

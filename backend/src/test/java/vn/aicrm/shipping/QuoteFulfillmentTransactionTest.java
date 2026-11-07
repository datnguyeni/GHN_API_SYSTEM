package vn.aicrm.shipping;

import com.fasterxml.jackson.databind.*;
import com.fasterxml.jackson.databind.node.ObjectNode;
import java.util.*;
import java.util.function.Function;
import org.junit.jupiter.api.*;
import org.springframework.aop.framework.ProxyFactory;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.*;
import org.springframework.security.core.Authentication;
import org.springframework.transaction.annotation.AnnotationTransactionAttributeSource;
import org.springframework.transaction.interceptor.TransactionInterceptor;
import vn.aicrm.shared.*;
import vn.coreplatform.audit.AuditService;
import vn.coreplatform.eventing.OutboxService;
import vn.coreplatform.kernel.ModuleRuntime;
import vn.coreplatform.permission.PermissionService;
import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.ArgumentMatchers.*;
import static org.mockito.Mockito.*;

/** Real PostgreSQL transactions with a mocked carrier; never touches the application's live database. */
class QuoteFulfillmentTransactionTest {
  final ObjectMapper json=new ObjectMapper();
  final UUID tenant=UUID.randomUUID(),quote=UUID.randomUUID(),actor=UUID.randomUUID(),order=UUID.randomUUID(),issue=UUID.randomUUID();
  JdbcTemplate db;RetailAccess r;RetailCommands commands;GhnOrderService ghn;QuoteFulfillmentAttempts service;
  Authentication auth;OutboxService outbox;ObjectNode input;JsonNode prepared,response;Function<JsonNode,JsonNode> local;

  @BeforeEach void setup() {
    String url=System.getenv("FULFILLMENT_TX_TEST_URL");
    Assumptions.assumeTrue(url!=null,"Set FULFILLMENT_TX_TEST_URL to a disposable PostgreSQL database");
    assertTrue(url.matches("jdbc:postgresql://[^/]+/codex_fulfillment_tx_[a-z0-9_]+"),"Refuse to create test tables outside a dedicated test database");
    var ds=new DriverManagerDataSource(url,System.getenv("FULFILLMENT_TX_TEST_USER"),System.getenv("FULFILLMENT_TX_TEST_PASSWORD"));
    db=new JdbcTemplate(ds);var manager=new DataSourceTransactionManager(ds);
    db.execute("create schema if not exists retail");
    db.execute("create table if not exists retail.document(tenant_id uuid,id uuid,primary key(tenant_id,id))");
    db.execute("create table if not exists retail.command(tenant_id uuid,account_id uuid,key text,operation text,hash text,result jsonb)");
    db.execute("create table if not exists retail.tx_test_business(id serial primary key,kind text)");
    if(db.queryForObject("select to_regclass('retail.quote_fulfillment_attempt') is null",Boolean.class)) {
      try {db.execute(java.nio.file.Files.readString(java.nio.file.Path.of("src/main/resources/db/migration/V51__quote_fulfillment_attempt.sql")));}
      catch(java.io.IOException e){throw new IllegalStateException(e);}
    }
    db.execute("truncate retail.command,retail.tx_test_business,retail.quote_fulfillment_attempt,retail.document");
    db.update("insert into retail.document(tenant_id,id) values(?,?)",tenant,quote);
    auth=mock(Authentication.class);var permission=mock(PermissionService.class);
    when(permission.tenantKey(auth)).thenReturn("tx-test");when(auth.getName()).thenReturn("tx-test");
    r=spy(new RetailAccess(db,permission,json,mock(ModuleRuntime.class)));
    doReturn(tenant).when(r).tenant(auth);doReturn(actor).when(r).actor(auth);doNothing().when(r).gate(eq(auth),anyString(),anyString());
    outbox=mock(OutboxService.class);
    var target=new RetailCommands(r,mock(AuditService.class),outbox,mock(RetailPermissions.class));
    var proxy=new ProxyFactory(target);proxy.setProxyTargetClass(true);
    proxy.addAdvice(new TransactionInterceptor(manager,new AnnotationTransactionAttributeSource()));
    commands=(RetailCommands)proxy.getProxy();ghn=mock(GhnOrderService.class);
    service=new QuoteFulfillmentAttempts(r,commands,ghn,manager);
    input=json.createObjectNode().put("version",3);input.putObject("shipping").put("codAmount",100);
    prepared=json.createObjectNode().set("request",json.createObjectNode().put("client_order_code","CRM-Q-"+quote));
    response=json.createObjectNode().put("order_code","GHN123");
    when(ghn.prepareSalesRequest(eq(auth),eq(quote),any())).thenReturn(prepared);
    when(ghn.sendPreparedSales(eq(auth),any(),anyBoolean())).thenReturn(response);
    when(ghn.savePreparedSalesDelivery(eq(auth),eq(order),eq(issue),any(),any())).thenAnswer(call->{
      db.update("insert into retail.tx_test_business(kind) values('DELIVERY')");
      return Map.of("deliveries",List.of(Map.of("tracking","GHN123","integration_status","CREATED")));
    });
    local=frozen->{
      db.queryForList("select id from retail.document where tenant_id=? and id=? for update",tenant,quote);
      for(String kind:List.of("ACCEPTED","ORDER","ISSUE","AR"))db.update("insert into retail.tx_test_business(kind) values(?)",kind);
      return json.valueToTree(Map.of("orderId",order,"issueId",issue,"orderNumber","SO-TEST"));
    };
  }
  long businessRows(){return db.queryForObject("select count(*) from retail.tx_test_business",Long.class);}
  String state(){return db.queryForObject("select status from retail.quote_fulfillment_attempt where tenant_id=? and quote_id=?",String.class,tenant,quote);}
  @Test void preview400DoesNotCreateAnyBusinessRecords() {
    when(ghn.prepareSalesRequest(eq(auth),eq(quote),any())).thenThrow(new GhnOrderService.CarrierFailure("GHN_HTTP_400","Tuyến không hỗ trợ",false));
    assertThrows(RuntimeException.class,()->service.execute(auth,quote,input,local));
    assertEquals(0,businessRows());assertEquals("REJECTED",state());
    verify(ghn,never()).sendPreparedSales(any(),any(),anyBoolean());
  }
  @Test void create400RollsBackAcceptanceOrderStockArAndCommand() {
    when(ghn.sendPreparedSales(eq(auth),any(),eq(false))).thenThrow(new GhnOrderService.CarrierFailure("GHN_HTTP_400","Từ chối",false));
    assertThrows(RuntimeException.class,()->service.execute(auth,quote,input,local));
    assertEquals(0,businessRows());assertEquals("REJECTED",state());
    assertEquals(0,db.queryForObject("select count(*) from retail.command",Integer.class));
  }
  @Test void successCommitsBusinessAndCarrierResultTogether() {
    JsonNode result=json.valueToTree(service.execute(auth,quote,input,local));
    assertEquals("GHN123",result.at("/shipping/deliveries/0/tracking").asText());
    assertEquals(5,businessRows());assertEquals("COMPLETED",state());
    service.execute(auth,quote,input,local);
    assertEquals(5,businessRows());verify(ghn,times(1)).sendPreparedSales(any(),any(),anyBoolean());
  }
  @Test void unknownCarrierResultRollsBackLocallyAndRetryOnlyLooksUpStableCode() {
    when(ghn.sendPreparedSales(eq(auth),any(),eq(false))).thenThrow(new GhnOrderService.CarrierFailure("GHN_UNAVAILABLE","Timeout",true));
    assertThrows(RuntimeException.class,()->service.execute(auth,quote,input,local));
    assertEquals(0,businessRows());assertEquals("UNKNOWN",state());
    service.execute(auth,quote,input,local);
    assertEquals(5,businessRows());assertEquals("COMPLETED",state());
    verify(ghn,times(1)).sendPreparedSales(eq(auth),any(),eq(false));
    verify(ghn,times(1)).sendPreparedSales(eq(auth),any(),eq(true));
  }
  @Test void databaseFailureAfterGhnSuccessKeepsJournalAndRetryDoesNotCreateAnotherShipment() {
    doThrow(new IllegalStateException("OUTBOX_FAILED")).when(outbox).publish(anyString(),anyString(),anyString(),anyString(),any());
    assertThrows(RuntimeException.class,()->service.execute(auth,quote,input,local));
    assertEquals(0,businessRows());assertEquals("CREATED",state());
    reset(outbox);service.execute(auth,quote,input,local);
    assertEquals(5,businessRows());assertEquals("COMPLETED",state());
    verify(ghn,times(1)).sendPreparedSales(any(),any(),anyBoolean());
  }
  @Test void stockFailureNeverCallsCarrierCreate() {
    assertThrows(RuntimeException.class,()->service.execute(auth,quote,input,frozen->{
      db.update("insert into retail.tx_test_business(kind) values('ORDER')");throw new IllegalStateException("INSUFFICIENT_STOCK");
    }));
    assertEquals(0,businessRows());verify(ghn,never()).sendPreparedSales(any(),any(),anyBoolean());
  }
  @Test void unknownAttemptRejectsChangedShippingInsteadOfCreatingWithAnotherPayload() {
    when(ghn.sendPreparedSales(eq(auth),any(),eq(false))).thenThrow(new GhnOrderService.CarrierFailure("GHN_UNAVAILABLE","Timeout",true));
    assertThrows(RuntimeException.class,()->service.execute(auth,quote,input,local));
    ((ObjectNode)input.path("shipping")).put("codAmount",200);
    assertThrows(RuntimeException.class,()->service.execute(auth,quote,input,local));
    assertEquals(0,businessRows());assertEquals("UNKNOWN",state());
    verify(ghn,times(1)).sendPreparedSales(any(),any(),anyBoolean());
  }
}

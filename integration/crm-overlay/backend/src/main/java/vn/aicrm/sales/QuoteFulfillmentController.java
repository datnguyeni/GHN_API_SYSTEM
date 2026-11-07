package vn.aicrm.sales;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import java.util.*;
import org.springframework.security.core.Authentication;
import org.springframework.web.bind.annotation.*;
import vn.aicrm.shared.*;
import vn.aicrm.shipping.GhnOrderService;
import vn.aicrm.shipping.QuoteFulfillmentAttempts;
import static vn.aicrm.shared.RetailAccess.*;

/** New confirmations commit business changes only after GHN succeeds; legacy issued orders remain recoverable. */
@RestController
@RequestMapping("/api/v1/retail/quotes/{quoteId}/fulfillment")
public class QuoteFulfillmentController {
  private final RetailAccess r;
  private final RetailCommands commands;
  private final RetailDocuments documents;
  private final GhnOrderService shipping;
  private final QuoteFulfillmentAttempts attempts;

  public QuoteFulfillmentController(RetailAccess r,RetailCommands commands,RetailDocuments documents,GhnOrderService shipping,QuoteFulfillmentAttempts attempts) {
    this.r=r;this.commands=commands;this.documents=documents;this.shipping=shipping;this.attempts=attempts;
  }
  @GetMapping
  public Object state(Authentication a,@PathVariable UUID quoteId) {
    r.gate(a,"orders","CREATE");r.gate(a,"orders","RECORD_RESPONSE");
    var q=documents.document(a,quoteId);r.customerReady(a,(UUID)q.get("partner_id"));
    var posted=r.db.queryForList("select d.metadata,o.order_number from retail.document d join retail.sales_order o on o.tenant_id=d.tenant_id and o.id=d.sales_order_id where d.tenant_id=? and d.metadata->>'automaticQuoteFulfillment'=? and d.type='ISSUE' and d.status='POSTED'",r.tenant(a),quoteId.toString());
    if(posted.isEmpty())return attempts.state(a,quoteId);
    return Map.of("stockPosted",true,"orderNumber",posted.getFirst().get("order_number"),"shippingInput",r.node(posted.getFirst().get("metadata")).path("automaticShippingInput"));
  }
  @GetMapping("/shops")
  public Object shops(Authentication a,@PathVariable UUID quoteId) {return shipping.salesOptions(a,quoteId);}
  @PostMapping("/preview")
  public Object preview(Authentication a,@PathVariable UUID quoteId,@RequestBody JsonNode input) {
    if(!input.isObject())throw problem("SHIPPING_REQUIRED","Cần nhập thông tin giao GHN");
    return shipping.previewSalesShipping(a,quoteId,input);
  }
  @GetMapping("/shops/{shopId}/provinces")
  public Object provinces(Authentication a,@PathVariable UUID quoteId,@PathVariable UUID shopId) {
    return shipping.salesLocations(a,quoteId,shopId,null);
  }
  @GetMapping("/shops/{shopId}/provinces/{provinceId}/wards")
  public Object wards(Authentication a,@PathVariable UUID quoteId,@PathVariable UUID shopId,@PathVariable long provinceId) {
    return shipping.salesLocations(a,quoteId,shopId,provinceId);
  }
  @PostMapping
  public Object confirm(Authentication a,@PathVariable UUID quoteId,@RequestBody JsonNode input) {
    if(!input.isObject()||!input.path("shipping").isObject())throw problem("SHIPPING_REQUIRED","Cần nhập thông tin giao GHN");
    r.gate(a,"orders","CREATE");r.gate(a,"orders","RECORD_RESPONSE");
    var q=documents.document(a,quoteId);r.customerReady(a,(UUID)q.get("partner_id"));
    // Do not make retry/reconciliation depend on current addresses or an active shop.
    var posted=r.db.queryForList("select id from retail.document where tenant_id=? and metadata->>'automaticQuoteFulfillment'=? and type='ISSUE' and status='POSTED'",r.tenant(a),quoteId.toString());
    if(posted.isEmpty())return attempts.execute(a,quoteId,input,frozen->r.json.valueToTree(local(a,quoteId,frozen)));
    // The immutable local operation always means: accept and issue the whole approved quote once.
    // Shipping fields may be corrected on retry without posting another stock movement.
    var identity=r.json.createObjectNode().put("quoteId",quoteId.toString());
    var plan=r.json.valueToTree(commands.execute(a,"quote-fulfill-"+quoteId,"QUOTE_FULFILL",identity,()->local(a,quoteId,input)));
    UUID orderId=uuid(plan,"orderId"),issueId=uuid(plan,"issueId");
    var result=((ObjectNode)plan).deepCopy();
    try {result.set("shipping",r.json.valueToTree(shipping.sendSalesIssue(a,orderId,issueId,input.path("shipping"))));}
    catch(RuntimeException e) {
      // Keep the durable order and stock result visible even if preview/create fails.
      result.put("shippingError",e instanceof vn.coreplatform.shared.ApiExceptionHandler.ApiProblem?e.getMessage():"Chưa gửi được GHN. Thử lại xác nhận để tiếp tục gửi vận đơn đã lưu.");
    }
    return result;
  }
  private Object local(Authentication a,UUID quoteId,JsonNode input) {
    r.db.queryForList("select id from retail.document where tenant_id=? and id=? for update",r.tenant(a),quoteId);
    var q=documents.document(a,quoteId);var meta=r.node(q.get("metadata"));
    if(!"QUOTE".equals(q.get("type"))||!"APPROVED".equals(q.get("status")))throw problem("QUOTE_NOT_APPROVED","Báo giá cần được duyệt trước");
    var prior=r.db.queryForList("select id,sales_order_id from retail.document where tenant_id=? and metadata->>'automaticQuoteFulfillment'=? and type='ISSUE' and status='POSTED'",r.tenant(a),quoteId.toString());
    if(!prior.isEmpty()) {
      UUID orderId=(UUID)prior.getFirst().get("sales_order_id");
      var order=r.documentReference(a,orderId);
      return Map.of("orderId",orderId,"orderNumber",order.get("number"),"issueId",prior.getFirst().get("id"));
    }
    if(!"ACCEPTED".equals(meta.path("customerResponse").asText())) {
      if(meta.hasNonNull("responseAt"))throw problem("QUOTE_RESPONSE_EXISTS","Báo giá đã có phản hồi khách hàng");
      if(input.path("version").asInt(-1)!=((Number)q.get("version")).intValue())throw problem("VERSION_CONFLICT","Báo giá đã thay đổi; mở lại để xác nhận");
      if(!meta.hasNonNull("sentAt")) {
        r.gate(a,"orders","RECORD_SENT");
        documents.transition(a,quoteId,"record-sent",r.json.createObjectNode().put("version",((Number)q.get("version")).intValue())
          .put("channel",required(input,"channel",40)).put("recipient",required(input,"recipient",160)));
        q=documents.document(a,quoteId);
      }
      documents.transition(a,quoteId,"record-response",r.json.createObjectNode().put("version",((Number)q.get("version")).intValue())
        .put("response","ACCEPTED").put("note",text(input,"note","Sales xác nhận khách đồng ý và giao GHN")));
    }
    var orderInput=r.json.createObjectNode().put("type","SALE_ORDER").put("sourceId",quoteId.toString())
      .put("warehouseId",q.get("warehouse_id").toString()).put("partnerId",q.get("partner_id").toString());
    var lines=orderInput.putArray("lines");
    for(var line:documents.lines(a,quoteId))lines.addObject().put("sourceLineId",line.get("id").toString())
      .put("skuId",line.get("sku_id").toString()).put("qty",decimal(line.get("qty"))).put("unit",line.get("unit").toString());
    var order=r.json.valueToTree(documents.create(a,orderInput));UUID orderId=uuid(order,"id");
    UUID issueId=documents.issueAcceptedQuote(a,quoteId,orderId,input.path("shipping"));
    return Map.of("orderId",orderId,"orderNumber",order.path("number").asText(),"issueId",issueId);
  }
}

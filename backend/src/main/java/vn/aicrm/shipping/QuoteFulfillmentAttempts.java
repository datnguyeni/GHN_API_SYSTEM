package vn.aicrm.shipping;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import java.util.*;
import java.util.function.Function;
import org.springframework.http.HttpStatus;
import org.springframework.security.core.Authentication;
import org.springframework.stereotype.Service;
import org.springframework.transaction.*;
import org.springframework.transaction.support.TransactionTemplate;
import vn.aicrm.shared.*;
import static vn.aicrm.shared.RetailAccess.*;

/** A separate carrier journal survives business rollback; it never changes inventory or accounting. */
@Service
public class QuoteFulfillmentAttempts {
  private final RetailAccess r;
  private final RetailCommands commands;
  private final GhnOrderService ghn;
  private final TransactionTemplate journal;
  public QuoteFulfillmentAttempts(RetailAccess r,RetailCommands commands,GhnOrderService ghn,PlatformTransactionManager manager) {
    this.r=r;this.commands=commands;this.ghn=ghn;
    journal=new TransactionTemplate(manager);journal.setPropagationBehavior(TransactionDefinition.PROPAGATION_REQUIRES_NEW);
  }
  public Object state(Authentication a,UUID quoteId) {
    var rows=r.db.queryForList("select status,input_payload from retail.quote_fulfillment_attempt where tenant_id=? and quote_id=?",r.tenant(a),quoteId);
    if(rows.isEmpty())return Map.of("stockPosted",false);
    var row=rows.getFirst();
    return Map.of("stockPosted",false,"attemptStatus",row.get("status"),"shippingInput",r.node(row.get("input_payload")).path("shipping"));
  }
  public Object execute(Authentication a,UUID quoteId,JsonNode input,Function<JsonNode,JsonNode> localPlan) {
    r.gate(a,"orders","CREATE");r.gate(a,"orders","RECORD_RESPONSE");
    UUID tenant=r.tenant(a),lease=UUID.randomUUID();
    var attempt=claim(tenant,quoteId,input,lease);
    if("COMPLETED".equals(attempt.get("status")))return r.node(attempt.get("result_payload"));
    JsonNode frozen=r.node(attempt.get("input_payload"));
    try {
      String status=String.valueOf(attempt.get("status"));
      JsonNode prepared=r.node(attempt.get("prepared_payload"));
      if(!Set.of("CREATED","UNKNOWN").contains(status)) {
        try {
          prepared=ghn.prepareSalesRequest(a,quoteId,frozen.path("shipping"));
          savePrepared(tenant,quoteId,lease,prepared);status="PREPARED";
        } catch(GhnOrderService.CarrierFailure e) {
          failure(tenant,quoteId,lease,"REJECTED",e.getMessage());
          throw problem(e.code,e.getMessage()+" Chưa tạo đơn hoặc xuất kho.",HttpStatus.BAD_GATEWAY);
        }
      }
      final JsonNode payload=prepared;
      final String carrierStatus=status;
      final JsonNode cachedResponse=r.node(attempt.get("carrier_response"));
      var identity=r.json.createObjectNode().put("quoteId",quoteId.toString());
      return commands.execute(a,"quote-fulfill-atomic-"+quoteId,"QUOTE_FULFILL",identity,()->{
        // Acceptance, order, ISSUE, movements, AR, delivery, command, audit and outbox share this transaction.
        JsonNode plan=localPlan.apply(frozen);
        UUID orderId=uuid(plan,"orderId"),issueId=uuid(plan,"issueId");
        ghn.validatePreparedSalesIssue(a,orderId,issueId,payload);
        JsonNode response=cachedResponse;
        if(!"CREATED".equals(carrierStatus)) {
          boolean lookup="UNKNOWN".equals(carrierStatus);
          try {
            beforeSend(tenant,quoteId,lease);
            response=ghn.sendPreparedSales(a,payload,lookup);
            // Commit the carrier response independently before any local commit can fail.
            created(tenant,quoteId,lease,response);
          } catch(GhnOrderService.CarrierFailure e) {
            boolean uncertain=lookup||e.unknown;
            failure(tenant,quoteId,lease,uncertain?"UNKNOWN":"REJECTED",e.getMessage());
            throw problem(e.code,e.getMessage()+(uncertain
              ?" Đơn và xuất kho chưa được lưu. GHN có thể đã nhận yêu cầu; thử lại để đối soát cùng mã, không tạo vận đơn khác."
              :" Đơn và xuất kho đã rollback, chưa trừ tồn."),HttpStatus.BAD_GATEWAY);
          }
        }
        var result=((ObjectNode)plan).deepCopy();
        result.set("shipping",r.json.valueToTree(ghn.savePreparedSalesDelivery(a,orderId,issueId,payload,response)));
        // This update joins the business transaction. A commit failure leaves the journal at CREATED.
        int updated=r.db.update("update retail.quote_fulfillment_attempt set status='COMPLETED',result_payload=?::jsonb,lease_token=null,lease_until=null,last_error=null,updated_at=now() where tenant_id=? and quote_id=? and lease_token=?",result.toString(),tenant,quoteId,lease);
        if(updated!=1)throw problem("FULFILLMENT_LEASE_LOST","Lần xác nhận đã thay đổi; tải lại để đối soát",HttpStatus.CONFLICT);
        return result;
      });
    } finally {
      // No journal locks are held across the carrier call. Release only our own lease after commit/rollback.
      journal.executeWithoutResult(s->r.db.update("update retail.quote_fulfillment_attempt set lease_token=null,lease_until=null,updated_at=now() where tenant_id=? and quote_id=? and lease_token=?",tenant,quoteId,lease));
    }
  }
  private Map<String,Object> claim(UUID tenant,UUID quoteId,JsonNode input,UUID lease) {
    return journal.execute(s->{
      r.db.update("insert into retail.quote_fulfillment_attempt(tenant_id,quote_id,input_payload) values(?,?,?::jsonb) on conflict do nothing",tenant,quoteId,input.toString());
      var row=r.db.queryForList("select *,lease_until>now() leased from retail.quote_fulfillment_attempt where tenant_id=? and quote_id=? for update",tenant,quoteId).getFirst();
      if("COMPLETED".equals(row.get("status")))return row;
      if(Boolean.TRUE.equals(row.get("leased")))throw problem("FULFILLMENT_IN_PROGRESS","Đang xử lý xác nhận này; chờ rồi kiểm tra lại",HttpStatus.CONFLICT);
      var out=new HashMap<>(row);String status=String.valueOf(row.get("status"));
      if("CREATING".equals(status))status="UNKNOWN"; // An interrupted HTTP call may have reached GHN.
      if(Set.of("UNKNOWN","CREATED").contains(status)) {
        if(!r.node(row.get("input_payload")).path("shipping").equals(input.path("shipping")))
          throw problem("FULFILLMENT_FROZEN","GHN có thể đã tạo vận đơn. Giữ nguyên thông tin lần trước để đối soát, không đổi payload rồi tạo lại.",HttpStatus.CONFLICT);
      } else {status="NEW";out.put("input_payload",input.toString());out.put("carrier_response",null);}
      r.db.update("update retail.quote_fulfillment_attempt set status=?,input_payload=?::jsonb,lease_token=?,lease_until=now()+interval '180 seconds',updated_at=now() where tenant_id=? and quote_id=?",status,r.node(out.get("input_payload")).toString(),lease,tenant,quoteId);
      out.put("status",status);return out;
    });
  }
  private void savePrepared(UUID tenant,UUID quoteId,UUID lease,JsonNode payload) {
    journal.executeWithoutResult(s->{
      int count=r.db.update("update retail.quote_fulfillment_attempt set status='PREPARED',prepared_payload=?::jsonb,carrier_response=null,last_error=null,updated_at=now() where tenant_id=? and quote_id=? and lease_token=?",payload.toString(),tenant,quoteId,lease);
      owned(count);
    });
  }
  private void beforeSend(UUID tenant,UUID quoteId,UUID lease) {
    journal.executeWithoutResult(s->owned(r.db.update("update retail.quote_fulfillment_attempt set status='CREATING',updated_at=now() where tenant_id=? and quote_id=? and lease_token=?",tenant,quoteId,lease)));
  }
  private void created(UUID tenant,UUID quoteId,UUID lease,JsonNode response) {
    journal.executeWithoutResult(s->owned(r.db.update("update retail.quote_fulfillment_attempt set status='CREATED',carrier_response=?::jsonb,last_error=null,updated_at=now() where tenant_id=? and quote_id=? and lease_token=?",response.toString(),tenant,quoteId,lease)));
  }
  private void failure(UUID tenant,UUID quoteId,UUID lease,String status,String message) {
    journal.executeWithoutResult(s->owned(r.db.update("update retail.quote_fulfillment_attempt set status=?,last_error=?,updated_at=now() where tenant_id=? and quote_id=? and lease_token=?",status,message,tenant,quoteId,lease)));
  }
  private void owned(int count) {if(count!=1)throw problem("FULFILLMENT_LEASE_LOST","Lần xác nhận đang được đối soát ở yêu cầu khác",HttpStatus.CONFLICT);}
}

package vn.aicrm.shared;

import java.util.*;
import java.util.function.Supplier;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import com.fasterxml.jackson.databind.JsonNode;
import org.springframework.stereotype.Service;
import org.springframework.security.core.Authentication;
import org.springframework.transaction.annotation.Transactional;
import vn.coreplatform.audit.AuditService;
import vn.coreplatform.eventing.OutboxService;
import static vn.aicrm.shared.RetailAccess.*;

/** Per-tenant write serialization keeps last-item sales, numbering and payment allocation atomic for SMEs. */
@Service
public class RetailCommands {
  private final RetailPermissions granular; private final RetailAccess access; private final AuditService audit; private final OutboxService outbox;
  public RetailCommands(RetailAccess access,AuditService audit,OutboxService outbox,RetailPermissions granular){this.granular=granular;this.access=access;this.audit=audit;this.outbox=outbox;}
  @Transactional
  public Object execute(Authentication a,String key,String operation,JsonNode body,Supplier<Object> work){
    access.modules.lockForCommand();
    access.modules.require(BusinessModules.SHARED);
    granular.command(a,operation,body);
    if(key==null||!key.matches("[A-Za-z0-9._:-]{8,120}"))throw problem("IDEMPOTENCY_REQUIRED","Cần Idempotency-Key từ 8–120 ký tự");
    var t=access.tenant(a); var actor=access.actor(a);
    access.db.queryForList("select pg_advisory_xact_lock(hashtextextended(?,0))",t.toString());
    var hash=hash(body.toString());
    var old=access.db.queryForList("select * from retail.command where tenant_id=? and account_id=? and key=?",t,actor,key);
    if(!old.isEmpty()){
      var previous=old.getFirst();if(!operation.equals(previous.get("operation"))||!hash.equals(previous.get("hash")))throw problem("IDEMPOTENCY_CONFLICT","Khóa giao dịch đã được dùng cho nội dung khác",org.springframework.http.HttpStatus.CONFLICT);
      var previousResult=access.node(previous.get("result"));
      // A cached command result must not bypass a subsequent customer transfer/revocation.
      UUID cachedPartner=optional(previousResult,"partner_id");if(cachedPartner!=null)access.customerRead(a,cachedPartner);
      if(body.hasNonNull("partnerId"))access.customerRead(a,uuid(body,"partnerId"));
      if(operation.startsWith("CARE_COMPLETE_")||operation.startsWith("ASSIGNED_CARE_COMPLETE_")){UUID careId=UUID.fromString(operation.substring(operation.lastIndexOf('_')+1));access.customerReady(a,(UUID)access.one("care",t,careId).get("partner_id"));}
      return previousResult;
    }
    var result=work.get();var payload=access.json.valueToTree(result==null?Map.of("ok",true):result);
    access.db.update("insert into retail.command(tenant_id,account_id,key,operation,hash,result) values(?,?,?,?,?,?::jsonb)",t,actor,key,operation,hash,payload.toString());
    audit.record(access.permissions.tenantKey(a),actor,a.getName(),operation,"aicrm-retail",key,"SUCCESS",payload.toString());
    outbox.publish(access.permissions.tenantKey(a),"aicrm.retail.changed.v1","aicrm-retail",key,payload);
    return result==null?Map.of("ok",true):result;
  }
  public static String hash(String value){try{return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(value.getBytes(StandardCharsets.UTF_8)));}catch(Exception e){throw new IllegalStateException(e);}}
  @Transactional
  public Object export(Authentication a,String kind,Supplier<Object> work){
    access.require(a,"EXPORT");
    var result=work.get();
    int count=result instanceof Collection<?> rows?rows.size():0;
    audit.record(access.permissions.tenantKey(a),access.actor(a),a.getName(),"RETAIL_EXPORT","aicrm-retail",kind,"SUCCESS",access.json.valueToTree(Map.of("kind",kind,"rows",count)).toString());
    return result;
  }
}

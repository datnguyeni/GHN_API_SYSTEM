package vn.aicrm.shared;

import java.math.*;
import java.util.*;
import java.time.*;
import com.fasterxml.jackson.databind.*;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.security.core.Authentication;
import org.springframework.stereotype.Service;
import vn.coreplatform.permission.PermissionService;
import vn.coreplatform.shared.ApiExceptionHandler.ApiProblem;

@Service
public class RetailAccess {
  public final JdbcTemplate db;
  public final PermissionService permissions;
  public final ObjectMapper json;
  public final vn.coreplatform.kernel.ModuleRuntime modules;
  public RetailAccess(JdbcTemplate db,PermissionService permissions,ObjectMapper json,vn.coreplatform.kernel.ModuleRuntime modules) {this.modules=modules;this.db=db;this.permissions=permissions;this.json=json;}
  @org.springframework.beans.factory.annotation.Value("${core.retail.single-headquarters:true}")
  public boolean singleHeadquarters;
  public UUID headquarters(UUID tenant){return db.queryForObject("select id from retail.branch where tenant_id=? and active order by is_default desc,code,id limit 1",UUID.class,tenant);}
  public String headquartersScope(String alias,String column){return alias+"."+column+"=(select hb.id from retail.branch hb where hb.tenant_id="+alias+".tenant_id and hb.active order by hb.is_default desc,hb.code,hb.id limit 1)";}
  public UUID tenant(Authentication a){return permissions.tenant(a);}
  public UUID actor(Authentication a){return permissions.account(a);}
  public boolean isPlatformAdmin(Authentication a){return permissions.isPlatformAdmin(a);}
  public boolean inRole(Authentication a,String code){return db.queryForObject("select exists(select 1 from identity.account_role ar join identity.role rl on rl.tenant_id=ar.tenant_id and rl.id=ar.role_id where ar.tenant_id=? and ar.account_id=? and rl.code=?)",Boolean.class,tenant(a),actor(a),code);}
  public Optional<String> roleCode(UUID tenant,UUID roleId){var rows=db.queryForList("select code from identity.role where tenant_id=? and id=?",tenant,roleId);return rows.isEmpty()?Optional.empty():Optional.ofNullable((String)rows.getFirst().get("code"));}
  public boolean canSelfApprove(Authentication a){return db.queryForObject("select count(*) from identity.account u join identity.account_role ar on ar.tenant_id=u.tenant_id and ar.account_id=u.id join identity.role rl on rl.tenant_id=ar.tenant_id and rl.id=ar.role_id where u.tenant_id=? and u.id=? and lower(u.email)='admin@core.local' and u.enabled and rl.code='platform-admin'",Integer.class,tenant(a),actor(a))>0;}
  public void require(Authentication a,String action){if(!can(a,action))throw problem("PERMISSION_DENIED","Không có quyền nghiệp vụ "+action,HttpStatus.FORBIDDEN);}
  public boolean can(Authentication a,String action){return switch(action){
    case "ALL_BRANCHES" -> isPlatformAdmin(a)||granular(a,"scope","ALL_BRANCHES");
    case "COST" -> granular(a,"sensitive","VIEW_COST");
    case "READ" -> RetailPermissions.FEATURES.stream().anyMatch(f->granular(a,f.code(),"VIEW"));
    case "SELL" -> List.of("pos","orders","issue","returns","warranty","delivery").stream().anyMatch(f->granular(a,f,"CREATE"));
    case "PURCHASE" -> List.of("purchase-order","purchase-receipt","purchase-return").stream().anyMatch(f->granular(a,f,"CREATE"));
    case "STOCK" -> List.of("stock","transfer","count","issue","opening-stock").stream().anyMatch(f->granular(a,f,"VIEW"));
    case "CRM" -> granular(a,"crm","VIEW");
    case "FINANCE" -> List.of("receipt","payment","receivables","payables","commission","refund","partners").stream().anyMatch(f->granular(a,f,f.equals("partners")?"VIEW_BANK":"VIEW"));
    case "SETUP" -> RetailPermissions.FEATURES.stream().anyMatch(f->granular(a,f.code(),"CREATE")||granular(a,f.code(),"UPDATE")||granular(a,f.code(),"MANAGE"));
    case "APPROVE","EXPORT" -> RetailPermissions.FEATURES.stream().anyMatch(f->granular(a,f.code(),action));
    case "REPORT" -> RetailPermissions.FEATURES.stream().anyMatch(f->f.code().startsWith("report-")&&granular(a,f.code(),"VIEW"));
    default -> false;
  };}
  public boolean granular(Authentication a,String feature,String action){return modules.available(BusinessModules.owner(feature))&&(isPlatformAdmin(a)||permissions.decide(a,RetailPermissions.resource(feature),"VIEW",null).allowed()&&(action.equals("VIEW")||permissions.decide(a,RetailPermissions.resource(feature),action,null).allowed()));}
  public boolean granularForRole(UUID tenant,UUID roleId,String feature,String action){return modules.available(BusinessModules.owner(feature))&&permissions.decideRole(tenant,roleId,RetailPermissions.resource(feature),"VIEW",null).allowed()&&(action.equals("VIEW")||permissions.decideRole(tenant,roleId,RetailPermissions.resource(feature),action,null).allowed());}
  public void gate(Authentication a,String feature,String action){modules.require(BusinessModules.owner(feature));if(!granular(a,feature,action))throw problem("PERMISSION_DENIED","Không có quyền "+action+" tại "+feature,HttpStatus.FORBIDDEN);}
  public String documentTypes(Authentication a,String alias,String action){var types=RetailPermissions.TYPES.stream().filter(t->granular(a,RetailPermissions.feature(t),action)).map(t->"'"+t+"'").toList();return types.isEmpty()?"false":alias+".type in ("+String.join(",",types)+")";}
  public boolean all(Authentication a){return isPlatformAdmin(a)||can(a,"ALL_BRANCHES");}
  public boolean allWarehouses(Authentication a){return all(a)||(inRole(a,"sales")&&granular(a,"warehouses","VIEW"));}
  public boolean workflowManager(Authentication a){return isPlatformAdmin(a)||granular(a,"lead-workflow","APPROVE")||granular(a,"lead-workflow","ASSIGN");}
  public boolean ownerRestricted(Authentication a){return inRole(a,"sales")&&!workflowManager(a)&&!a.getAuthorities().stream().anyMatch(v->v.getAuthority().equals("ROLE_PLATFORM_ADMIN"));}
  /** Applies to every customer read path, including catalogs and report exports. */
  public String customerScope(Authentication a,String alias){
    String actor="'"+actor(a)+"'::uuid";
    if(ownerRestricted(a))return alias+".owner_id="+actor;
    String workflow="exists(select 1 from retail.customer_workflow wf where wf.tenant_id="+alias+".tenant_id and wf.partner_id="+alias+".id";
    if(workflowManager(a))return "(not "+workflow+") or "+workflow+" and ("+workflowBranchScope(a,"wf")+")))";
    // Marketing has read access to the shared customer directory, including
    // customers entered directly by Sales. Write operations remain gated by
    // their own feature/action checks.
    if(inRole(a,"marketing"))return "true";
    return "true";
  }
  public String workflowBranchScope(Authentication a,String alias){return workflowBranchScope(a,alias,"branch_id");}
  public String workflowBranchScope(Authentication a,String alias,String branchColumn){String branch=alias+"."+branchColumn;if(singleHeadquarters)return headquartersScope(alias,branchColumn);return all(a)?"true":"(exists(select 1 from retail.access_scope acl where acl.tenant_id="+alias+".tenant_id and acl.account_id='"+actor(a)+"'::uuid and acl.branch_id="+branch+") or exists(select 1 from retail.branch wb where wb.tenant_id="+alias+".tenant_id and wb.id="+branch+" and wb.manager_id='"+actor(a)+"'::uuid))";}
  public void customerRead(Authentication a,UUID partner){
    if(partner!=null&&!Boolean.TRUE.equals(db.queryForObject("select exists(select 1 from retail.partner p where p.tenant_id=? and p.id=? and ("+customerScope(a,"p")+"))",Boolean.class,tenant(a),partner)))throw problem("SCOPE_DENIED","Không có quyền tại khách hàng này",HttpStatus.FORBIDDEN);
  }
  /** Approval eligibility and current assignment are checked afresh at write time. */
  public void customerReady(Authentication a,UUID partner){
    customerRead(a,partner);if(partner==null)return;
    var rows=db.queryForList("select wf.*,p.owner_id from retail.customer_workflow wf join retail.partner p on p.tenant_id=wf.tenant_id and p.id=wf.partner_id where wf.tenant_id=? and wf.partner_id=? for update of wf,p",tenant(a),partner);
    if(rows.isEmpty())return;
    var wf=rows.getFirst();if(!Set.of("APPROVED","NOT_REQUIRED").contains(wf.get("approval"))||wf.get("owner_id")==null)throw problem("CUSTOMER_NOT_READY","Khách hàng chưa đủ điều kiện duyệt và phân công");
    if(!workflowManager(a)&&!Objects.equals(wf.get("owner_id"),actor(a)))throw problem("SCOPE_DENIED","Chỉ Sales đang phụ trách được thao tác",HttpStatus.FORBIDDEN);
  }
  public List<Map<String,Object>> warehouses(Authentication a){
    if(singleHeadquarters)return db.queryForList("select w.* from retail.warehouse w where w.tenant_id=? and w.active and "+headquartersScope("w","branch_id")+" order by w.is_default desc,w.code",tenant(a));
    return db.queryForList("select w.* from retail.warehouse w where w.tenant_id=? and (? or exists(select 1 from retail.access_scope acl where acl.account_id=? and acl.warehouse_id=w.id and acl.tenant_id=w.tenant_id)) order by (select b.is_default from retail.branch b where b.tenant_id=w.tenant_id and b.id=w.branch_id) desc,w.is_default desc,w.code",tenant(a),allWarehouses(a),actor(a));
  }
  public Map<String,Object> warehouse(Authentication a,UUID id){
    return warehouses(a).stream().filter(w->id.equals(w.get("id"))).findFirst().orElseThrow(()->problem("SCOPE_DENIED","Không có quyền tại kho này",HttpStatus.FORBIDDEN));
  }
  public void branch(Authentication a,UUID id){if(singleHeadquarters){if(!Objects.equals(id,headquarters(tenant(a))))throw problem("SCOPE_DENIED","Hệ thống sử dụng Trụ sở chính",HttpStatus.FORBIDDEN);return;}if(!all(a)&&db.queryForObject("select count(*) from retail.access_scope where tenant_id=? and account_id=? and branch_id=?",Integer.class,tenant(a),actor(a),id)==0)throw problem("SCOPE_DENIED","Không có quyền tại chi nhánh này",HttpStatus.FORBIDDEN);}
  public void syncPartnerOwner(UUID tenant,UUID partner,UUID owner){
    if(partner==null||owner==null)return;
    if(Boolean.TRUE.equals(db.queryForObject("select exists(select 1 from retail.customer_workflow where tenant_id=? and partner_id=?)",Boolean.class,tenant,partner))){
      if(!Objects.equals(one("partner",tenant,partner).get("owner_id"),owner))throw problem("WORKFLOW_REQUIRED","Chỉ được đổi Sales tại luồng phân công CRM");return;
    }
    db.update("update retail.partner set owner_id=?,updated_at=now() where tenant_id=? and id=? and owner_id is distinct from ?",owner,tenant,partner,owner);
  }
  public String scope(Authentication a,String alias){if(singleHeadquarters)return "exists(select 1 from retail.warehouse hw where hw.tenant_id="+alias+".tenant_id and hw.id="+alias+".warehouse_id and "+headquartersScope("hw","branch_id")+")";return all(a)?"true":"exists(select 1 from retail.access_scope acl where acl.tenant_id="+alias+".tenant_id and acl.account_id='"+actor(a)+"'::uuid and acl.warehouse_id="+alias+".warehouse_id)";}
  public String salesDocumentScope(Authentication a,String alias){return !ownerRestricted(a)?"("+alias+".type not in ('QUOTE','SALE_ORDER','POS','ISSUE','SALE_RETURN') or "+alias+".partner_id is null or exists(select 1 from retail.partner cp where cp.tenant_id="+alias+".tenant_id and cp.id="+alias+".partner_id and ("+customerScope(a,"cp")+")))":"("+alias+".type not in ('QUOTE','SALE_ORDER','POS','ISSUE','SALE_RETURN') or ("+alias+".partner_id is null and "+alias+".creator_id='"+actor(a)+"'::uuid) or exists(select 1 from retail.partner cp where cp.tenant_id="+alias+".tenant_id and cp.id="+alias+".partner_id and cp.owner_id='"+actor(a)+"'::uuid))";}
  public String documentScope(Authentication a,String alias){return "("+salesDocumentScope(a,alias)+") and ("+scope(a,alias)+" or ("+alias+".type='TRANSFER' and exists(select 1 from retail.access_scope acl where acl.tenant_id="+alias+".tenant_id and acl.account_id='"+actor(a)+"'::uuid and acl.warehouse_id="+alias+".destination_id)))";}
  public String branchScope(Authentication a,String alias){if(singleHeadquarters)return headquartersScope(alias,"branch_id");return all(a)?"true":"exists(select 1 from retail.access_scope acl where acl.tenant_id="+alias+".tenant_id and acl.account_id='"+actor(a)+"'::uuid and acl.branch_id="+alias+".branch_id)";}
  public Map<String,Object> one(String table,UUID tenant,UUID id){
    var rows=db.queryForList("select * from retail."+table+" where tenant_id=? and id=?",tenant,id);
    if(rows.isEmpty())throw problem("NOT_FOUND","Không tìm thấy dữ liệu",HttpStatus.NOT_FOUND);return rows.getFirst();
  }
  /** Read-only compatibility projection; callers still enforce feature/customer/warehouse scope. */
  public Map<String,Object> documentReference(Authentication a,UUID id){
    var rows=db.queryForList("select * from retail.document where tenant_id=? and id=?",tenant(a),id);
    if(!rows.isEmpty())return rows.getFirst();
    rows=db.queryForList("select * from ("+RetailSalesOrders.DOCUMENT_SELECT+") d where tenant_id=? and id=?",tenant(a),id);
    if(rows.isEmpty())throw problem("NOT_FOUND","Không tìm thấy chứng từ hoặc đơn bán",HttpStatus.NOT_FOUND);
    return rows.getFirst();
  }
  public static ApiProblem problem(String code,String text){return problem(code,text,HttpStatus.UNPROCESSABLE_ENTITY);}
  public static ApiProblem problem(String code,String text,HttpStatus status){return new ApiProblem(status,code,text);}
  public static ApiProblem problem(String code,String text,HttpStatus status,Map<String,Object> extra){return new ApiProblem(status,code,text,extra);}
  public static String text(JsonNode n,String key,String fallback){return n.path(key).isNull()?fallback:n.path(key).asText(fallback).trim();}
  public static String required(JsonNode n,String key,int max){var v=text(n,key,"");if(v.isBlank()||v.length()>max)throw problem("INVALID_FIELD","Trường "+key+" bắt buộc, tối đa "+max+" ký tự");return v;}
  public static UUID uuid(JsonNode n,String key){try{return UUID.fromString(required(n,key,36));}catch(IllegalArgumentException e){throw problem("INVALID_ID","Mã tham chiếu "+key+" không hợp lệ");}}
  public static UUID optional(JsonNode n,String key){return text(n,key,"").isBlank()?null:uuid(n,key);}
  public static BigDecimal num(JsonNode n,String key,BigDecimal fallback){try{var raw=n.path(key);var v=raw.isMissingNode()||raw.isNull()||raw.asText().isBlank()?fallback:new BigDecimal(raw.asText());if(v.stripTrailingZeros().precision()>20||v.stripTrailingZeros().scale()>8)throw new NumberFormatException();return v;}catch(Exception e){throw problem("INVALID_NUMBER","Số "+key+" không hợp lệ");}}
  public static BigDecimal decimal(Object value){return value==null?BigDecimal.ZERO:new BigDecimal(value.toString());}
  public static BigDecimal money(BigDecimal v){return v.setScale(0,RoundingMode.HALF_UP);}
  public static BigDecimal quantity(BigDecimal v){if(v.stripTrailingZeros().scale()>4||v.signum()<0)throw problem("INVALID_QUANTITY","Số lượng tối đa 4 chữ số thập phân, không âm");return v.setScale(4);}
  public static BigDecimal positive(JsonNode n,String key){var v=quantity(num(n,key,BigDecimal.ZERO));if(v.signum()<=0)throw problem("INVALID_QUANTITY","Số lượng phải lớn hơn 0");return v;}
  public static LocalDate date(JsonNode n,String key){try{return LocalDate.parse(required(n,key,10));}catch(Exception e){throw problem("INVALID_DATE","Ngày "+key+" không hợp lệ");}}
  public static LocalDate today(){return LocalDate.now(ZoneId.of("Asia/Ho_Chi_Minh"));}
  public JsonNode node(Object value){if(value==null)return json.createObjectNode();try{return json.readTree(value.toString());}catch(Exception e){throw new IllegalStateException(e);}}
  public Map<String,Object> clean(Map<String,Object> row){var m=new LinkedHashMap<>(row); for(var k:List.of("roles","units","metadata","sku_snapshot","serials","segments","rule_snapshot","rows","errors","result","details","count_lots"))if(m.get(k)!=null)m.put(k,node(m.get(k)));return m;}
}



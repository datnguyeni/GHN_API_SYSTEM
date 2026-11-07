package vn.aicrm.shared;

import java.util.*;
import com.fasterxml.jackson.databind.JsonNode;
import org.springframework.stereotype.Service;
import org.springframework.security.core.Authentication;
import org.springframework.http.HttpStatus;
import static vn.aicrm.shared.RetailAccess.*;

/** Granular permissions. Legacy flags are derived capabilities, never authorization fallback. */
@Service
public class RetailPermissions implements vn.coreplatform.kernel.NavigationCapabilityProvider {
  /**
   * Marketing navigation is a discovery contract only.  It does not grant a
   * capability: every API continues to authorize its own feature and action.
   */
  private static final Set<String> MARKETING_VISIBLE_SCREENS=Set.of(
    "customers","leads","opportunities","customer-care","scope",
    "quotes","master-customers","master-partners");
  private static final Set<String> SALES_READ_ONLY_ACCOUNTING_FEATURES=Set.of(
    "receipt","payment","receivables","payables","commission","refund","opening-ar","opening-ap");
  public boolean supports(String resource){return resource.startsWith("aicrm-menu-");}
  public boolean canRender(Authentication a,String resource,String action){
    String screen=resource.substring(11);
    if(r.inRole(a,"marketing")&&"pos".equals(screen))return false;
    if("contracts".equals(screen))return !r.inRole(a,"marketing")&&r.modules.available(BusinessModules.ACCOUNTING);
    if(r.inRole(a,"marketing")&&MARKETING_VISIBLE_SCREENS.contains(screen))return true;
    if (isCrmRole(a) && isCrmScreen(screen)) return crmRoleAllows(a, screen) && screen(a,screen);
    if ("sales-customers".equals(screen)) return !isCrmRole(a) && screen(a,screen);
    return screen(a,screen);
  }
  public boolean canRenderForRole(UUID tenant,UUID roleId,String resource,String action){
    String screen=resource.substring(11);
    if(roleHasCode(tenant,roleId,"marketing")&&"pos".equals(screen))return false;
    if("contracts".equals(screen))return !roleHasCode(tenant,roleId,"marketing")&&r.modules.available(BusinessModules.ACCOUNTING);
    if(roleHasCode(tenant,roleId,"marketing")&&MARKETING_VISIBLE_SCREENS.contains(screen))return true;
    if (isCrmRole(tenant, roleId) && isCrmScreen(screen)) return crmRoleAllows(tenant, roleId, screen) && screenForRole(tenant,roleId,screen);
    if ("sales-customers".equals(screen)) return !isCrmRole(tenant,roleId) && screenForRole(tenant,roleId,screen);
    return screenForRole(tenant,roleId,screen);
  }
  private boolean isCrmRole(Authentication a){return r.inRole(a,"marketing")||r.inRole(a,"manager")||r.inRole(a,"sales");}
  private boolean isCrmScreen(String screen){return Set.of("customers","leads","opportunities","customer-care").contains(screen);}
  private boolean crmRoleAllows(Authentication a,String screen){
    if(r.inRole(a,"marketing")) return Set.of("customers","leads").contains(screen);
    if(r.inRole(a,"manager")) return Set.of("customers","leads","opportunities","customer-care").contains(screen);
    if(r.inRole(a,"sales")) return Set.of("leads","opportunities","customer-care").contains(screen);
    return true;
  }
  private boolean isCrmRole(UUID tenant,UUID roleId){return roleHasCode(tenant,roleId,"marketing")||roleHasCode(tenant,roleId,"manager")||roleHasCode(tenant,roleId,"sales");}
  private boolean crmRoleAllows(UUID tenant,UUID roleId,String screen){
    if(roleHasCode(tenant,roleId,"marketing")) return Set.of("customers","leads").contains(screen);
    if(roleHasCode(tenant,roleId,"manager")) return Set.of("customers","leads","opportunities","customer-care").contains(screen);
    if(roleHasCode(tenant,roleId,"sales")) return Set.of("leads","opportunities","customer-care").contains(screen);
    return true;
  }
  private boolean roleHasCode(UUID tenant,UUID roleId,String code){return r.roleCode(tenant,roleId).map(code::equals).orElse(false);}
  public record Feature(String code,String module,String name,List<String> actions) {}
  private static Feature f(String code,String module,String name,String actions){return new Feature(code,module,name,List.of(actions.split(",")));}
  public static final List<Feature> FEATURES=List.of(
    f("epc-projects","CRM","Triển khai dự án EPC","VIEW,VIEW_ALL,CREATE,UPDATE,ASSIGN,ACCEPT,RECORD_DEPOSIT,APPROVE_EXCEPTION,PLAN_MATERIAL,ISSUE_MATERIAL,COMPLETE"),
    f("locations","Vận hành chung","Địa điểm / Chi nhánh","VIEW,CREATE,UPDATE,DEACTIVATE,EXPORT"),
    f("warehouses","Kho","Danh sách kho","VIEW,CREATE,UPDATE,DEACTIVATE,EXPORT,DELETE"),
    f("pos","Bán hàng","Bán tại quầy","VIEW,CREATE,SUBMIT,COLLECT_POS,REQUEST_CANCEL,APPROVE_CANCEL,PRINT,EXPORT"),
    f("orders","Bán hàng","Báo giá / Đơn bán","VIEW,CREATE,UPDATE,SUBMIT,APPROVE,REJECT,RETURN_FOR_EDIT,QUOTE_CONFIRM_STOCK,RECORD_SENT,RECORD_RESPONSE,REQUEST_CANCEL,APPROVE_CANCEL,PRINT,EXPORT"),
    f("issue","Kho","Xuất bán","VIEW,CREATE,SUBMIT,APPROVE,REJECT,REQUEST_CANCEL,APPROVE_CANCEL,PRINT,EXPORT"),
    f("delivery","Bán hàng","Giao hàng","VIEW,CREATE,UPDATE,SETTLE,EXPORT"),
    f("purchase-order","Mua hàng","Đề nghị / Đơn mua","VIEW,CREATE,SUBMIT,APPROVE,REJECT,REQUEST_CANCEL,APPROVE_CANCEL,PRINT,EXPORT"),
    f("purchase-receipt","Mua hàng","Nhập mua","VIEW,CREATE,SUBMIT,APPROVE,REJECT,CONFIRM_DISCREPANCY,REQUEST_CANCEL,APPROVE_CANCEL,PRINT,EXPORT"),
    f("purchase-return","Mua hàng","Trả mua","VIEW,CREATE,SUBMIT,APPROVE,REJECT,REQUEST_CANCEL,APPROVE_CANCEL,PRINT,EXPORT"),
    f("stock","Kho","Kho & Tồn / Nhập xuất khác","VIEW,CREATE,SUBMIT,APPROVE,REJECT,RECEIVE,DISPATCH,REQUEST_CANCEL,APPROVE_CANCEL,PRINT,EXPORT,DELETE"),
    f("count","Kho","Kiểm kê","VIEW,CREATE,UPDATE,SUBMIT,APPROVE,REJECT,REQUEST_CANCEL,APPROVE_CANCEL,EXPORT"),
    f("transfer","Kho","Chuyển kho","VIEW,CREATE,SUBMIT,APPROVE,REJECT,DISPATCH,RECEIVE,CONFIRM_DISCREPANCY,REQUEST_CANCEL,APPROVE_CANCEL,PRINT,EXPORT"),
    f("warehouse-config","Kho","Cấu hình kho","VIEW,UPDATE"),
    f("products","Sản phẩm","Danh sách sản phẩm","VIEW,CREATE,UPDATE,DEACTIVATE,VIEW_PRICE,UPDATE_PRICE,IMPORT,EXPORT,DELETE"),
    f("product-groups","Sản phẩm","Nhóm sản phẩm","VIEW,CREATE,UPDATE,DEACTIVATE"),
    f("product-brands","Sản phẩm","Thương hiệu","VIEW,CREATE,UPDATE,DEACTIVATE"),
    f("product-units","Sản phẩm","Đơn vị tính","VIEW,CREATE,UPDATE,DEACTIVATE"),
    f("uom-conversions","Sản phẩm","Quy đổi đơn vị tính","VIEW,CREATE,UPDATE,DEACTIVATE"),
    f("product-attributes","Sản phẩm","Thuộc tính / Biến thể","VIEW,CREATE,UPDATE,DEACTIVATE"),
    f("customer","Khách hàng / Đối tác","Khách hàng dùng chung","VIEW,CREATE,UPDATE,DEACTIVATE,IMPORT,EXPORT"),
    f("supplier","Mua hàng","Nhà cung cấp dùng chung","VIEW,CREATE,UPDATE,DEACTIVATE,IMPORT,EXPORT"),
    f("partners","Khách hàng / Đối tác","Đối tác / Vai trò","VIEW,CREATE,UPDATE,MANAGE_ROLES,DEACTIVATE,VIEW_BANK,UPDATE_BANK,IMPORT,EXPORT"),
    f("leads","CRM","Khách hàng tiềm năng","VIEW,CREATE,UPDATE,CONVERT,IMPORT"),
    f("lead-workflow","CRM","Duyệt và phân công khách hàng tiềm năng","VIEW,CREATE,UPDATE,IMPORT,APPROVE,ASSIGN"),
    f("opportunities","CRM","Khách hàng cơ hội","VIEW,CREATE,UPDATE"),
    f("crm","CRM","Tư vấn khách hàng","VIEW,CREATE,UPDATE,COMPLETE,VIEW_HISTORY,EXPORT"),
    f("receipt","Kế toán","Phiếu thu","VIEW,CREATE,ALLOCATE,PRINT,EXPORT"),
    f("payment","Kế toán","Phiếu chi","VIEW,CREATE,ALLOCATE,PRINT,EXPORT"),
    f("receivables","Kế toán","Phải thu","VIEW,ALLOCATE,EXPORT"),
    f("payables","Kế toán","Phải trả","VIEW,ALLOCATE,EXPORT"),
    f("opening-stock","Vận hành chung","Tồn đầu kỳ","VIEW,CREATE,SUBMIT,APPROVE,REJECT,IMPORT,REQUEST_CANCEL,APPROVE_CANCEL,EXPORT"),
    f("opening-ar","Kế toán","Phải thu đầu kỳ","VIEW,CREATE,SUBMIT,APPROVE,REJECT,IMPORT,REQUEST_CANCEL,APPROVE_CANCEL,EXPORT"),
    f("opening-ap","Kế toán","Phải trả đầu kỳ","VIEW,CREATE,SUBMIT,APPROVE,REJECT,IMPORT,REQUEST_CANCEL,APPROVE_CANCEL,EXPORT"),
    f("commission","Kế toán","Hoa hồng","VIEW,CREATE,EXPORT"),
    f("returns","Vận hành chung","Trả hàng","VIEW,CREATE,SUBMIT,APPROVE,REJECT,RECEIVE,LOOKUP_ORIGINAL,REQUEST_CANCEL,APPROVE_CANCEL,EXPORT"),
    f("warranty","Vận hành chung","Bảo hành","VIEW,CREATE,UPDATE,LOOKUP_ORIGINAL,EXPORT"),
    f("refund","Kế toán","Hoàn tiền","VIEW,CREATE,SUBMIT,APPROVE,REJECT,REQUEST_CANCEL,APPROVE_CANCEL,EXPORT"),
    f("setup","Vận hành chung","Thiết lập / Chi nhánh kho","VIEW,CREATE,UPDATE,DEACTIVATE"),
    f("scope","Quản trị hệ thống","Phạm vi chi nhánh / kho","VIEW,MANAGE,ALL_BRANCHES"),
    f("sensitive","Kế toán","Giá vốn / Lợi nhuận","VIEW,VIEW_COST,VIEW_PROFIT"),
    f("overview-sales","Tổng quan","Bán hàng","VIEW"),f("overview-purchase","Tổng quan","Mua hàng","VIEW"),f("overview-stock","Tổng quan","Kho","VIEW"),f("overview-products","Tổng quan","Sản phẩm","VIEW"),f("overview-crm","Tổng quan","CRM","VIEW"),f("overview-finance","Tổng quan","Kế toán","VIEW"),
    f("report-sales","Báo cáo","Bán hàng","VIEW,EXPORT"),f("report-purchase","Báo cáo","Mua hàng","VIEW,EXPORT"),f("report-stock","Báo cáo","Kho","VIEW,EXPORT"),f("report-products","Báo cáo","Sản phẩm","VIEW,EXPORT"),f("report-crm","Báo cáo","CRM","VIEW,EXPORT"),f("report-finance","Báo cáo","Kế toán","VIEW,EXPORT"));
  private final RetailAccess r;
  public RetailPermissions(RetailAccess r){this.r=r;}
    public static List<String> screenFeatures(String screen){return switch(screen){case "overview"->FEATURES.stream().map(Feature::code).filter(c->c.startsWith("overview-")).toList();case "reports"->FEATURES.stream().map(Feature::code).filter(c->c.startsWith("report-")).toList();case "approvals"->List.of("orders","purchase-order","purchase-receipt","purchase-return","issue","stock","count","transfer","returns","refund","opening-stock","opening-ar","opening-ap");case "purchase"->List.of("purchase-order","purchase-receipt","purchase-return");case "stock"->List.of("stock","count","opening-stock","issue");case "cashflow"->List.of("receipt","payment","commission","refund");case "debt"->List.of("receivables","payables");case "returns"->List.of("returns","warranty");case "customers"->List.of("crm");case "customer-care"->List.of("crm");case "quotes","sales-quotes","contracts"->List.of("orders");case "suppliers"->List.of("supplier");case "sales-customers"->List.of("customer");case "master-customers"->List.of("customer");case "master-partners"->List.of("partners");case "shipping"->List.of("delivery");default->List.of(screen);};}
    public boolean screen(Authentication a,String screen){if("contracts".equals(screen))return !r.inRole(a,"marketing")&&r.modules.available(BusinessModules.ACCOUNTING);if(!r.modules.available(BusinessModules.screenOwner(screen)))return false;if("shipping".equals(screen))return r.inRole(a,"ceo")||r.isPlatformAdmin(a)||can(a,"delivery","VIEW");return screenFeatures(screen).stream().anyMatch(f->can(a,f,screen.equals("approvals")?"APPROVE":"VIEW"));}
    public boolean screenForRole(UUID tenant,UUID roleId,String screen){if("contracts".equals(screen))return !roleHasCode(tenant,roleId,"marketing")&&r.modules.available(BusinessModules.ACCOUNTING);if(!r.modules.available(BusinessModules.screenOwner(screen)))return false;if("shipping".equals(screen)){String code=r.roleCode(tenant,roleId).orElse("");return "ceo".equals(code)||"platform-admin".equals(code)||r.granularForRole(tenant,roleId,"delivery","VIEW");}return screenFeatures(screen).stream().anyMatch(f->r.granularForRole(tenant,roleId,f,screen.equals("approvals")?"APPROVE":"VIEW"));}
  public static String resource(String feature){return "aicrm-"+feature;}
  public static String feature(String type){return switch(type){case "POS"->"pos";case "QUOTE","SALE_ORDER"->"orders";case "ISSUE"->"issue";case "PURCHASE_REQUEST","PURCHASE_ORDER"->"purchase-order";case "PURCHASE_RECEIPT"->"purchase-receipt";case "PURCHASE_RETURN"->"purchase-return";case "TRANSFER"->"transfer";case "COUNT"->"count";case "OTHER_RECEIPT","OTHER_ISSUE"->"stock";case "OPENING_STOCK"->"opening-stock";case "OPENING_AR"->"opening-ar";case "OPENING_AP"->"opening-ap";case "SALE_RETURN"->"returns";case "REFUND"->"refund";default->throw problem("INVALID_DOCUMENT_TYPE","Loại chứng từ không hợp lệ");};}
  public boolean can(Authentication a,String feature,String action){if(r.inRole(a,"sales")&&SALES_READ_ONLY_ACCOUNTING_FEATURES.contains(feature)&&!"VIEW".equals(action))return false;return r.granular(a,feature,action);}
  public void require(Authentication a,String feature,String action){if(r.inRole(a,"sales")&&SALES_READ_ONLY_ACCOUNTING_FEATURES.contains(feature)&&!"VIEW".equals(action))throw problem("PERMISSION_DENIED","Sales chỉ được xem dữ liệu kế toán",HttpStatus.FORBIDDEN);r.gate(a,feature,action);}
  public boolean any(Authentication a,String action){return FEATURES.stream().anyMatch(f->f.actions.contains(action)&&can(a,f.code,action));}
  public Map<String,List<String>> capabilities(Authentication a){var result=new LinkedHashMap<String,List<String>>();for(var f:FEATURES){var actions=f.actions.stream().filter(action->can(a,f.code,action)).toList();if(r.inRole(a,"sales")&&SALES_READ_ONLY_ACCOUNTING_FEATURES.contains(f.code))actions=actions.stream().filter("VIEW"::equals).toList();result.put(f.code,actions);}result.put("$modules",BusinessModules.ALL.stream().filter(r.modules::available).toList());if(r.inRole(a,"marketing")){result.put("$visibleScreens",List.copyOf(MARKETING_VISIBLE_SCREENS));result.put("$hiddenScreens",List.of("pos","contracts"));}else if(r.inRole(a,"sales")&&r.modules.available(BusinessModules.ACCOUNTING)){result.put("$visibleScreens",List.of("contracts","cashflow","debt"));}else if(r.modules.available(BusinessModules.ACCOUNTING)){result.put("$visibleScreens",List.of("contracts"));}return result;}
  public static final List<String> TYPES=List.of("QUOTE","SALE_ORDER","POS","ISSUE","PURCHASE_REQUEST","PURCHASE_ORDER","PURCHASE_RECEIPT","PURCHASE_RETURN","SALE_RETURN","TRANSFER","COUNT","OTHER_RECEIPT","OTHER_ISSUE","REFUND","OPENING_STOCK","OPENING_AR","OPENING_AP");
  public String documentFilter(Authentication a,String alias,String action){var allowed=TYPES.stream().filter(t->can(a,feature(t),action)).map(t->"'"+t+"'").toList();return allowed.isEmpty()?"false":alias+".type in ("+String.join(",",allowed)+")";}
  public String partnerFeature(String role){return switch(role){case "CUSTOMER"->"customer";case "SUPPLIER"->"supplier";default->"partners";};}
  public String configFeature(String kind){return switch(kind){case "INVENTORY"->"warehouse-config";case "UNIT"->"product-units";case "GROUP"->"product-groups";case "BRAND"->"product-brands";case "VARIANT","ATTRIBUTE"->"product-attributes";default->throw problem("INVALID_CONFIG","Cấu hình không hợp lệ");};}
  public String catalogFeature(String kind){return switch(kind){case "skus"->"products";case "price-rules","promotions"->"products";case "branches"->"locations";case "warehouses"->"warehouses";case "settings"->"setup";case "scopes"->"scope";case "partners"->"partners";default->throw problem("INVALID_CATALOG","Danh mục không hợp lệ");};}
  public void partnerWrite(Authentication a,UUID id,JsonNode x){
    var old=id==null?null:r.one("partner",r.tenant(a),id);var roles=x.path("roles");if(!roles.isObject())roles=r.json.createObjectNode().put(text(x,"kind","CUSTOMER"),true);
    if(id==null && r.inRole(a,"marketing") && roles.path("CUSTOMER").asBoolean() && !roles.path("SUPPLIER").asBoolean() && !roles.path("COLLABORATOR").asBoolean()){require(a,"lead-workflow","CREATE");return;}
    var prior=old==null?r.json.createObjectNode():r.node(old.get("roles"));
    boolean permitted=false;
    for(String role:List.of("CUSTOMER","SUPPLIER","COLLABORATOR"))if(roles.path(role).asBoolean()||prior.path(role).asBoolean()){
      String f=partnerFeature(role);
      if(can(a,f,id==null?"CREATE":"UPDATE"))permitted=true;
      if(id!=null && roles.has(role) && roles.path(role).asBoolean()!=prior.path(role).asBoolean())require(a,"partners","MANAGE_ROLES");
      if(id==null&&roles.path(role).asBoolean())require(a,f,"CREATE");
    }
    if(!permitted)throw problem("PERMISSION_DENIED","Không có quyền sửa hồ sơ đối tác",HttpStatus.FORBIDDEN);
    if(x.has("bankName")||x.has("bankAccount")||x.has("bankHolder"))require(a,"partners","UPDATE_BANK");
    if(old!=null && x.has("active") && !x.path("active").asBoolean())require(a,"partners","DEACTIVATE");
  }
  public void command(Authentication a,String op,JsonNode x){
    if(op.startsWith("CRM_LEAD_START_CARE_")){require(a,"leads","CONVERT");require(a,"crm","CREATE");return;}
    if(op.startsWith("CRM_LEAD_")){require(a,"leads",op.startsWith("CRM_LEAD_CONVERT_")?"CONVERT":op.equals("CRM_LEAD_CREATE")?"CREATE":"UPDATE");return;}
    if(op.startsWith("CRM_EPC_")){require(a,"opportunities",op.equals("CRM_EPC_CREATE")?"CREATE":"UPDATE");return;}
    if(op.startsWith("CRM_OPPORTUNITY_")){require(a,"opportunities",op.equals("CRM_OPPORTUNITY_CREATE")?"CREATE":"UPDATE");return;}
    if(op.equals("ONBOARDING")){require(a,"setup","UPDATE");return;}
    if(op.startsWith("WAREHOUSE_DELETE_")){require(a,"warehouses","DELETE");return;}
    if(op.startsWith("LOCATION_CREATE_")||op.startsWith("LOCATION_UPDATE_")){var kind=op.substring(op.lastIndexOf('_')+1);if(!Set.of("branches","warehouses").contains(kind))throw problem("INVALID_CATALOG","Danh mục không hợp lệ");require(a,kind.equals("branches")?"locations":"warehouses",op.startsWith("LOCATION_CREATE_")?"CREATE":"UPDATE");return;}
    if(x.hasNonNull("warehouseId"))r.warehouse(a,uuid(x,"warehouseId"));if(x.hasNonNull("branchId"))r.branch(a,uuid(x,"branchId"));
    if(op.startsWith("CUSTOMER_WORKFLOW_")){customerWorkflowCommand(a,op);return;}
    if(op.equals("QUOTE_FULFILL")){require(a,"orders","CREATE");require(a,"orders","RECORD_RESPONSE");return;}
    if(op.equals("DOCUMENT_CREATE")){String f=feature(required(x,"type",30));require(a,f,"CREATE");if(num(x,"paid",java.math.BigDecimal.ZERO).signum()>0)require(a,f.equals("pos")?"pos":"payment",f.equals("pos")?"COLLECT_POS":"CREATE");return;}
    if(op.startsWith("DOCUMENT_")){int last=op.lastIndexOf('_');var d=r.documentReference(a,UUID.fromString(op.substring(last+1)));String action=op.substring(9,last);r.warehouse(a,(UUID)d.get(action.equals("receive")?"destination_id":"warehouse_id"));String f=feature(d.get("type").toString());String p=switch(action){case "approve"->"APPROVE";case "reject"->"REJECT";case "return-for-edit"->"RETURN_FOR_EDIT";case "confirm-stock"->"QUOTE_CONFIRM_STOCK";case "record-sent"->"RECORD_SENT";case "record-response"->"RECORD_RESPONSE";case "update"->"UPDATE";case "cancel"->"DRAFT".equals(d.get("status"))?"REQUEST_CANCEL":"APPROVE_CANCEL";case "close"->"APPROVE_CANCEL";case "dispatch"->"DISPATCH";case "receive"->"RECEIVE";case "count","record-count"->"UPDATE";default->"SUBMIT";};require(a,f,p);if(action.equals("receive")&&x.path("lines").isArray())for(var l:x.path("lines"))if(l.path("damaged").asBoolean())require(a,"transfer","CONFIRM_DISCREPANCY");return;}
    if(op.startsWith("CATALOG_UPDATE_")){require(a,"products","UPDATE");if(x.has("price"))require(a,"products","UPDATE_PRICE");return;}
    if(op.equals("SALES_CUSTOMER_CREATE")){require(a,"customer","CREATE");require(a,"crm","CREATE");return;}
    if(op.equals("CUSTOMER_QUICK_CREATE")){require(a,"customer","CREATE");return;}
    if(op.equals("PARTNER_CREATE")){partnerWrite(a,null,x);return;}
    if(op.startsWith("PARTNER_UPDATE_")){partnerWrite(a,UUID.fromString(op.substring(15)),x);return;}
    if(op.startsWith("CATALOG_")){String kind=op.substring(8),f=catalogFeature(kind);require(a,f,kind.equals("scopes")?"MANAGE":kind.equals("settings")?"UPDATE":"CREATE");if(Set.of("price-rules","promotions").contains(kind)||kind.equals("skus")&&num(x,"price",java.math.BigDecimal.ZERO).signum()>0)require(a,"products","UPDATE_PRICE");return;}
    if(op.startsWith("DEACTIVATE_")){String kind=op.substring(11,op.lastIndexOf('_'));require(a,catalogFeature(kind),"DEACTIVATE");return;}
    if(op.equals("UOM_CONVERSION")){boolean existing=r.db.queryForObject("select count(*) from retail.uom_conversion where tenant_id=? and product_id=? and uom_id=?",Integer.class,r.tenant(a),uuid(x,"productId"),uuid(x,"uomId"))>0;require(a,"uom-conversions",existing?"UPDATE":"CREATE");return;}
    if(op.equals("WAREHOUSE_CONFIG")){String kind=text(x,"kind","");boolean existing=kind.equals("INVENTORY")||r.db.queryForObject("select count(*) from retail.warehouse_config where tenant_id=? and kind=? and code=?",Integer.class,r.tenant(a),kind,text(x,"code",""))>0;require(a,configFeature(kind),existing?"UPDATE":"CREATE");return;}
    if(op.equals("PAYMENT_CREATE")){if(r.inRole(a,"sales")){salesContractCollection(a,x);return;}if(x.path("allocations").isArray())for(var allocation:x.path("allocations")){var o=r.one("open_item",r.tenant(a),uuid(allocation,"openItemId"));r.branch(a,(UUID)o.get("branch_id"));require(a,o.get("kind").equals("AR")?"receivables":"payables","ALLOCATE");}String f=Set.of("RECEIPT","SUPPLIER_REFUND").contains(text(x,"kind","RECEIPT"))?"receipt":"payment";require(a,f,"CREATE");return;}
    if(op.startsWith("RECEIPT_REQUEST_APPROVE_")||op.startsWith("RECEIPT_REQUEST_REJECT_")){if(r.inRole(a,"sales"))throw problem("PERMISSION_DENIED","Sales không được duyệt khoản tiền do Sales báo thu",HttpStatus.FORBIDDEN);require(a,"receipt","CREATE");return;}
    if(op.equals("ALLOCATION")){if(r.inRole(a,"sales"))throw problem("PERMISSION_DENIED","Sales chỉ được thu tiền từ hồ sơ hợp đồng",HttpStatus.FORBIDDEN);var pay=r.one("payment",r.tenant(a),uuid(x,"paymentId"));r.branch(a,(UUID)pay.get("branch_id"));var o=r.one("open_item",r.tenant(a),uuid(x,"openItemId"));r.branch(a,(UUID)o.get("branch_id"));require(a,o.get("kind").equals("AR")?"receivables":"payables","ALLOCATE");return;}
    if(op.equals("COMMISSION_CREATE")){if(r.inRole(a,"sales"))throw problem("PERMISSION_DENIED","Sales chỉ được xem dữ liệu kế toán",HttpStatus.FORBIDDEN);require(a,"commission","CREATE");return;}
    if(op.equals("DELIVERY_CREATE")){require(a,"delivery","CREATE");return;}
    if(op.startsWith("DELIVERY_")){require(a,"delivery",op.startsWith("DELIVERY_settle")?"SETTLE":"UPDATE");return;}
    if(op.equals("CARE_CREATE")){require(a,"crm","CREATE");return;}
    if(op.startsWith("CARE_COMPLETE_")){require(a,"crm","COMPLETE");return;}
    if(op.startsWith("ASSIGNED_CARE_CREATE_")){require(a,"crm","CREATE");return;}
    if(op.equals("ASSIGNED_CARE_CUSTOMER_CREATE")){require(a,"crm","CREATE");return;}
    if(op.startsWith("ASSIGNED_CARE_COMPLETE_")){require(a,"crm","COMPLETE");return;}
    if(op.equals("WARRANTY_CREATE")){require(a,"warranty","CREATE");return;}
    if(op.startsWith("WARRANTY_STATUS_")){require(a,"warranty","UPDATE");return;}
    if(op.equals("IMPORT_PREVIEW")){importPermission(a,text(x,"kind",""),x.path("rows"));return;}
    if(op.startsWith("IMPORT_COMMIT_")){var b=r.one("import_batch",r.tenant(a),UUID.fromString(op.substring(14)));r.warehouse(a,(UUID)b.get("warehouse_id"));importPermission(a,b.get("kind").toString(),r.node(b.get("rows")));return;}
    throw problem("PERMISSION_OPERATION","Lệnh chưa được cấu hình phân quyền",HttpStatus.FORBIDDEN);
  }
  private void salesContractCollection(Authentication a,JsonNode x){
    if(!"RECEIPT".equals(text(x,"kind","RECEIPT")))throw problem("PERMISSION_DENIED","Sales chỉ được thu tiền khách hàng từ hồ sơ hợp đồng",HttpStatus.FORBIDDEN);
    UUID documentId=optional(x,"documentId");if(documentId==null)throw problem("PERMISSION_DENIED","Khoản thu của Sales phải liên kết với hợp đồng",HttpStatus.FORBIDDEN);
    var d=r.documentReference(a,documentId);UUID partner=optional(x,"partnerId"),branch=uuid(x,"branchId");
    if(!Set.of("SALE_ORDER","ISSUE").contains(Objects.toString(d.get("type"),""))||d.get("sales_order_id")==null||!Objects.equals(partner,d.get("partner_id"))||!Objects.equals(branch,d.get("branch_id")))throw problem("PERMISSION_DENIED","Khoản thu không thuộc hợp đồng được phép xử lý",HttpStatus.FORBIDDEN);
    r.branch(a,branch);r.warehouse(a,(UUID)d.get("warehouse_id"));r.customerReady(a,(UUID)d.get("partner_id"));
    if(x.path("allocations").isArray())for(var allocation:x.path("allocations")){var o=r.one("open_item",r.tenant(a),uuid(allocation,"openItemId"));if(!"AR".equals(o.get("kind"))||!Objects.equals(o.get("document_id"),documentId)||!Objects.equals(o.get("partner_id"),partner)||!Objects.equals(o.get("branch_id"),branch))throw problem("PERMISSION_DENIED","Công nợ không thuộc hợp đồng được phép xử lý",HttpStatus.FORBIDDEN);}
  }
  private void customerWorkflowCommand(Authentication a,String op){
    String suffix=op.substring("CUSTOMER_WORKFLOW_".length());
    if(suffix.startsWith("CREATE_")){String origin=suffix.substring("CREATE_".length());require(a,"lead-workflow","CREATE");
      // Marketing creates a pending workflow record, not a Customer Master
      // record. Requiring customer:CREATE here blocked its own lead form.
      if(origin.equals("sales")){
        require(a,"customer","CREATE");
        if(!r.inRole(a,"sales"))throw problem("PERMISSION_DENIED","Chức năng dành cho Sales",HttpStatus.FORBIDDEN);
      }
      return;
    }
    if(suffix.startsWith("UPDATE_")){require(a,"lead-workflow","UPDATE");require(a,"lead-workflow","VIEW");r.customerRead(a,UUID.fromString(op.substring(op.lastIndexOf('_')+1)));return;}
    if(suffix.startsWith("IMPORT_")){require(a,"lead-workflow","IMPORT");require(a,"customer","IMPORT");require(a,"customer","CREATE");return;}
    int separator=suffix.lastIndexOf('_');
    String action=separator>0?suffix.substring(0,separator):suffix;
    switch(action){
      case "approve","needs-info","reject","review-deadline" -> require(a,"lead-workflow","APPROVE");
      case "approve-assign" -> {require(a,"lead-workflow","APPROVE");require(a,"lead-workflow","ASSIGN");}
      case "assign","revoke" -> require(a,"lead-workflow","ASSIGN");
      case "resubmit" -> require(a,"lead-workflow","UPDATE");
      case "care-state" -> require(a,"crm","CREATE");
      default -> throw problem("INVALID_ACTION","Thao tác luồng khách hàng không hợp lệ",HttpStatus.BAD_REQUEST);
    }
    require(a,"lead-workflow","VIEW");
    r.customerRead(a,UUID.fromString(op.substring(op.lastIndexOf('_')+1)));
  }
  public void importPermission(Authentication a,String kind,JsonNode rows){switch(kind){case "SKUS"->{require(a,"products","IMPORT");require(a,"products","CREATE");}case "PARTNERS"->{for(var row:rows){require(a,partnerFeature(text(row,"kind","CUSTOMER")),"IMPORT");partnerWrite(a,null,row);}}case "OPENING_STOCK"->{require(a,"opening-stock","IMPORT");require(a,"opening-stock","CREATE");}default->{for(var row:rows){String f=text(row,"kind","").equals("AR")?"opening-ar":"opening-ap";require(a,f,"IMPORT");require(a,f,"CREATE");}}}}
}

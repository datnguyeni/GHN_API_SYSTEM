package vn.aicrm.shared;
import java.util.*;
public final class BusinessModules {
 public static final String SHARED="aicrm-retail",STOCK="aicrm-stock",SALES="aicrm-sales",PURCHASE="aicrm-purchase",PRODUCTS="aicrm-products",PARTNERS="aicrm-partners",CRM="aicrm-crm",ACCOUNTING="aicrm-accounting",OPERATIONS="aicrm-operations",OVERVIEW="aicrm-overview",REPORTS="aicrm-reports";
 public static final List<String> ALL=List.of(SHARED,PRODUCTS,PARTNERS,OPERATIONS,ACCOUNTING,STOCK,SALES,PURCHASE,CRM,OVERVIEW,REPORTS);
 private BusinessModules(){}
 public static void registerResources(String owner,vn.coreplatform.kernel.ResourceRegistry resources){for(var feature:RetailPermissions.FEATURES)if(owner(feature.code()).equals(owner)){String key=RetailPermissions.resource(feature.code());for(String legacy:List.of(SHARED,SALES,PURCHASE,STOCK))resources.reassignLegacyOwner(key,legacy,owner);var descriptor=new vn.coreplatform.kernel.ResourceDescriptor(key,feature.name(),owner,"DOMAIN","1.0.0",descriptorActions(feature),"ALWAYS","CONFIDENTIAL");var legacy=legacyDescriptor(feature.code(),key);if(legacy==null)resources.register(descriptor);else resources.upgradeLegacyDescriptor(descriptor,legacy);}}
 /**
  * Resource descriptors are strict deployment contracts. Fine-grained quote workflow
  * actions are registered in RetailPermissions and role policies, not by mutating the
  * already-persisted platform descriptor for aicrm-orders.
  */
 private static List<String> descriptorActions(RetailPermissions.Feature feature){
  if(feature.code().equals("orders"))return List.of("VIEW","CREATE","SUBMIT","APPROVE","REJECT","REQUEST_CANCEL","APPROVE_CANCEL","PRINT","EXPORT");
  return feature.actions();
 }
 private static vn.coreplatform.kernel.ResourceDescriptor legacyDescriptor(String feature,String key){return switch(feature){case "products"->new vn.coreplatform.kernel.ResourceDescriptor(key,"Danh sách sản phẩm",PRODUCTS,"DOMAIN","1.0.0",List.of("VIEW","CREATE","UPDATE","DEACTIVATE","VIEW_PRICE","UPDATE_PRICE","IMPORT","EXPORT"),"ALWAYS","CONFIDENTIAL");case "stock"->new vn.coreplatform.kernel.ResourceDescriptor(key,"Kho & Tồn / Nhập xuất khác",STOCK,"DOMAIN","1.0.0",List.of("VIEW","CREATE","SUBMIT","APPROVE","REJECT","RECEIVE","DISPATCH","REQUEST_CANCEL","APPROVE_CANCEL","PRINT","EXPORT"),"ALWAYS","CONFIDENTIAL");case "leads"->new vn.coreplatform.kernel.ResourceDescriptor(key,"Khách hàng tiềm năng",CRM,"DOMAIN","1.0.0",List.of("VIEW","CREATE","UPDATE","CONVERT"),"ALWAYS","CONFIDENTIAL");case "lead-workflow"->new vn.coreplatform.kernel.ResourceDescriptor(key,"Luồng duyệt và phân công khách hàng",CRM,"DOMAIN","1.0.0",List.of("VIEW","CREATE","UPDATE","APPROVE","ASSIGN","IMPORT"),"ALWAYS","CONFIDENTIAL");case "opportunities"->new vn.coreplatform.kernel.ResourceDescriptor(key,"Cơ hội",CRM,"DOMAIN","1.0.0",List.of("VIEW","CREATE","UPDATE"),"ALWAYS","CONFIDENTIAL");case "crm"->new vn.coreplatform.kernel.ResourceDescriptor(key,"Chăm sóc khách hàng",CRM,"DOMAIN","1.0.0",List.of("VIEW","CREATE","UPDATE","COMPLETE","VIEW_HISTORY","EXPORT"),"ALWAYS","CONFIDENTIAL");case "receipt"->new vn.coreplatform.kernel.ResourceDescriptor(key,"Phiếu thu",ACCOUNTING,"DOMAIN","1.0.0",List.of("VIEW","CREATE","ALLOCATE","APPROVE","REJECT","PRINT","EXPORT"),"ALWAYS","CONFIDENTIAL");case "warehouses"->new vn.coreplatform.kernel.ResourceDescriptor(key,"Danh sách kho",STOCK,"DOMAIN","1.0.0",List.of("VIEW","CREATE","UPDATE","DEACTIVATE","EXPORT"),"ALWAYS","CONFIDENTIAL");default->null;};}
 public static String owner(String f){if(f.startsWith("overview-"))return OVERVIEW;if(f.startsWith("report-"))return REPORTS;return switch(f){
 case "pos","orders","delivery","returns","warranty","sales-quotes"->SALES;case "purchase-order","purchase-receipt","purchase-return","supplier"->PURCHASE;case "stock","issue","transfer","count","opening-stock","warehouses","warehouse-config"->STOCK;
 case "products","product-groups","product-brands","product-units","uom-conversions","product-attributes"->PRODUCTS; case "customer","partners"->PARTNERS;case "epc-projects","lead-workflow","crm-customer","crm","leads","opportunities","customer-care"->CRM;case "receipt","payment","receivables","payables","opening-ar","opening-ap","commission","refund","sensitive"->ACCOUNTING;case "locations","setup","scope","approvals"->OPERATIONS;default->SHARED;};}


    public static String screenOwner(String s){return switch(s){case "purchase","suppliers"->PURCHASE;case "sales-customers","returns","quotes","sales-quotes","shipping"->SALES;case "master-customers","master-partners"->PARTNERS;case "epc-projects","customers","customer-care","leads","opportunities","crm-sales-customers","scope"->CRM;case "cashflow","debt","contracts"->ACCOUNTING;case "overview"->OVERVIEW;case "reports"->REPORTS;default->owner(s);};}
    public static String packageOwner(String pkg){return switch(pkg.substring(pkg.lastIndexOf('.')+1)){case "sales","shipping"->SALES;case "inventory"->STOCK;case "purchase"->PURCHASE;case "products"->PRODUCTS;case "partners"->PARTNERS;case "crm","leads","opportunities"->CRM;case "accounting"->ACCOUNTING;case "operations"->OPERATIONS;case "overview"->OVERVIEW;case "reports"->REPORTS;default->SHARED;};}


}

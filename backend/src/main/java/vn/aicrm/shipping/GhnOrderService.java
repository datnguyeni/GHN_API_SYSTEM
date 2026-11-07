package vn.aicrm.shipping;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import java.math.BigDecimal;
import java.net.URI;
import java.net.http.HttpClient;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.sql.Timestamp;
import java.time.*;
import java.util.*;
import org.springframework.http.HttpStatus;
import org.springframework.http.client.JdkClientHttpRequestFactory;
import org.springframework.security.core.Authentication;
import org.springframework.stereotype.Service;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.TransactionDefinition;
import org.springframework.transaction.support.TransactionTemplate;
import org.springframework.web.client.*;
import org.springframework.web.util.UriComponentsBuilder;
import vn.aicrm.shared.RetailAccess;
import static vn.aicrm.shared.RetailAccess.*;
import static vn.coreplatform.security.SecurityConfig.sha256;

/** JDBC workflow. Local transactions finish before any external create call. */
@Service
public class GhnOrderService {
  private final RetailAccess r;
  private final TransactionTemplate tx;
  private final RestClient http;

  public GhnOrderService(RetailAccess r,PlatformTransactionManager manager) {
    this.r=r;
    this.tx=new TransactionTemplate(manager);
    this.tx.setPropagationBehavior(TransactionDefinition.PROPAGATION_REQUIRES_NEW);
    var factory=new JdkClientHttpRequestFactory(HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(10)).build());
    factory.setReadTimeout(Duration.ofSeconds(25));
    this.http=RestClient.builder().requestFactory(factory).build();
  }

  public Object orders(Authentication a) {
    r.gate(a,"delivery","VIEW");
    return r.db.queryForList("""
      select o.id,o.order_number,o.status,o.shipping_status,o.grand_total,o.created_at,
        p.name customer,w.name warehouse,
        (select string_agg(nullif(d.tracking,''),', ') from retail.delivery d
          where d.tenant_id=o.tenant_id and d.sales_order_id=o.id) tracking
      from retail.shipping_order_queue q join retail.sales_order o on o.tenant_id=q.tenant_id and o.id=q.sales_order_id
      join retail.warehouse w on w.tenant_id=o.tenant_id and w.id=o.preferred_warehouse_id
      join retail.partner p on p.tenant_id=o.tenant_id and p.id=o.partner_id
      where o.tenant_id=? and
      """+r.scope(a,"w").replace("w.warehouse_id","w.id")+" and ("+r.customerScope(a,"p")+")"
      +" order by q.created_at desc limit 500",r.tenant(a));
  }

  private Map<String,Object> order(Authentication a,UUID id,boolean lock) {
    var rows=r.db.queryForList("select * from retail.sales_order where tenant_id=? and id=?"+(lock?" for update":""),r.tenant(a),id);
    if(rows.isEmpty())throw problem("ORDER_NOT_FOUND","Không tìm thấy đơn bán",HttpStatus.NOT_FOUND);
    var o=rows.getFirst();
    r.warehouse(a,(UUID)o.get("preferred_warehouse_id"));r.customerRead(a,(UUID)o.get("partner_id"));
    return o;
  }

  public Object detail(Authentication a,UUID orderId) {
    r.gate(a,"delivery","VIEW");var o=order(a,orderId,false);UUID t=r.tenant(a);
    var out=new LinkedHashMap<>(o);
    out.put("customer_snapshot",r.node(o.get("customer_snapshot")));
    out.put("shipping_address_snapshot",r.node(o.get("shipping_address_snapshot")));
    out.put("canCreate",r.granular(a,"delivery","CREATE"));
    out.put("issues",r.db.queryForList("""
      select d.id,d.number,d.warehouse_id,d.total,w.name warehouse,
        coalesce((select sum(amount-credit-allocated) from retail.open_item oi
          where oi.tenant_id=d.tenant_id and oi.document_id=d.id and oi.kind='AR'),0) outstanding
      from retail.document d join retail.warehouse w on w.tenant_id=d.tenant_id and w.id=d.warehouse_id
      where d.tenant_id=? and d.sales_order_id=? and d.type='ISSUE' and d.status='POSTED'
        and not exists(select 1 from retail.delivery v where v.tenant_id=d.tenant_id and v.issue_id=d.id)
      """+" and "+r.scope(a,"d")+" order by d.created_at",t,orderId));
    out.put("items",r.db.queryForList("""
      select l.id,l.document_id issue_id,l.qty,l.unit,l.base_qty,l.sku_id,s.name,s.code
      from retail.line l join retail.document d on d.tenant_id=l.tenant_id and d.id=l.document_id
      join retail.sku s on s.tenant_id=l.tenant_id and s.id=l.sku_id
      where d.tenant_id=? and d.sales_order_id=? and d.type='ISSUE' and d.status='POSTED'
      """+" and "+r.scope(a,"d")+" order by l.position",t,orderId));
    out.put("shops",r.db.queryForList("""
      select s.id,s.shipping_account_id account_id,s.shop_name,s.warehouse_id,s.external_shop_id,
        s.default_service_type_id,s.default_payment_type_id,s.default_required_note,s.is_default,a.environment
      from retail.shipping_shop s join retail.shipping_account a on a.tenant_id=s.tenant_id and a.id=s.shipping_account_id
      where s.tenant_id=? and s.branch_id=? and s.active and a.active and a.carrier_code='GHN'
      """+" and "+r.scope(a,"s")+" order by s.is_default desc,s.shop_name",t,o.get("branch_id")));
    out.put("deliveries",r.db.queryForList("""
      select v.id,v.issue_id,v.tracking,v.integration_status,v.status,v.carrier_status,v.cod,v.fee,
        v.carrier_fee_current,v.expected_delivery_at,v.last_error_message,v.note,v.version,v.created_at
      from retail.delivery v join retail.document d on d.tenant_id=v.tenant_id and d.id=v.issue_id
      where v.tenant_id=? and v.sales_order_id=?
      """+" and "+r.scope(a,"d")+" order by v.created_at desc",t,orderId));
    out.put("events",r.db.queryForList("""
      select e.id,e.carrier_order_code,e.event_type,e.carrier_status,e.event_time,e.reason,e.processing_status
      from retail.shipping_event e join retail.delivery v on v.tenant_id=e.tenant_id and v.id=e.delivery_id
      join retail.document d on d.tenant_id=v.tenant_id and d.id=v.issue_id
      where v.tenant_id=? and v.sales_order_id=?
      """+" and "+r.scope(a,"d")+" order by e.event_time desc limit 100",t,orderId));
    return out;
  }

  private Map<String,Object> shop(UUID tenant,UUID shopId) {
    var list=r.db.queryForList("""
      select s.*,a.environment,a.credential_ref from retail.shipping_shop s
      join retail.shipping_account a on a.tenant_id=s.tenant_id and a.id=s.shipping_account_id
      where s.tenant_id=? and s.id=? and s.active and a.active and a.carrier_code='GHN'
      """,tenant,shopId);
    if(list.isEmpty())throw problem("GHN_SHOP_NOT_FOUND","Shop GHN chưa cấu hình hoặc đã ngưng hoạt động");
    var s=list.getFirst();
    if(Objects.toString(s.get("credential_ref"),"").isBlank())throw problem("GHN_TOKEN_MISSING","Shop chưa có token GHN");
    return s;
  }

  private static String base(Object environment) {
    return "STAGING".equals(environment)?"https://dev-online-gateway.ghn.vn":"https://online-gateway.ghn.vn";
  }
  private JsonNode call(Map<String,Object> shop,String path,JsonNode payload) {
    try {
      var headers=new org.springframework.http.HttpHeaders();
      headers.set("Token",Objects.toString(shop.get("credential_ref")));
      headers.set("ShopId",Objects.toString(shop.get("external_shop_id")));
      JsonNode result=payload==null
        ?http.get().uri(URI.create(base(shop.get("environment"))+path)).headers(h->h.addAll(headers)).retrieve().body(JsonNode.class)
        :http.post().uri(base(shop.get("environment"))+path).headers(h->h.addAll(headers))
          .contentType(org.springframework.http.MediaType.APPLICATION_JSON).body(payload).retrieve().body(JsonNode.class);
      if(result!=null&&result.path("code").asInt()!=200)
        throw new CarrierFailure("GHN_REJECTED","GHN từ chối yêu cầu; kiểm tra địa chỉ, dịch vụ và cấu hình shop",
          result.path("code").asInt()>=500);
      if(result==null||!result.hasNonNull("data"))
        throw new CarrierFailure("GHN_RESPONSE_INVALID","GHN chưa trả kết quả hợp lệ; cần kiểm tra lại vận đơn",true);
      return result.path("data");
    } catch(RestClientResponseException e) {
      boolean unknown=e.getStatusCode().is5xxServerError()||e.getStatusCode().value()==408||e.getStatusCode().value()==429;
      // Never expose raw provider bodies (they can echo tokens and recipient data).
      throw new CarrierFailure("GHN_HTTP_"+e.getStatusCode().value(),
        carrierError(e.getStatusCode().value(),path,e.getResponseBodyAsString()),unknown);
    } catch(RestClientException e) {
      throw new CarrierFailure("GHN_UNAVAILABLE","Không nhận được kết quả từ GHN; cần tra cứu lại trước khi tạo tiếp",true);
    }
  }
  static final class CarrierFailure extends RuntimeException {
    final String code;final boolean unknown;
    CarrierFailure(String code,String message,boolean unknown){super(message);this.code=code;this.unknown=unknown;}
  }
  private String carrierError(int status,String path,String responseBody) {
    String stage=path.endsWith("/preview")?"kiểm tra phí":path.endsWith("/create")?"tạo vận đơn":"tra cứu";
    String explanation="Kiểm tra cấu hình, địa chỉ và dịch vụ.";
    try {
      var error=r.json.readTree(responseBody);String code=error.path("code_message").asText();
      String message=error.path("message").asText().toLowerCase(Locale.ROOT);
      explanation=switch(code) {
        case "CLIENT_NOT_OWNER_OF_SHOP" -> "Token không thuộc Shop ID đã chọn.";
        case "PHONE_INVALID" -> "Số điện thoại người gửi hoặc người nhận không hợp lệ.";
        case "ROUTE_NOT_FOUND_SERVICE" -> "GHN chưa hỗ trợ tuyến lấy/giao với dịch vụ đã chọn.";
        case "SERVICE_NOT_FOUND_CONFIG_FEE" -> "Dịch vụ của tuyến lấy/giao chưa có cấu hình phí trên GHN.";
        default -> message.contains("route not found")?"GHN chưa hỗ trợ tuyến lấy/giao với dịch vụ đã chọn."
          :message.contains("required note")?"Yêu cầu xem/thử hàng không hợp lệ."
          :message.contains("insurance")?"Giá trị khai giá bảo hiểm không hợp lệ."
          :message.contains("phone")?"Số điện thoại người gửi hoặc người nhận không hợp lệ."
          :explanation;
      };
    } catch(Exception ignored) { /* Never display raw carrier bodies, tokens or recipient data. */ }
    return "GHN trả lỗi HTTP "+status+" ở bước "+stage+". "+explanation;
  }

  public Object locations(Authentication a,UUID orderId,UUID shopId,Long provinceId) {
    r.gate(a,"delivery","VIEW");var o=order(a,orderId,false);var s=shop(r.tenant(a),shopId);
    r.warehouse(a,(UUID)s.get("warehouse_id"));
    if(!Objects.equals(o.get("branch_id"),s.get("branch_id")))throw problem("SHOP_BRANCH_MISMATCH","Shop không thuộc chi nhánh đơn bán");
    try{return locationData(s,provinceId);}
    catch(CarrierFailure e){throw problem(e.code,e.getMessage(),HttpStatus.BAD_GATEWAY);}
  }
  private JsonNode locationData(Map<String,Object> s,Long province) {
    if(province!=null&&province<=0)throw problem("INVALID_PROVINCE","Mã tỉnh/thành không hợp lệ");
    String path=province==null?"/shiip/public-api/v3/master-data/province/all?offset=0&limit=200":
      "/shiip/public-api/v3/master-data/ward/all-by-province-id?province_id="+province+"&offset=0&limit=200";
    return call(s,path,null);
  }
  private ObjectNode address(Map<String,Object> s,JsonNode input,String label) {
    if(!input.isObject())throw problem("INVALID_ADDRESS","Thiếu địa chỉ "+label);
    var out=r.json.createObjectNode();
    out.put("name",required(input,"name",1024));String phone=required(input,"phone",20).replace(" ","").replace("-","");
    if(!phone.matches("(0|\\+84)[0-9]{9,10}"))throw problem("INVALID_PHONE","Số điện thoại "+label+" không hợp lệ");
    out.put("phone",phone);out.put("address",required(input,"address",1024));
    long province=input.path("provinceId").asLong(0),ward=input.path("wardId").asLong(0);
    JsonNode foundProvince=null,foundWard=null;
    for(var row:locationData(s,null))if(row.path("_id").asLong()==province&&row.path("status").asInt(1)==1)foundProvince=row;
    if(foundProvince==null)throw problem("INVALID_PROVINCE","Tỉnh/thành "+label+" không thuộc danh mục GHN");
    for(var row:locationData(s,province))if(row.path("_id").asLong()==ward&&row.path("status").asInt(1)==1)foundWard=row;
    if(foundWard==null)throw problem("INVALID_WARD","Phường/xã "+label+" không thuộc tỉnh/thành đã chọn");
    out.put("provinceId",province);out.put("provinceName",foundProvince.path("name").asText());
    out.put("wardId",ward);out.put("wardName",foundWard.path("name").asText());
    return out;
  }
  private static int integer(JsonNode n,String key,int min,int max) {
    BigDecimal v=num(n,key,BigDecimal.valueOf(-1));
    try{int i=v.intValueExact();if(i>=min&&i<=max)return i;}catch(ArithmeticException ignored){}
    throw problem("INVALID_FIELD",key+" phải là số nguyên từ "+min+" đến "+max);
  }
  private void writeAddress(ObjectNode payload,String prefix,JsonNode address) {
    for(String key:List.of("name","phone","address"))payload.put(prefix+"_"+key,address.path(key).asText());
    payload.put(prefix+"_province_name",address.path("provinceName").asText());
    payload.put(prefix+"_ward_name",address.path("wardName").asText());
    payload.put("is_new_"+prefix+"_address",true);
  }
  private JsonNode snapshotAddress(JsonNode payload,String prefix) {
    var snapshot=r.json.createObjectNode();
    for(String key:List.of("name","phone","address"))snapshot.put(key,payload.path(prefix+"_"+key).asText());
    return snapshot.put("provinceName",payload.path(prefix+"_province_name").asText())
      .put("wardName",payload.path(prefix+"_ward_name").asText());
  }

  private Map<String,Object> issue(Authentication a,Map<String,Object> o,UUID issueId) {
    var list=r.db.queryForList("select * from retail.document where tenant_id=? and id=? for update",r.tenant(a),issueId);
    if(list.isEmpty())throw problem("ISSUE_REQUIRED","Chọn phiếu xuất kho đã ghi sổ");
    var d=list.getFirst();r.warehouse(a,(UUID)d.get("warehouse_id"));
    if(!"CONFIRMED".equals(o.get("status"))||!"ISSUE".equals(d.get("type"))||!"POSTED".equals(d.get("status"))
        ||!Objects.equals(o.get("id"),d.get("sales_order_id"))||!Objects.equals(o.get("branch_id"),d.get("branch_id")))
      throw problem("ISSUE_REQUIRED","Cần đơn sale đã xác nhận và phiếu xuất đã ghi sổ thuộc đơn này");
    if(Boolean.TRUE.equals(r.db.queryForObject("""
      select exists(select 1 from retail.document where tenant_id=? and source_id=? and type='SALE_RETURN' and status='POSTED')
      """,Boolean.class,r.tenant(a),issueId)))throw problem("ISSUE_RETURNED","Phiếu xuất đã có hàng trả; cần xử lý lại đợt giao");
    return d;
  }
  private List<Map<String,Object>> goods(UUID tenant,UUID issueId,UUID orderId) {
    var lines=r.db.queryForList("""
      select l.*,s.name item_name,s.code item_code,s.active sku_active,i.order_id item_order_id,
        coalesce((select -sum(m.qty) from retail.movement m where m.tenant_id=l.tenant_id
          and m.document_id=l.document_id and m.line_id=l.id and m.sku_id=l.sku_id),0) issued_stock
      from retail.line l join retail.sku s on s.tenant_id=l.tenant_id and s.id=l.sku_id
      left join retail.sales_order_item i on i.tenant_id=l.tenant_id and i.id=l.sales_order_item_id and i.sku_id=l.sku_id
      where l.tenant_id=? and l.document_id=? order by l.position
      """,tenant,issueId);
    if(lines.isEmpty())throw problem("ITEMS_REQUIRED","Phiếu xuất chưa có hàng hóa");
    for(var l:lines)if(!Boolean.TRUE.equals(l.get("sku_active"))||!orderId.equals(l.get("item_order_id"))
        ||decimal(l.get("base_qty")).signum()<=0)throw problem("INVALID_ITEMS","Hàng hóa ngừng bán hoặc không khớp đơn sale");
    for(var l:lines)if(decimal(l.get("issued_stock")).compareTo(decimal(l.get("base_qty")))!=0)
      throw problem("STOCK_NOT_ISSUED","Sổ kho chưa xác nhận đủ lượng xuất của phiếu; kiểm tra phiếu xuất trước khi giao");
    // POSTED ISSUE has already passed inventory/lot/serial checks and deducted stock.
    // Current on-hand may be zero after that deduction; do not deduct or check it a second time.
    return lines;
  }
  private void checkCod(UUID tenant,UUID issueId,BigDecimal cod) {
    var debts=r.db.queryForList("select amount-credit-allocated outstanding from retail.open_item where tenant_id=? and document_id=? and kind='AR' for update",tenant,issueId);
    var outstanding=debts.stream().map(v->decimal(v.get("outstanding"))).reduce(BigDecimal.ZERO,BigDecimal::add).max(BigDecimal.ZERO);
    if(cod.signum()<0||cod.compareTo(outstanding)>0||cod.compareTo(BigDecimal.valueOf(50_000_000))>0)
      throw problem("INVALID_COD","COD không được vượt công nợ còn lại của phiếu xuất hoặc 50 triệu đồng");
  }

  private ObjectNode packagePayload(Map<String,Object> s,JsonNode input,List<Map<String,Object>> lines,BigDecimal orderValue) {
      var recipient=address(s,input.path("recipient"),"người nhận");
      var sender=address(s,r.node(s.get("sender_snapshot")),"người gửi");
      var returns=address(s,r.node(s.get("return_snapshot")),"hoàn hàng");
      int weight=integer(input,"weight",1,50000),length=integer(input,"length",1,200),
        width=integer(input,"width",1,200),height=integer(input,"height",1,200);
      int service=integer(input,"serviceTypeId",2,5),payment=integer(input,"paymentTypeId",1,2);
      if(service!=2&&service!=5||weight>=20000&&service!=5)throw problem("INVALID_SERVICE","Chọn dịch vụ 2 cho hàng nhẹ, 5 cho hàng từ 20 kg");
      int cod=integer(input,"codAmount",0,50_000_000),insurance=integer(input,"insuranceValue",0,5_000_000);
      String note=required(input,"requiredNote",40);
      if(!Set.of("KHONGCHOXEMHANG","CHOXEMHANGKHONGTHU","CHOTHUHANG").contains(note))throw problem("INVALID_REQUIRED_NOTE","Yêu cầu giao không hợp lệ");
      var body=r.json.createObjectNode();
      writeAddress(body,"to",recipient);writeAddress(body,"from",sender);writeAddress(body,"return",returns);
      body.put("weight",weight).put("length",length).put("width",width).put("height",height)
        .put("service_type_id",service).put("payment_type_id",payment).put("cod_amount",cod)
        .put("insurance_value",insurance).put("order_value",orderValue)
        .put("required_note",note).put("note",text(input,"note",""));
      if(body.path("note").asText().length()>5000)throw problem("INVALID_NOTE","Ghi chú tối đa 5000 ký tự");
      var items=body.putArray("items");var packed=new HashMap<UUID,JsonNode>();
      if(!input.path("items").isArray())throw problem("ITEMS_REQUIRED","Cần khai số lượng kiện cho từng dòng hàng");
      for(var p:input.path("items"))if(packed.put(uuid(p,"issueLineId"),p)!=null)throw problem("DUPLICATE_ITEM","Dòng đóng gói bị lặp");
      if(packed.size()!=lines.size())throw problem("INVALID_ITEMS","Danh sách kiện phải khớp tất cả dòng phiếu xuất");
      long totalWeight=0;
      for(var line:lines){
        var pack=packed.get((UUID)line.get("id"));
        if(pack==null)throw problem("INVALID_ITEMS","Thiếu dòng đóng gói của phiếu xuất");
        var item=items.addObject().put("name",Objects.toString(line.get("item_name")))
          .put("code",Objects.toString(line.get("item_code")));
        int quantity=integer(pack,"quantity",1,10000);item.put("quantity",quantity);
        if(service==5){
          int iw=integer(pack,"weight",1,50000);
          item.put("weight",iw).put("length",integer(pack,"length",1,200))
            .put("width",integer(pack,"width",1,200)).put("height",integer(pack,"height",1,200));
          totalWeight+=(long)quantity*iw;
        }
      }
      if(service==5&&totalWeight!=weight)throw problem("INVALID_PACKAGE_WEIGHT","Tổng khối lượng phải bằng tổng số kiện × khối lượng mỗi kiện");
      return body;
  }

  private Map<String,Object> salesQuote(Authentication a,UUID quoteId) {
    r.gate(a,"orders","CREATE");r.gate(a,"orders","RECORD_RESPONSE");
    var q=r.documentReference(a,quoteId);r.warehouse(a,(UUID)q.get("warehouse_id"));r.customerReady(a,(UUID)q.get("partner_id"));
    if(!"QUOTE".equals(q.get("type"))||!"APPROVED".equals(q.get("status")))throw problem("QUOTE_NOT_APPROVED","Báo giá cần được duyệt trước");
    return q;
  }
  public Object salesOptions(Authentication a,UUID quoteId) {
    var q=salesQuote(a,quoteId);
    return r.db.queryForList("""
      select s.id,s.shop_name,s.default_service_type_id,s.default_payment_type_id,s.default_required_note,a.environment
      from retail.shipping_shop s join retail.shipping_account a on a.tenant_id=s.tenant_id and a.id=s.shipping_account_id
      where s.tenant_id=? and s.warehouse_id=? and s.branch_id=? and s.active and a.active and a.carrier_code='GHN'
      order by s.is_default desc,s.shop_name
      """,r.tenant(a),q.get("warehouse_id"),q.get("branch_id"));
  }
  private Map<String,Object> salesShop(Authentication a,UUID quoteId,UUID shopId) {
    var q=salesQuote(a,quoteId);var s=shop(r.tenant(a),shopId);
    if(!Objects.equals(q.get("warehouse_id"),s.get("warehouse_id"))||!Objects.equals(q.get("branch_id"),s.get("branch_id")))
      throw problem("SHOP_WAREHOUSE_MISMATCH","Shop GHN phải thuộc kho và chi nhánh báo giá");
    return s;
  }
  public Object salesLocations(Authentication a,UUID quoteId,UUID shopId,Long provinceId) {
    try {return locationData(salesShop(a,quoteId,shopId),provinceId);}
    catch(CarrierFailure e){throw problem(e.code,e.getMessage(),HttpStatus.BAD_GATEWAY);}
  }
  /** Full carrier dry-run before a sales transaction may change acceptance or stock. */
  public Object previewSalesShipping(Authentication a,UUID quoteId,JsonNode input) {
    try {
      var prepared=prepareSalesRequest(a,quoteId,input);var preview=prepared.path("preview");
      var result=r.json.createObjectNode().put("totalFee",preview.path("total_fee").decimalValue())
        .put("paymentTypeId",input.path("paymentTypeId").asInt()).put("expectedDeliveryTime",preview.path("expected_delivery_time").asText(""));
      result.set("fee",preview.path("fee"));return result;
    } catch(CarrierFailure e){throw problem(e.code,e.getMessage(),HttpStatus.BAD_GATEWAY);}
  }
  public JsonNode prepareSalesRequest(Authentication a,UUID quoteId,JsonNode input) {
    var q=salesQuote(a,quoteId);var s=salesShop(a,quoteId,uuid(input,"shopRecordId"));
    var lines=r.db.queryForList("select l.*,s.name item_name,s.code item_code from retail.line l join retail.sku s on s.tenant_id=l.tenant_id and s.id=l.sku_id where l.tenant_id=? and l.document_id=? order by l.position",r.tenant(a),quoteId);
    var normalized=((ObjectNode)input).deepCopy();
    for(var pack:normalized.path("items"))((ObjectNode)pack).put("issueLineId",pack.path("quoteLineId").asText());
    if(num(input,"codAmount",BigDecimal.ZERO).compareTo(decimal(q.get("total")))>0)throw problem("INVALID_COD","COD vượt giá trị báo giá");
    var body=packagePayload(s,normalized,lines,decimal(q.get("total")));
    body.put("client_order_code","CRM-Q-"+quoteId);
    var preview=call(s,"/shiip/public-api/v2/shipping-order/preview",body);
    if(!preview.path("total_fee").isNumber()||preview.path("total_fee").decimalValue().signum()<0)
      throw new CarrierFailure("GHN_FEE_INVALID","GHN chưa trả phí vận chuyển hợp lệ",false);
    var out=r.json.createObjectNode().put("shippingAccountId",s.get("shipping_account_id").toString())
      .put("shippingShopId",s.get("id").toString()).put("externalShopId",((Number)s.get("external_shop_id")).longValue())
      .put("environment",s.get("environment").toString());
    out.set("request",body);out.set("preview",preview);out.set("input",input);
    return out;
  }
  public void validatePreparedSalesIssue(Authentication a,UUID orderId,UUID issueId,JsonNode prepared) {
    r.gate(a,"orders","CREATE");r.gate(a,"orders","RECORD_RESPONSE");
    var o=order(a,orderId,true);var d=issue(a,o,issueId);var lines=goods(r.tenant(a),issueId,orderId);
    if(lines.size()!=prepared.path("request").path("items").size()
        ||decimal(d.get("total")).compareTo(prepared.path("request").path("order_value").decimalValue())!=0)
      throw problem("SHIPPING_QUOTE_CHANGED","Hàng hóa hoặc tổng tiền đã thay đổi; cần kiểm tra lại trước khi gửi GHN");
    var shop=shop(r.tenant(a),uuid(prepared,"shippingShopId"));
    if(!Objects.equals(shop.get("warehouse_id"),d.get("warehouse_id"))||!Objects.equals(shop.get("branch_id"),d.get("branch_id")))
      throw problem("SHOP_WAREHOUSE_MISMATCH","Shop GHN không khớp kho xuất");
    checkCod(r.tenant(a),issueId,prepared.path("request").path("cod_amount").decimalValue());
  }
  /** The attempt journal has frozen this payload and client code before entering the stock transaction. */
  public JsonNode sendPreparedSales(Authentication a,JsonNode prepared,boolean lookup) {
    r.gate(a,"orders","CREATE");r.gate(a,"orders","RECORD_RESPONSE");
    var account=r.one("shipping_account",r.tenant(a),uuid(prepared,"shippingAccountId"));
    if(!lookup&&!Boolean.TRUE.equals(account.get("active")))throw new CarrierFailure("ACCOUNT_INACTIVE","Tài khoản GHN đã ngưng hoạt động",false);
    var credentials=new HashMap<String,Object>();
    credentials.put("credential_ref",account.get("credential_ref"));credentials.put("environment",prepared.path("environment").asText());
    credentials.put("external_shop_id",prepared.path("externalShopId").asLong());
    if(Objects.toString(account.get("credential_ref"),"").isBlank())throw new CarrierFailure("GHN_TOKEN_MISSING","Tài khoản chưa có token GHN",false);
    String code=prepared.path("request").path("client_order_code").asText();
    var response=lookup?call(credentials,UriComponentsBuilder.fromPath("/shiip/public-api/v2/shipping-order/detail-by-client-code")
      .queryParam("client_order_code",code).build().toUriString(),null)
      :call(credentials,"/shiip/public-api/v2/shipping-order/create",prepared.path("request"));
    if(response.path("order_code").asText().isBlank())throw new CarrierFailure("GHN_CODE_MISSING","GHN chưa trả mã vận đơn; cần đối soát",true);
    if(lookup&&(!code.equals(response.path("client_order_code").asText())||prepared.path("externalShopId").asLong()!=response.path("shop_id").asLong()))
      throw new CarrierFailure("GHN_ORDER_MISMATCH","Vận đơn tra cứu không khớp shop hoặc mã nội bộ",true);
    return response;
  }
  @org.springframework.transaction.annotation.Transactional(propagation=org.springframework.transaction.annotation.Propagation.MANDATORY)
  public Object savePreparedSalesDelivery(Authentication a,UUID orderId,UUID issueId,JsonNode prepared,JsonNode response) {
    validatePreparedSalesIssue(a,orderId,issueId,prepared);
    UUID t=r.tenant(a),quoteId=UUID.randomUUID();var body=prepared.path("request");var preview=prepared.path("preview");
    r.db.update("""
      insert into retail.shipping_quote(id,tenant_id,sales_order_id,issue_id,shipping_account_id,shipping_shop_id,
        external_shop_id,environment,input_payload,request_payload,response_payload,total_fee,created_by)
      values(?,?,?,?,?,?,?,?,?::jsonb,?::jsonb,?::jsonb,?,?)
      """,quoteId,t,orderId,issueId,uuid(prepared,"shippingAccountId"),uuid(prepared,"shippingShopId"),prepared.path("externalShopId").asLong(),
      prepared.path("environment").asText(),prepared.path("input").toString(),body.toString(),preview.toString(),preview.path("total_fee").decimalValue(),r.actor(a));
    UUID deliveryId=confirmLocal(a,orderId,r.json.createObjectNode().put("quoteId",quoteId.toString()).put("acceptedFee",preview.path("total_fee").decimalValue())
      .put("codAmount",body.path("cod_amount").asInt()).put("paymentTypeId",body.path("payment_type_id").asInt()));
    String tracking=response.path("order_code").asText();
    r.db.update("""
      update retail.delivery set integration_status='CREATED',tracking=?,carrier_created_at=now(),carrier_status='ready_to_pick',
        carrier_fee_current=?,expected_delivery_at=?,last_error_code=null,last_error_message=null,updated_at=now()
      where tenant_id=? and id=?
      """,tracking,response.path("total_fee").isNumber()?response.path("total_fee").decimalValue():null,
      optionalTime(response.path("expected_delivery_time").asText(response.path("leadtime").asText(null))),t,deliveryId);
    r.db.update("update retail.shipping_request set status='SUCCEEDED',attempt_count=1,last_response_payload=?::jsonb,finished_at=now() where tenant_id=? and delivery_id=? and operation='CREATE'",response.toString(),t,deliveryId);
    replay(t,uuid(prepared,"shippingAccountId"),deliveryId,tracking,body.path("client_order_code").asText());
    refreshOrder(t,orderId);
    return automaticResult(a,orderId);
  }
  private Object automaticResult(Authentication a,UUID orderId) {
    order(a,orderId,false);
    var deliveries=r.db.queryForList("select id,tracking,integration_status,last_error_message from retail.delivery where tenant_id=? and sales_order_id=? order by created_at",r.tenant(a),orderId);
    return Map.of("deliveries",deliveries);
  }
  /** Called only after durable Sales fulfillment; never creates or posts stock itself. */
  public Object sendSalesIssue(Authentication a,UUID orderId,UUID issueId,JsonNode input) {
    r.gate(a,"orders","CREATE");r.gate(a,"orders","RECORD_RESPONSE");order(a,orderId,false);
    var issue=r.one("document",r.tenant(a),issueId);
    if(!orderId.equals(issue.get("sales_order_id"))||!r.node(issue.get("metadata")).hasNonNull("automaticQuoteFulfillment"))
      throw problem("INVALID_SOURCE","Chỉ gửi phiếu xuất từ xác nhận báo giá");
    var existing=r.db.queryForList("select id from retail.delivery where tenant_id=? and issue_id=?",r.tenant(a),issueId);
    if(!existing.isEmpty())return dispatch(a,orderId,(UUID)existing.getFirst().get("id"),true);
    var body=((ObjectNode)input).deepCopy().put("issueId",issueId.toString());
    // Match packages to the posted issue, using the source quote line instead of trusting client issue IDs.
    var lines=r.db.queryForList("select l.id,i.source_quote_line_id from retail.line l join retail.sales_order_item i on i.tenant_id=l.tenant_id and i.id=l.sales_order_item_id where l.tenant_id=? and l.document_id=? order by l.position",r.tenant(a),issueId);
    for(var pack:body.path("items"))for(var line:lines)if(line.get("source_quote_line_id").toString().equals(pack.path("quoteLineId").asText()))
      ((ObjectNode)pack).put("issueLineId",line.get("id").toString());
    try {
      var preview=r.json.valueToTree(quote(a,orderId,body,true));
      return confirm(a,orderId,r.json.createObjectNode().put("quoteId",preview.path("quoteId").asText())
        .put("acceptedFee",preview.path("totalFee").decimalValue()).put("codAmount",preview.path("codAmount").asInt())
        .put("paymentTypeId",preview.path("paymentTypeId").asInt()),true);
    } catch(RuntimeException e) {
      // Concurrent retries can both preview; the issue lock/unique delivery constraint picks one.
      var winner=r.db.queryForList("select id from retail.delivery where tenant_id=? and issue_id=?",r.tenant(a),issueId);
      if(!winner.isEmpty())return dispatch(a,orderId,(UUID)winner.getFirst().get("id"),true);
      throw e;
    }
  }

  public Object quote(Authentication a,UUID orderId,JsonNode input) {return quote(a,orderId,input,false);}
  private Object quote(Authentication a,UUID orderId,JsonNode input,boolean automatic) {
    r.gate(a,automatic?"orders":"delivery","CREATE");
    try{return tx.execute(status->{
      var o=order(a,orderId,true);UUID t=r.tenant(a),issueId=uuid(input,"issueId"),shopId=uuid(input,"shopRecordId");
      var d=issue(a,o,issueId);var s=shop(t,shopId);
      if(!Objects.equals(d.get("warehouse_id"),s.get("warehouse_id"))||!Objects.equals(d.get("branch_id"),s.get("branch_id")))
        throw problem("SHOP_WAREHOUSE_MISMATCH","Shop GHN phải liên kết đúng chi nhánh và kho xuất hàng");
      if(!r.db.queryForList("select id from retail.delivery where tenant_id=? and issue_id=?",t,issueId).isEmpty())
        throw problem("DELIVERY_EXISTS","Phiếu xuất đã có đợt giao; mở vận đơn hiện có",HttpStatus.CONFLICT);
      var lines=goods(t,issueId,orderId);
      checkCod(t,issueId,num(input,"codAmount",BigDecimal.ZERO));
      var body=packagePayload(s,input,lines,decimal(d.get("total")));
      JsonNode preview=call(s,"/shiip/public-api/v2/shipping-order/preview",body);
      if(!preview.path("total_fee").isNumber()||preview.path("total_fee").decimalValue().signum()<0)
        throw new CarrierFailure("GHN_FEE_INVALID","GHN chưa trả phí vận chuyển hợp lệ",false);
      UUID id=UUID.randomUUID();
      r.db.update("""
        insert into retail.shipping_quote(id,tenant_id,sales_order_id,issue_id,shipping_account_id,shipping_shop_id,
          external_shop_id,environment,input_payload,request_payload,response_payload,total_fee,created_by)
        values(?,?,?,?,?,?,?,?,?::jsonb,?::jsonb,?::jsonb,?,?)
        """,id,t,orderId,issueId,s.get("shipping_account_id"),shopId,s.get("external_shop_id"),s.get("environment"),
        input.toString(),body.toString(),preview.toString(),preview.path("total_fee").decimalValue(),r.actor(a));
      return Map.of("quoteId",id,"totalFee",preview.path("total_fee"),"fee",preview.path("fee"),
        "expectedDeliveryTime",preview.path("expected_delivery_time"),"codAmount",body.path("cod_amount").asInt(),"paymentTypeId",body.path("payment_type_id").asInt(),
        "expiresInSeconds",900,"recipient",snapshotAddress(body,"to"));
    });}catch(CarrierFailure e){throw problem(e.code,e.getMessage(),HttpStatus.BAD_GATEWAY);}
  }

  public Object confirm(Authentication a,UUID orderId,JsonNode input) {return confirm(a,orderId,input,false);}
  private Object confirm(Authentication a,UUID orderId,JsonNode input,boolean automatic) {
    r.gate(a,automatic?"orders":"delivery","CREATE");
    UUID deliveryId=tx.execute(status->confirmLocal(a,orderId,input));
    return dispatch(a,orderId,deliveryId,automatic);
  }

  private UUID confirmLocal(Authentication a,UUID orderId,JsonNode input) {
    UUID quoteId=uuid(input,"quoteId"),t=r.tenant(a);
      var o=order(a,orderId,true);
      var rows=r.db.queryForList("select *,expires_at>now() valid from retail.shipping_quote where tenant_id=? and id=? and sales_order_id=? for update",t,quoteId,orderId);
      if(rows.isEmpty())throw problem("QUOTE_NOT_FOUND","Không tìm thấy báo phí",HttpStatus.NOT_FOUND);
      var q=rows.getFirst();JsonNode body=r.node(q.get("request_payload"));
      if(num(input,"acceptedFee",BigDecimal.valueOf(-1)).compareTo(decimal(q.get("total_fee")))!=0
          ||num(input,"codAmount",BigDecimal.valueOf(-1)).compareTo(body.path("cod_amount").decimalValue())!=0
          ||input.path("paymentTypeId").asInt()!=body.path("payment_type_id").asInt())
        throw problem("QUOTE_CHANGED","Phải xác nhận đúng phí, COD và người trả phí đã báo",HttpStatus.CONFLICT);
      var existing=r.db.queryForList("select delivery_id from retail.shipping_request where tenant_id=? and shipping_account_id=? and idempotency_key=?",t,q.get("shipping_account_id"),"CREATE:"+quoteId);
      if(!existing.isEmpty())return (UUID)existing.getFirst().get("delivery_id");
      if(!Boolean.TRUE.equals(q.get("valid")))throw problem("QUOTE_EXPIRED","Báo phí đã hết hạn; lấy phí lại",HttpStatus.CONFLICT);
      UUID issueId=(UUID)q.get("issue_id");var d=issue(a,o,issueId);
      var s=shop(t,(UUID)q.get("shipping_shop_id"));
      if(!Objects.equals(s.get("external_shop_id"),q.get("external_shop_id"))||!Objects.equals(s.get("environment"),q.get("environment"))
          ||!Objects.equals(s.get("warehouse_id"),d.get("warehouse_id"))||!Objects.equals(s.get("branch_id"),d.get("branch_id")))
        throw problem("SHOP_CHANGED","Liên kết shop đã thay đổi; lấy phí lại",HttpStatus.CONFLICT);
      if(!r.db.queryForList("select id from retail.delivery where tenant_id=? and issue_id=?",t,issueId).isEmpty())
        throw problem("DELIVERY_EXISTS","Phiếu xuất đã có vận đơn",HttpStatus.CONFLICT);
      var lines=goods(t,issueId,orderId);
      checkCod(t,issueId,body.path("cod_amount").decimalValue());
      UUID id=UUID.randomUUID();String code=body.path("client_order_code").asText("CRM-"+id);
      ((ObjectNode)body).put("client_order_code",code);
      r.db.update("""
        insert into retail.delivery(id,tenant_id,branch_id,issue_id,sales_order_id,carrier,shipping_account_id,
          shipping_shop_id,external_shop_id,carrier_environment,client_order_code,integration_status,cod,fee,
          recipient_name,recipient_phone,recipient_address,address_scheme,province_name,ward_name,
          weight_gram,length_cm,width_cm,height_cm,service_type_id,payment_type_id,required_note,
          insurance_value,order_value,sender_snapshot,return_snapshot)
        values(?,?,?,?,?,'GHN',?,?,?,?,?,'QUEUED',?,?,?,?,?,'VN_NEW_2_LEVEL',?,?,?,?,?,?,?,?,?,?,?,?::jsonb,?::jsonb)
        """,id,t,d.get("branch_id"),issueId,orderId,q.get("shipping_account_id"),q.get("shipping_shop_id"),
        q.get("external_shop_id"),q.get("environment"),code,body.path("cod_amount").decimalValue(),q.get("total_fee"),
        body.path("to_name").asText(),body.path("to_phone").asText(),body.path("to_address").asText(),
        body.path("to_province_name").asText(),body.path("to_ward_name").asText(),body.path("weight").asInt(),
        body.path("length").asInt(),body.path("width").asInt(),body.path("height").asInt(),
        body.path("service_type_id").asInt(),body.path("payment_type_id").asInt(),body.path("required_note").asText(),
        body.path("insurance_value").decimalValue(),body.path("order_value").decimalValue(),
        snapshotAddress(body,"from").toString(),snapshotAddress(body,"return").toString());
      int index=0;
      for(var line:lines){
        var item=body.path("items").get(index++);
        r.db.update("""
          insert into retail.delivery_item(tenant_id,delivery_id,issue_id,issue_line_id,sku_id,quantity,unit,ratio,base_qty,carrier_item_quantity,item_snapshot)
          values(?,?,?,?,?,?,?,?,?,?,?::jsonb)
          """,t,id,issueId,line.get("id"),line.get("sku_id"),line.get("qty"),line.get("unit"),line.get("ratio"),line.get("base_qty"),
          item.path("quantity").asInt(),item.toString());
      }
      r.db.update("""
        insert into retail.shipping_request(tenant_id,shipping_account_id,delivery_id,operation,idempotency_key,request_hash,request_payload)
        values(?,?,?,'CREATE',?,?,?::jsonb)
        """,t,q.get("shipping_account_id"),id,"CREATE:"+quoteId,sha256(body.toString()),body.toString());
      refreshOrder(t,orderId);
      return id;
  }

  public Object retry(Authentication a,UUID orderId,UUID deliveryId) {
    r.gate(a,"delivery","CREATE");return dispatch(a,orderId,deliveryId);
  }

  private Object dispatch(Authentication a,UUID orderId,UUID deliveryId) {return dispatch(a,orderId,deliveryId,false);}
  private Object dispatch(Authentication a,UUID orderId,UUID deliveryId,boolean automatic) {
    UUID t=r.tenant(a);
    var task=tx.execute(status->{
      var o=order(a,orderId,true);
      var list=r.db.queryForList("select * from retail.delivery where tenant_id=? and id=? and sales_order_id=? for update",t,deliveryId,orderId);
      if(list.isEmpty())throw problem("DELIVERY_NOT_FOUND","Không tìm thấy vận đơn",HttpStatus.NOT_FOUND);
      var v=list.getFirst();var d=r.one("document",t,(UUID)v.get("issue_id"));r.warehouse(a,(UUID)d.get("warehouse_id"));
      if("CREATED".equals(v.get("integration_status")))return Map.<String,Object>of();
      var requests=r.db.queryForList("select *,lease_until>now() leased from retail.shipping_request where tenant_id=? and delivery_id=? and operation='CREATE' for update",t,deliveryId);
      if(requests.isEmpty())throw problem("GHN_REQUEST_NOT_FOUND","Đợt giao không có yêu cầu tạo GHN");
      var req=requests.getFirst();
      if(Boolean.TRUE.equals(req.get("leased")))return Map.<String,Object>of();
      // Any previous attempt may have reached GHN, including an interrupted process.
      boolean lookup=((Number)req.get("attempt_count")).intValue()>0&&!"FAILED".equals(req.get("status"));
      if(!lookup){issue(a,o,(UUID)v.get("issue_id"));goods(t,(UUID)v.get("issue_id"),orderId);checkCod(t,(UUID)v.get("issue_id"),decimal(v.get("cod")));}
      var account=r.one("shipping_account",t,(UUID)v.get("shipping_account_id"));
      if(!lookup&&!Boolean.TRUE.equals(account.get("active")))throw problem("ACCOUNT_INACTIVE","Tài khoản GHN đã ngưng hoạt động");
      var credentials=new HashMap<String,Object>();
      credentials.put("credential_ref",account.get("credential_ref"));credentials.put("environment",v.get("carrier_environment"));
      credentials.put("external_shop_id",v.get("external_shop_id"));
      if(Objects.toString(account.get("credential_ref"),"").isBlank())throw problem("GHN_TOKEN_MISSING","Tài khoản thiếu token");
      r.db.update("update retail.shipping_request set status='RUNNING',attempt_count=attempt_count+1,started_at=now(),lease_until=now()+interval '90 seconds' where tenant_id=? and id=?",t,req.get("id"));
      r.db.update("update retail.delivery set integration_status='CREATING',updated_at=now() where tenant_id=? and id=?",t,deliveryId);
      return Map.of("request",req,"credentials",credentials,"lookup",lookup,"clientCode",v.get("client_order_code"));
    });
    if(task.isEmpty())return automatic?automaticResult(a,orderId):detail(a,orderId);
    @SuppressWarnings("unchecked") var req=(Map<String,Object>)task.get("request");
    @SuppressWarnings("unchecked") var credentials=(Map<String,Object>)task.get("credentials");
    boolean lookup=(Boolean)task.get("lookup");
    JsonNode response;
    try {
      response=lookup?call(credentials,UriComponentsBuilder.fromPath("/shiip/public-api/v2/shipping-order/detail-by-client-code")
        .queryParam("client_order_code",task.get("clientCode")).build().toUriString(),null)
        :call(credentials,"/shiip/public-api/v2/shipping-order/create",r.node(req.get("request_payload")));
      if(response.path("order_code").asText("").isBlank())throw new CarrierFailure("GHN_CODE_MISSING","GHN chưa trả mã vận đơn; cần tra cứu lại",true);
      if(lookup&&(!Objects.toString(task.get("clientCode")).equals(response.path("client_order_code").asText())
          ||response.path("shop_id").asLong()!=((Number)credentials.get("external_shop_id")).longValue()))
        throw new CarrierFailure("GHN_ORDER_MISMATCH","Kết quả GHN không khớp shop hoặc mã nội bộ",true);
    }catch(CarrierFailure e){
      tx.executeWithoutResult(status->{
        var v=r.db.queryForList("select integration_status from retail.delivery where tenant_id=? and id=? for update",t,deliveryId).getFirst();
        if("CREATED".equals(v.get("integration_status")))return; // A webhook can win the race.
        boolean uncertain=lookup||e.unknown;
        r.db.update("update retail.shipping_request set status=?,lease_until=null,error_message=?,carrier_error_code=? where tenant_id=? and id=?",
          uncertain?"UNKNOWN":"FAILED",e.getMessage(),e.code,t,req.get("id"));
        r.db.update("update retail.delivery set integration_status=?,last_error_code=?,last_error_message=?,updated_at=now() where tenant_id=? and id=?",
          uncertain?"UNKNOWN":"ERROR",e.code,e.getMessage(),t,deliveryId);
      });
      return automatic?automaticResult(a,orderId):detail(a,orderId);
    }
    tx.executeWithoutResult(status->{
      r.db.queryForList("select id from retail.sales_order where tenant_id=? and id=? for update",t,orderId);
      var v=r.db.queryForList("select * from retail.delivery where tenant_id=? and id=? for update",t,deliveryId).getFirst();
      String tracking=response.path("order_code").asText();
      if(!Objects.toString(v.get("tracking"),"").isBlank()&&!tracking.equals(v.get("tracking")))
        throw problem("GHN_TRACKING_CONFLICT","Mã vận đơn phản hồi không khớp mã đã nhận",HttpStatus.CONFLICT);
      r.db.update("""
        update retail.delivery set integration_status='CREATED',tracking=?,carrier_created_at=coalesce(carrier_created_at,now()),
          carrier_status=coalesce(carrier_status,'ready_to_pick'),carrier_fee_current=coalesce(carrier_fee_current,?),
          expected_delivery_at=coalesce(expected_delivery_at,?),last_error_code=null,last_error_message=null,updated_at=now()
        where tenant_id=? and id=?
        """,tracking,response.path("total_fee").isNumber()?response.path("total_fee").decimalValue():null,
        optionalTime(response.path("expected_delivery_time").asText(response.path("leadtime").asText(null))),t,deliveryId);
      r.db.update("update retail.shipping_request set status='SUCCEEDED',last_response_payload=?::jsonb,lease_until=null,finished_at=now(),error_message=null where tenant_id=? and id=?",
        response.toString(),t,req.get("id"));
      replay(t,(UUID)v.get("shipping_account_id"),deliveryId,tracking,Objects.toString(v.get("client_order_code")));
      if(lookup)recordLookupStatus(t,v,response);
      refreshOrder(t,orderId);
    });
    return automatic?automaticResult(a,orderId):detail(a,orderId);
  }

  private static Timestamp optionalTime(String value) {
    try{return value==null||value.isBlank()?null:Timestamp.from(Instant.parse(value));}
    catch(Exception ignored){return null;}
  }
  private void recordLookupStatus(UUID tenant,Map<String,Object> delivery,JsonNode response) {
    Timestamp time=optionalTime(response.path("updated_date").asText(null));
    String carrier=response.path("status").asText("");
    if(time==null||deliveryState(carrier,false)==null)return;
    var payload=r.json.createObjectNode().put("ShopID",((Number)delivery.get("external_shop_id")).longValue())
      .put("OrderCode",response.path("order_code").asText()).put("ClientOrderCode",response.path("client_order_code").asText())
      .put("Type","switch_status").put("Status",carrier).put("Time",time.toInstant().toString())
      .put("IsPartialReturn",response.path("is_partial_return").asBoolean(false));
    UUID event=UUID.randomUUID();
    String hash=sha256(payload.path("ShopID").asText()+"|"+payload.path("OrderCode").asText()+"|switch_status|"+time.toInstant());
    int inserted=r.db.update("""
      insert into retail.shipping_event(id,tenant_id,shipping_account_id,delivery_id,external_shop_id,carrier_order_code,
        client_order_code,source,event_type,carrier_status,event_time,payload,payload_hash,dedup_key)
      values(?,?,?,?,?,?,?,'MANUAL','switch_status',?,?,?::jsonb,?,?)
      on conflict(tenant_id,shipping_account_id,dedup_key) do nothing
      """,event,tenant,delivery.get("shipping_account_id"),delivery.get("id"),delivery.get("external_shop_id"),
      payload.path("OrderCode").asText(),payload.path("ClientOrderCode").asText(),carrier,time,payload.toString(),sha256(payload.toString()),hash);
    if(inserted>0)applyEvent(tenant,(UUID)delivery.get("id"),event,payload);
  }
  private void refreshOrder(UUID tenant,UUID orderId) {
    r.db.update("""
      update retail.sales_order o set shipping_status=case
        when exists(select 1 from retail.delivery d where d.tenant_id=o.tenant_id and d.sales_order_id=o.id and d.status='DELIVERED')
          and not exists(select 1 from retail.sales_order_item i where i.tenant_id=o.tenant_id and i.order_id=o.id
            and i.base_qty-i.cancelled_base_qty>coalesce((select sum(di.base_qty) from retail.delivery_item di
              join retail.delivery d on d.tenant_id=di.tenant_id and d.id=di.delivery_id
              join retail.line l on l.tenant_id=di.tenant_id and l.id=di.issue_line_id
              where di.tenant_id=i.tenant_id and l.sales_order_item_id=i.id and d.status='DELIVERED'),0)) then 'DELIVERED'
        when exists(select 1 from retail.delivery d where d.tenant_id=o.tenant_id and d.sales_order_id=o.id and d.status in ('DELIVERED','PARTIAL')) then 'PARTIAL'
        when exists(select 1 from retail.delivery d where d.tenant_id=o.tenant_id and d.sales_order_id=o.id and d.status='SHIPPING') then 'SHIPPING'
        when exists(select 1 from retail.delivery d where d.tenant_id=o.tenant_id and d.sales_order_id=o.id and d.status='FAILED') then 'FAILED'
        when exists(select 1 from retail.delivery d where d.tenant_id=o.tenant_id and d.sales_order_id=o.id) then 'PREPARING'
        else 'PENDING' end,updated_at=now() where o.tenant_id=? and o.id=?
      """,tenant,orderId);
  }

  public Object webhookSecret(Authentication a,UUID accountId) {
    if(!r.inRole(a,"ceo")&&!r.isPlatformAdmin(a))throw problem("PERMISSION_DENIED","Chỉ CEO hoặc quản trị viên hệ thống được cấu hình webhook",HttpStatus.FORBIDDEN);
    byte[] bytes=new byte[32];new SecureRandom().nextBytes(bytes);
    String secret=Base64.getUrlEncoder().withoutPadding().encodeToString(bytes);
    if(r.db.update("update retail.shipping_account set webhook_secret_ref=?,updated_at=now() where tenant_id=? and id=? and carrier_code='GHN' and active",
        "sha256:"+sha256(secret),r.tenant(a),accountId)==0)throw problem("GHN_ACCOUNT_NOT_FOUND","Không tìm thấy tài khoản GHN",HttpStatus.NOT_FOUND);
    return Map.of("path","/api/v1/webhooks/ghn/"+r.tenant(a)+"/"+accountId,"headerName","X-GHN-Webhook-Secret","secret",secret);
  }

  public Object webhook(UUID tenant,UUID accountId,String secret,JsonNode payload) {
    return tx.execute(status->{
      // Anonymous callback: select one tenant under RLS, then authenticate its account secret.
      r.db.queryForList("select set_config('core.tenant_id',?,true)",tenant.toString());
      var accounts=r.db.queryForList("select webhook_secret_ref from retail.shipping_account where tenant_id=? and id=? and carrier_code='GHN'",tenant,accountId);
      String expected=accounts.isEmpty()?"":Objects.toString(accounts.getFirst().get("webhook_secret_ref"),"");
      if(secret==null||secret.length()>256||!expected.startsWith("sha256:")||!MessageDigest.isEqual(
          expected.getBytes(StandardCharsets.UTF_8),("sha256:"+sha256(secret)).getBytes(StandardCharsets.UTF_8)))
        throw problem("INVALID_WEBHOOK_SECRET","Không xác thực được webhook",HttpStatus.UNAUTHORIZED);
      String code=required(payload,"OrderCode",100),type=required(payload,"Type",60).toLowerCase(Locale.ROOT);
      long shopId=payload.path("ShopID").asLong(0);if(shopId<=0)throw problem("INVALID_SHOP","Webhook thiếu ShopID");
      Timestamp time=optionalTime(required(payload,"Time",60));
      if(time==null||time.toInstant().isAfter(Instant.now().plusSeconds(300)))throw problem("INVALID_EVENT_TIME","Thời gian webhook không hợp lệ");
      String client=text(payload,"ClientOrderCode","");
      String dedup=sha256(shopId+"|"+code+"|"+type+"|"+time.toInstant());
      UUID id=UUID.randomUUID();
      int added=r.db.update("""
        insert into retail.shipping_event(id,tenant_id,shipping_account_id,external_shop_id,carrier_order_code,
          client_order_code,event_type,carrier_status,event_time,reason_code,reason,payload,payload_hash,dedup_key)
        values(?,?,?,?,?,?,?,?,?,?,?,?::jsonb,?,?) on conflict(tenant_id,shipping_account_id,dedup_key) do nothing
        """,id,tenant,accountId,shopId,code,client,type,text(payload,"Status",""),time,
        text(payload,"ReasonCode",""),text(payload,"Reason",""),payload.toString(),sha256(payload.toString()),dedup);
      if(added==0)return Map.of("code",200,"duplicate",true);
      var deliveries=r.db.queryForList("""
        select id from retail.delivery where tenant_id=? and shipping_account_id=? and external_shop_id=?
          and (tracking=? or (tracking='' and client_order_code=? and ?<>''))
        """,tenant,accountId,shopId,code,client,client);
      if(deliveries.size()!=1){
        r.db.update("update retail.shipping_event set processing_status='UNMATCHED' where tenant_id=? and id=?",tenant,id);
        return Map.of("code",200,"matched",false);
      }
      applyEvent(tenant,(UUID)deliveries.getFirst().get("id"),id,payload);
      return Map.of("code",200,"matched",true);
    });
  }

  private void replay(UUID tenant,UUID account,UUID delivery,String code,String client) {
    var events=r.db.queryForList("""
      select e.id,e.payload from retail.shipping_event e join retail.delivery d
        on d.tenant_id=e.tenant_id and d.shipping_account_id=e.shipping_account_id and d.external_shop_id=e.external_shop_id
      where e.tenant_id=? and e.shipping_account_id=? and d.id=? and e.processing_status='UNMATCHED'
        and (e.carrier_order_code=? or e.client_order_code=?) order by e.event_time
      """,tenant,account,delivery,code,client);
    for(var e:events)applyEvent(tenant,delivery,(UUID)e.get("id"),r.node(e.get("payload")));
  }
  static String deliveryState(String carrier,boolean partial) {
    if("delivered".equals(carrier))return partial?"PARTIAL":"DELIVERED";
    if(Set.of("ready_to_pick","picking","money_collect_picking").contains(carrier))return "PREPARING";
    if(Set.of("picked","storing","sorting","transporting","delivering","money_collect_delivering").contains(carrier))return "SHIPPING";
    if(Set.of("delivery_fail","waiting_to_return","return","return_transporting","return_sorting","returning","return_fail",
        "returned","cancel","exception","lost","damage","scrap").contains(carrier))return "FAILED";
    return null;
  }
  static boolean acceptsStatus(String previous,Timestamp previousAt,String next,Timestamp nextAt) {
    if(previousAt!=null&&!nextAt.after(previousAt))return false;
    return previous==null||!Set.of("delivered","returned","cancel","exception","lost","damage","scrap").contains(previous)||previous.equals(next);
  }
  private void applyEvent(UUID tenant,UUID deliveryId,UUID eventId,JsonNode p) {
    var reference=r.one("delivery",tenant,deliveryId);
    r.db.queryForList("select id from retail.sales_order where tenant_id=? and id=? for update",tenant,reference.get("sales_order_id"));
    var v=r.db.queryForList("select * from retail.delivery where tenant_id=? and id=? for update",tenant,deliveryId).getFirst();
    String code=p.path("OrderCode").asText(),type=p.path("Type").asText().toLowerCase(Locale.ROOT);
    if(!Objects.toString(v.get("tracking"),"").isBlank()&&!code.equals(v.get("tracking"))){
      r.db.update("update retail.shipping_event set processing_status='ERROR',last_error='TRACKING_MISMATCH' where tenant_id=? and id=?",tenant,eventId);return;
    }
    Timestamp time=optionalTime(p.path("Time").asText());
    boolean partial=p.path("IsPartialReturn").asBoolean(false)||Boolean.TRUE.equals(v.get("carrier_partial_return"));
    String carrier=p.path("Status").asText(),next=deliveryState(carrier,partial);
    r.db.update("update retail.delivery set tracking=?,integration_status='CREATED',last_error_code=null,last_error_message=null,updated_at=now() where tenant_id=? and id=?",code,tenant,deliveryId);
    Timestamp lastStatus=(Timestamp)v.get("carrier_status_at");
    if(p.path("IsPartialReturn").asBoolean(false)&&(lastStatus==null||!time.before(lastStatus)))
      r.db.update("""
        update retail.delivery set carrier_partial_return=true,partial_return_code=?,
          status=case when carrier_status='delivered' then 'PARTIAL' else status end,version=version+1
        where tenant_id=? and id=?
        """,text(p,"PartialReturnCode",""),tenant,deliveryId);
    if(Set.of("create","switch_status").contains(type)&&next!=null&&acceptsStatus((String)v.get("carrier_status"),(Timestamp)v.get("carrier_status_at"),carrier,time)){
      r.db.update("""
        update retail.delivery set carrier_status=?,carrier_status_at=?,status=?,note=?,version=version+1,
          picked_at=case when ?='picked' then coalesce(picked_at,?) else picked_at end,
          delivered_at=case when ?='delivered' then coalesce(delivered_at,?) else delivered_at end,
          returned_at=case when ?='returned' then coalesce(returned_at,?) else returned_at end,
          cancelled_at=case when ?='cancel' then coalesce(cancelled_at,?) else cancelled_at end,
          partial_return_code=?,updated_at=now() where tenant_id=? and id=?
        """,carrier,time,next,text(p,"Reason",""),carrier,time,carrier,time,carrier,time,carrier,time,text(p,"PartialReturnCode",""),tenant,deliveryId);
    }
    if(type.equals("update_fee")&&p.path("TotalFee").isNumber()&&p.path("TotalFee").decimalValue().signum()>=0)
      r.db.update("update retail.delivery set carrier_fee_current=?,carrier_fee_breakdown=?::jsonb,carrier_fee_at=? where tenant_id=? and id=? and (carrier_fee_at is null or carrier_fee_at<?)",
        p.path("TotalFee").decimalValue(),p.path("Fee").isObject()?p.path("Fee").toString():"{}",time,tenant,deliveryId,time);
    if(type.equals("update_cod")&&p.path("CODAmount").isNumber()&&p.path("CODAmount").decimalValue().signum()>=0)
      r.db.update("update retail.delivery set carrier_cod_amount=?,carrier_cod_at=?,settlement_status='DISPUTED' where tenant_id=? and id=? and (carrier_cod_at is null or carrier_cod_at<?)",
        p.path("CODAmount").decimalValue(),time,tenant,deliveryId,time);
    // Callback success is not a bank receipt or a warehouse return. Finance/stock keep their approval flows.
    r.db.update("update retail.shipping_request set status='SUCCEEDED',lease_until=null,finished_at=coalesce(finished_at,now()),error_message=null where tenant_id=? and delivery_id=? and operation='CREATE'",tenant,deliveryId);
    r.db.update("update retail.shipping_event set delivery_id=?,processing_status='PROCESSED',processed_at=now(),attempts=attempts+1 where tenant_id=? and id=?",deliveryId,tenant,eventId);
    refreshOrder(tenant,(UUID)v.get("sales_order_id"));
  }
}

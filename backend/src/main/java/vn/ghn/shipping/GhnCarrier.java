package vn.ghn.shipping;

import com.fasterxml.jackson.databind.*;
import com.fasterxml.jackson.databind.node.*;
import java.net.URI;
import java.net.http.*;
import java.time.Duration;
import java.util.*;
import static vn.ghn.shipping.JsonSupport.*;

public class GhnCarrier implements Carrier {
  protected final ObjectMapper json;
  private final HttpClient http;
  public GhnCarrier(ObjectMapper json) { this(json,HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(10)).followRedirects(HttpClient.Redirect.NEVER).build()); }
  GhnCarrier(ObjectMapper json,HttpClient http) { this.json=json;this.http=http; }
  protected JsonNode call(ServiceConfig.Shop shop,String path,JsonNode payload) {
    String origin = shop.environment().equals("STAGING") ? "https://dev-online-gateway.ghn.vn" : "https://online-gateway.ghn.vn";
    var builder = HttpRequest.newBuilder(URI.create(origin+path)).timeout(Duration.ofSeconds(25))
      .header("Token",shop.token()).header("ShopId",Long.toString(shop.shopId())).header("Content-Type","application/json");
    if (payload==null) builder.GET(); else builder.POST(HttpRequest.BodyPublishers.ofString(write(json,payload)));
    HttpResponse<String> response;
    try { response=http.send(builder.build(),HttpResponse.BodyHandlers.ofString()); }
    catch (InterruptedException e) { Thread.currentThread().interrupt(); throw new CarrierFailure("GHN_UNAVAILABLE",true); }
    catch (Exception e) { throw new CarrierFailure("GHN_UNAVAILABLE",true); }
    int status=response.statusCode();
    if (status<200 || status>=300) throw new CarrierFailure("GHN_HTTP_"+status,status>=500 || Set.of(408,429).contains(status));
    JsonNode result;
    try { result=json.readTree(response.body()); } catch(Exception e) { throw new CarrierFailure("GHN_INVALID_RESPONSE",true); }
    if (result==null || !result.path("code").isIntegralNumber()) throw new CarrierFailure("GHN_INVALID_RESPONSE",true);
    if (result.path("code").asInt()!=200) throw new CarrierFailure("GHN_REJECTED",result.path("code").asInt()>=500);
    if (!result.hasNonNull("data")) throw new CarrierFailure("GHN_INVALID_RESPONSE",true);
    return result.path("data");
  }
  @Override public JsonNode locations(ServiceConfig.Shop shop,Long province) {
    var rows=json.createArrayNode();
    for (int offset=0;offset<10000;offset+=200) {
      String path=province==null ? "/shiip/public-api/v3/master-data/province/all?" : "/shiip/public-api/v3/master-data/ward/all-by-province-id?province_id="+province+"&";
      var data=call(shop,path+"offset="+offset+"&limit=200",null);
      if (!data.isArray()) throw new CarrierFailure("GHN_INVALID_RESPONSE",true);
      for(var row:data) if (!row.has("status") || row.path("status").asInt()==1) rows.add(row);
      if(data.size()<200)return rows;
    }
    throw new CarrierFailure("GHN_LOCATION_LIMIT",true);
  }
  private JsonNode resolved(ServiceConfig.Shop shop,JsonNode address) {
    JsonNode province=null,ward=null;
    for(var row:locations(shop,null))if(row.path("_id").asLong()==address.path("provinceId").asLong())province=row;
    if(province==null)throw new ApiProblem(400,"INVALID_PROVINCE");
    for(var row:locations(shop,address.path("provinceId").asLong()))if(row.path("_id").asLong()==address.path("wardId").asLong())ward=row;
    if(ward==null)throw new ApiProblem(400,"INVALID_WARD");
    return ((ObjectNode)address.deepCopy()).put("provinceName",province.path("name").asText()).put("wardName",ward.path("name").asText());
  }
  @Override public JsonNode payload(ServiceConfig.Shop shop,JsonNode input,String id) {
    var out=json.createObjectNode().put("client_order_code",id);
    for(String key:List.of("weight","length","width","height","note","items"))out.set(key,input.path(key));
    for(String key:List.of("codAmount","insuranceValue","serviceTypeId","paymentTypeId","requiredNote")) {
      String target=key.replaceAll("([a-z])([A-Z])","$1_$2").toLowerCase(Locale.ROOT);out.set(target,input.path(key));
    }
    var addresses=Map.of("from",shop.sender(),"return",shop.returnAddress()==null?shop.sender():shop.returnAddress(),"to",input.path("recipient"));
    addresses.forEach((prefix,value)->{
      var a=resolved(shop,value);
      for(String key:List.of("name","phone","address"))out.set(prefix+"_"+key,a.path(key));
      out.put(prefix+"_province_name",a.path("provinceName").asText()).put(prefix+"_ward_name",a.path("wardName").asText()).put("is_new_"+prefix+"_address",true);
    });
    return out;
  }
  @Override public JsonNode create(ServiceConfig.Shop shop,JsonNode payload){return call(shop,"/shiip/public-api/v2/shipping-order/create",payload);}
  @Override public JsonNode preview(ServiceConfig.Shop shop,JsonNode payload){return call(shop,"/shiip/public-api/v2/shipping-order/preview",payload);}
  @Override public JsonNode lookup(ServiceConfig.Shop shop,String id){return call(shop,"/shiip/public-api/v2/shipping-order/detail-by-client-code?client_order_code="+java.net.URLEncoder.encode(id,java.nio.charset.StandardCharsets.UTF_8),null);}
}

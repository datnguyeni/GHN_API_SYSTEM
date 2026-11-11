package vn.ghn.shipping;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.*;
import java.util.Set;
import static vn.ghn.shipping.JsonSupport.*;

final class Contract {
  static ObjectNode address(JsonNode input) {
    var out = JsonNodeFactory.instance.objectNode();
    String phone = text(input, "phone", 20).replace(" ", "").replace("-", "");
    if (!phone.matches("(0|\\+84)[0-9]{9,10}")) throw new ApiProblem(400, "INVALID_PHONE");
    return out.put("name", text(input,"name",250)).put("phone",phone).put("address",text(input,"address",1024))
      .put("provinceId",integer(input,"provinceId",1,9007199254740991L)).put("wardId",integer(input,"wardId",1,9007199254740991L));
  }
  static ObjectNode normalize(JsonNode input, ServiceConfig.Shop shop) {
    if (!input.isObject()) throw new ApiProblem(400,"INVALID_JSON");
    var n = input.deepCopy();
    if (!n.has("serviceTypeId")) ((ObjectNode)n).put("serviceTypeId",2);
    if (!n.has("paymentTypeId")) ((ObjectNode)n).put("paymentTypeId",1);
    long service = integer(n,"serviceTypeId",2,5), weight = integer(n,"weight",1,50000);
    if (!Set.of(2L,5L).contains(service) || weight >= 20000 && service != 5) throw new ApiProblem(400,"INVALID_SERVICE");
    String note = n.has("requiredNote") ? text(n,"requiredNote",40) : "CHOXEMHANGKHONGTHU";
    if (!Set.of("KHONGCHOXEMHANG","CHOXEMHANGKHONGTHU","CHOTHUHANG").contains(note)) throw new ApiProblem(400,"INVALID_REQUIRED_NOTE");
    var out = JsonNodeFactory.instance.objectNode();
    out.put("referenceCode",text(n,"referenceCode",100)).put("shopCode",shop.code());
    out.set("recipient",address(n.path("recipient")));
    out.put("weight",weight);
    for (String key : new String[]{"length","width","height"}) out.put(key,integer(n,key,1,200));
    out.put("codAmount",integer(n,"codAmount",0,50000000)).put("insuranceValue",integer(n,"insuranceValue",0,5000000))
      .put("serviceTypeId",service).put("paymentTypeId",integer(n,"paymentTypeId",1,2)).put("requiredNote",note);
    if (n.has("note") && (!n.path("note").isTextual() || n.path("note").asText().length() > 5000)) throw new ApiProblem(400,"INVALID_NOTE");
    out.put("note",n.path("note").asText(""));
    var items = n.path("items");
    if (!items.isArray() || items.isEmpty() || items.size() > 100) throw new ApiProblem(400,"INVALID_ITEMS");
    var packed = out.putArray("items"); long totalWeight = 0;
    for (var row : items) {
      var item = packed.addObject().put("name",text(row,"name",250)).put("quantity",integer(row,"quantity",1,10000));
      if (service == 5) {
        for (String key : new String[]{"weight","length","width","height"}) item.put(key,integer(row,key,1,key.equals("weight")?50000:200));
        totalWeight += item.path("quantity").asLong() * item.path("weight").asLong();
      }
    }
    if (service == 5 && totalWeight != weight) throw new ApiProblem(400,"INVALID_PACKAGE_WEIGHT");
    return out;
  }
}

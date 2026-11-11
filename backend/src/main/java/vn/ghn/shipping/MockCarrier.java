package vn.ghn.shipping;

import com.fasterxml.jackson.databind.*;
import java.time.Instant;

public class MockCarrier extends GhnCarrier {
  public MockCarrier(ObjectMapper json) { super(json); }
  @Override public JsonNode locations(ServiceConfig.Shop shop,Long province) {
    return json.createArrayNode().add(json.createObjectNode().put("_id",province==null?1000001:2000001).put("name",province==null?"Tỉnh demo":"Phường demo").put("status",1));
  }
  @Override public JsonNode create(ServiceConfig.Shop shop,JsonNode payload) {
    return json.createObjectNode().put("order_code","DEMO-"+payload.path("client_order_code").asText()).put("total_fee",32000)
      .put("expected_delivery_time",JsonSupport.iso(Instant.now().plusSeconds(259200))).put("status","ready_to_pick");
  }
  @Override public JsonNode preview(ServiceConfig.Shop shop,JsonNode payload){return json.createObjectNode().put("total_fee",32000);}
  @Override public JsonNode lookup(ServiceConfig.Shop shop,String id){return json.createObjectNode().put("order_code","DEMO-"+id).put("status","ready_to_pick");}
}

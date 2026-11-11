package vn.ghn.shipping;

import com.fasterxml.jackson.databind.JsonNode;

public interface Carrier {
  JsonNode locations(ServiceConfig.Shop shop, Long province);
  JsonNode payload(ServiceConfig.Shop shop, JsonNode input, String id);
  JsonNode create(ServiceConfig.Shop shop, JsonNode payload);
  JsonNode preview(ServiceConfig.Shop shop, JsonNode payload);
  JsonNode lookup(ServiceConfig.Shop shop, String id);
}

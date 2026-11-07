package vn.aicrm.shipping;

import com.fasterxml.jackson.databind.JsonNode;
import java.util.UUID;
import org.springframework.security.core.Authentication;
import org.springframework.web.bind.annotation.*;

@RestController
public class GhnOrderController {
  private final GhnOrderService service;
  public GhnOrderController(GhnOrderService service) { this.service=service; }

  @GetMapping("/api/v1/retail/shipping/ghn/orders")
  public Object orders(Authentication a) { return service.orders(a); }

  @GetMapping("/api/v1/retail/shipping/ghn/orders/{orderId}")
  public Object detail(Authentication a,@PathVariable UUID orderId) { return service.detail(a,orderId); }

  @PostMapping("/api/v1/retail/shipping/ghn/orders/{orderId}/quote")
  public Object quote(Authentication a,@PathVariable UUID orderId,@RequestBody JsonNode body) {
    return service.quote(a,orderId,body);
  }

  @PostMapping("/api/v1/retail/shipping/ghn/orders/{orderId}/confirm")
  public Object confirm(Authentication a,@PathVariable UUID orderId,@RequestBody JsonNode body) {
    return service.confirm(a,orderId,body);
  }

  @PostMapping("/api/v1/retail/shipping/ghn/orders/{orderId}/deliveries/{deliveryId}/retry")
  public Object retry(Authentication a,@PathVariable UUID orderId,@PathVariable UUID deliveryId) {
    return service.retry(a,orderId,deliveryId);
  }

  @GetMapping("/api/v1/retail/shipping/ghn/orders/{orderId}/shops/{shopId}/provinces")
  public Object provinces(Authentication a,@PathVariable UUID orderId,@PathVariable UUID shopId) {
    return service.locations(a,orderId,shopId,null);
  }

  @GetMapping("/api/v1/retail/shipping/ghn/orders/{orderId}/shops/{shopId}/provinces/{provinceId}/wards")
  public Object wards(Authentication a,@PathVariable UUID orderId,@PathVariable UUID shopId,@PathVariable long provinceId) {
    return service.locations(a,orderId,shopId,provinceId);
  }

  @PostMapping("/api/v1/retail/shipping/ghn/accounts/{accountId}/webhook-secret")
  public Object webhookSecret(Authentication a,@PathVariable UUID accountId) {
    return service.webhookSecret(a,accountId);
  }

  @PostMapping("/api/v1/webhooks/ghn/{tenantId}/{accountId}")
  public Object webhook(@PathVariable UUID tenantId,@PathVariable UUID accountId,
      @RequestHeader(value="X-GHN-Webhook-Secret",required=false) String secret,@RequestBody JsonNode body) {
    return service.webhook(tenantId,accountId,secret,body);
  }
}

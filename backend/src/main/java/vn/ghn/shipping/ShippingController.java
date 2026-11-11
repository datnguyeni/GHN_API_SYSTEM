package vn.ghn.shipping;

import com.fasterxml.jackson.databind.JsonNode;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

@RestController
public class ShippingController {
  private final ShippingService service;
  private final OutboundWebhooks webhooks;
  public ShippingController(ShippingService service,OutboundWebhooks webhooks){this.service=service;this.webhooks=webhooks;}
  @GetMapping("/health") public Object health(){return JsonSupport.map("status","ok","mode",service.config.mode());}
  @GetMapping("/internal/shipping/ghn/shops") public Object shops(@RequestAttribute("client") ServiceConfig.Client client){return service.shops(client);}
  @GetMapping("/internal/shipping/ghn/shops/{code}/provinces") public Object provinces(@RequestAttribute("client") ServiceConfig.Client client,@PathVariable String code){return service.carrier.locations(service.shop(client,code),null);}
  @GetMapping("/internal/shipping/ghn/shops/{code}/wards") public Object wards(@RequestAttribute("client") ServiceConfig.Client client,@PathVariable String code,@RequestParam long provinceId){
    if(provinceId<=0 || provinceId>9007199254740991L)throw new ApiProblem(400,"INVALID_FIELD");return service.carrier.locations(service.shop(client,code),provinceId);
  }
  @PostMapping(value="/internal/shipping/ghn/preview",consumes="application/json") public Object preview(@RequestAttribute("client") ServiceConfig.Client client,@RequestBody JsonNode body){return service.preview(client,body);}
  @PostMapping(value="/internal/shipping/ghn/create-order",consumes="application/json") public ResponseEntity<?> create(@RequestAttribute("client") ServiceConfig.Client client,@RequestHeader(value="Idempotency-Key",required=false) String key,@RequestBody JsonNode body){
    var result=service.create(client,key,body);return ResponseEntity.status(result.status()).body(result.body());
  }
  @GetMapping("/internal/shipping/ghn/shipments") public Object list(@RequestAttribute("client") ServiceConfig.Client client,@RequestParam(required=false) String referenceCode){return service.list(client,referenceCode);}
  @GetMapping("/internal/shipping/ghn/shipments/{id}") public Object shipment(@RequestAttribute("client") ServiceConfig.Client client,@PathVariable String id){return service.get(client,id);}
  @PostMapping("/internal/shipping/ghn/shipments/{id}/reconcile") public Object reconcile(@RequestAttribute("client") ServiceConfig.Client client,@PathVariable String id){return service.reconcile(client,id);}
  @GetMapping("/internal/shipping/ghn/webhook") public Object settings(@RequestAttribute("client") ServiceConfig.Client client){return webhooks.info(client);}
  @GetMapping("/internal/shipping/ghn/webhook/deliveries") public Object deliveries(@RequestAttribute("client") ServiceConfig.Client client){return webhooks.deliveries(client);}
  @PostMapping("/internal/shipping/ghn/webhook/deliveries/{id}/retry") public ResponseEntity<?> retry(@RequestAttribute("client") ServiceConfig.Client client,@PathVariable String id){return ResponseEntity.accepted().body(webhooks.replay(client,id));}
  @PostMapping(value="/webhooks/ghn/{shopCode}",consumes="application/json") public Object webhook(@PathVariable String shopCode,@RequestHeader(value="X-GHN-Webhook-Secret",required=false) String secret,@RequestBody JsonNode body){return service.webhook(shopCode,secret,body);}
}

package vn.aicrm.shipping;

import com.fasterxml.jackson.databind.JsonNode;
import java.util.Map;
import java.util.UUID;
import org.springframework.security.core.Authentication;
import org.springframework.web.bind.annotation.*;
import vn.aicrm.shared.RetailAccess;

@RestController
@RequestMapping("/api/v1/retail/shipping/ghn")
public class GhnShippingController {
  private final RetailAccess access;
  private final GhnShippingService service;

  public GhnShippingController(RetailAccess access, GhnShippingService service) {
    this.access = access;
    this.service = service;
  }

  @GetMapping("/accounts")
  public Object accounts(Authentication authentication) {
    requireConfigRole(authentication);
    return service.accounts(authentication);
  }

  @GetMapping("/accounts/{accountId}/shops/{shopRecordId}")
  public Object shopDetails(Authentication authentication, @PathVariable UUID accountId,
      @PathVariable UUID shopRecordId) {
    requireConfigRole(authentication);
    return service.shopDetails(authentication, accountId, shopRecordId);
  }

  @GetMapping("/accounts/{accountId}/shops/{shopRecordId}/provinces")
  public Object provinces(Authentication authentication, @PathVariable UUID accountId,
      @PathVariable UUID shopRecordId) {
    requireConfigRole(authentication);
    return service.provinces(authentication, accountId, shopRecordId);
  }

  @GetMapping("/accounts/{accountId}/shops/{shopRecordId}/provinces/{provinceId}/wards")
  public Object wards(Authentication authentication, @PathVariable UUID accountId,
      @PathVariable UUID shopRecordId, @PathVariable long provinceId) {
    requireConfigRole(authentication);
    return service.wards(authentication, accountId, shopRecordId, provinceId);
  }

  @PostMapping("/import")
  public Object importAccount(Authentication authentication, @RequestBody ImportRequest request) {
    requireConfigRole(authentication);
    return service.importAccount(authentication, request);
  }

  @PutMapping("/accounts/{accountId}/shops/{shopRecordId}")
  public Object updateCredentials(Authentication authentication, @PathVariable UUID accountId,
      @PathVariable UUID shopRecordId,
      @RequestBody UpdateCredentialsRequest request) {
    requireConfigRole(authentication);
    return service.updateCredentials(authentication, accountId, shopRecordId, request);
  }

  @DeleteMapping("/accounts/{accountId}")
  public Object deleteAccount(Authentication authentication, @PathVariable UUID accountId) {
    requireConfigRole(authentication);
    return service.deleteAccount(authentication, accountId);
  }

  private void requireConfigRole(Authentication authentication) {
    if (!access.inRole(authentication, "ceo") && !access.isPlatformAdmin(authentication))
      throw vn.aicrm.shared.RetailAccess.problem("PERMISSION_DENIED", "Chỉ CEO hoặc quản trị viên hệ thống cao nhất được cấu hình GHN",
          org.springframework.http.HttpStatus.FORBIDDEN);
  }

  public record ImportRequest(
      String name,
      String environment,
      String token,
      Long shopId,
      String shopName,
      UUID branchId,
      UUID warehouseId,
      JsonNode sender,
      JsonNode returnAddress,
      Integer defaultServiceTypeId,
      Integer defaultPaymentTypeId,
      String defaultRequiredNote,
      Boolean isDefault) {}

  public record UpdateCredentialsRequest(String token, Long shopId, UUID branchId, UUID warehouseId,
      JsonNode sender, JsonNode returnAddress) {}
}

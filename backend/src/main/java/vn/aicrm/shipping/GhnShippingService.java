package vn.aicrm.shipping;

import java.util.Map;
import java.util.List;
import java.util.UUID;
import java.net.URI;
import com.fasterxml.jackson.annotation.JsonProperty;
import org.springframework.core.ParameterizedTypeReference;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.client.RestClient;
import org.springframework.web.client.RestClientResponseException;
import org.springframework.web.util.UriComponentsBuilder;
import vn.aicrm.shared.RetailAccess;
import static vn.aicrm.shared.RetailAccess.problem;

@Service
public class GhnShippingService {
  private final RetailAccess access;
  private final JdbcTemplate jdbc;
  private final RestClient http = RestClient.create();

  public GhnShippingService(RetailAccess access, JdbcTemplate jdbc) {
    this.access = access;
    this.jdbc = jdbc;
  }

  public Object accounts(org.springframework.security.core.Authentication authentication) {
    UUID tenantId = access.tenant(authentication);
    var accounts = jdbc.queryForList("select a.id account_id,a.name,a.environment,a.active account_active,"
        + "s.id shop_record_id,s.external_shop_id shop_id,s.shop_name,s.branch_id,b.name branch_name,"
        + "s.warehouse_id,w.name warehouse_name,s.is_default,s.active shop_active,"
        + "s.sender_snapshot::text sender_snapshot,s.return_snapshot::text return_snapshot,"
        + "(a.credential_ref is not null and a.credential_ref<>'') token_configured "
        + "from retail.shipping_account a left join retail.shipping_shop s on s.tenant_id=a.tenant_id and s.shipping_account_id=a.id "
        + "left join retail.branch b on b.tenant_id=s.tenant_id and b.id=s.branch_id "
        + "left join retail.warehouse w on w.tenant_id=s.tenant_id and w.id=s.warehouse_id "
        + "where a.tenant_id=? and a.carrier_code='GHN' and a.active and (s.id is null or s.active) order by a.created_at desc,s.shop_name", tenantId);
    return Map.of("accounts", accounts,
        "branches", jdbc.queryForList("select id,name,code from retail.branch where tenant_id=? and active order by name", tenantId),
        "warehouses", jdbc.queryForList("select id,name,code,branch_id from retail.warehouse where tenant_id=? and active order by name", tenantId));
  }

  public Object shopDetails(org.springframework.security.core.Authentication authentication,
      UUID accountId, UUID shopRecordId) {
    UUID tenantId = access.tenant(authentication);
    var rows = jdbc.queryForList("select a.id account_id,a.name,a.environment,a.active account_active,"
        + "(a.credential_ref is not null and a.credential_ref<>'') token_configured,"
        + "s.id shop_record_id,s.external_shop_id shop_id,s.shop_name,s.branch_id,b.name branch_name,"
        + "s.warehouse_id,w.name warehouse_name,s.sender_snapshot::text sender_snapshot,"
        + "s.return_snapshot::text return_snapshot,s.default_service_type_id,s.default_payment_type_id,"
        + "s.default_required_note,s.is_default,s.active shop_active,s.created_at,s.updated_at "
        + "from retail.shipping_account a join retail.shipping_shop s on s.tenant_id=a.tenant_id and s.shipping_account_id=a.id "
        + "left join retail.branch b on b.tenant_id=s.tenant_id and b.id=s.branch_id "
        + "left join retail.warehouse w on w.tenant_id=s.tenant_id and w.id=s.warehouse_id "
        + "where a.tenant_id=? and a.id=? and s.id=? and a.carrier_code='GHN' and a.active and s.active",
        tenantId, accountId, shopRecordId);
    if (rows.isEmpty())
      throw problem("GHN_SHOP_NOT_FOUND", "Không tìm thấy shop GHN đang hoạt động", HttpStatus.NOT_FOUND);
    return rows.get(0);
  }

  public Object provinces(org.springframework.security.core.Authentication authentication, UUID accountId, UUID shopRecordId) {
    GhnCredential credential = credential(access.tenant(authentication), accountId, shopRecordId);
    URI uri = UriComponentsBuilder.fromUriString(baseUrl(credential.environment())
        + "/shiip/public-api/v3/master-data/province/all").queryParam("offset", 0).queryParam("limit", 200).build().toUri();
    return fetchAddresses(uri, credential);
  }

  public Object wards(org.springframework.security.core.Authentication authentication, UUID accountId,
      UUID shopRecordId, long provinceId) {
    if (provinceId <= 0) throw problem("INVALID_PROVINCE_ID", "provinceId phải lớn hơn 0", HttpStatus.BAD_REQUEST);
    GhnCredential credential = credential(access.tenant(authentication), accountId, shopRecordId);
    URI uri = UriComponentsBuilder.fromUriString(baseUrl(credential.environment())
        + "/shiip/public-api/v3/master-data/ward/all-by-province-id").queryParam("province_id", provinceId)
        .queryParam("offset", 0).queryParam("limit", 200).build().toUri();
    return fetchAddresses(uri, credential);
  }

  private GhnCredential credential(UUID tenantId, UUID accountId, UUID shopRecordId) {
    var found = jdbc.query("select a.credential_ref,a.environment,s.external_shop_id from retail.shipping_account a "
        + "join retail.shipping_shop s on s.tenant_id=a.tenant_id and s.shipping_account_id=a.id "
        + "where a.tenant_id=? and a.id=? and s.id=? and a.carrier_code='GHN' and a.active and s.active",
        rs -> rs.next() ? new GhnCredential(rs.getString("credential_ref"), rs.getString("environment"), rs.getLong("external_shop_id")) : null,
        tenantId, accountId, shopRecordId);
    if (found == null) throw problem("GHN_SHOP_NOT_FOUND", "Không tìm thấy shop GHN đang hoạt động", HttpStatus.NOT_FOUND);
    if (found.token() == null || found.token().isBlank()) throw problem("GHN_TOKEN_MISSING", "Tài khoản GHN chưa có token", HttpStatus.BAD_REQUEST);
    return found;
  }

  private List<GhnLocation> fetchAddresses(URI uri, GhnCredential credential) {
    try {
      GhnEnvelope<List<GhnLocation>> response = http.get().uri(uri)
          .header("Token", credential.token()).header("ShopId", Long.toString(credential.shopId()))
          .retrieve().body(new ParameterizedTypeReference<>() {});
      if (response == null || response.code() != 200)
        throw problem("GHN_ADDRESS_API_ERROR", "GHN không trả được danh mục địa chỉ", HttpStatus.BAD_GATEWAY);
      return response.data() == null ? List.of() : response.data().stream().filter(row -> row.status() == null || row.status() == 1).toList();
    } catch (RestClientResponseException ex) {
      throw problem("GHN_ADDRESS_API_ERROR", "GHN trả lỗi khi lấy danh mục địa chỉ (HTTP " + ex.getStatusCode().value() + ")", HttpStatus.BAD_GATEWAY);
    } catch (org.springframework.web.client.ResourceAccessException ex) {
      throw problem("GHN_UNAVAILABLE", "Không kết nối được dịch vụ địa chỉ GHN", HttpStatus.BAD_GATEWAY);
    }
  }

  private static String baseUrl(String environment) {
    return "STAGING".equalsIgnoreCase(environment)
        ? "https://dev-online-gateway.ghn.vn" : "https://online-gateway.ghn.vn";
  }

  private record GhnCredential(String token, String environment, long shopId) {}
  private record GhnEnvelope<T>(int code, String message, T data) {}
  private record GhnLocation(@JsonProperty("_id") long id, String name,
      @JsonProperty("extension_names") List<String> extensionNames, String type,
      @JsonProperty("parent_id") Long parentId, Integer status) {}

  @Transactional
  public Object importAccount(org.springframework.security.core.Authentication authentication,
      GhnShippingController.ImportRequest request) {
    UUID tenantId = access.tenant(authentication);
    String name = required(request.name(), "name");
    String environment = required(request.environment(), "environment").toUpperCase();
    if (!environment.equals("STAGING") && !environment.equals("PRODUCTION"))
      throw problem("INVALID_ENVIRONMENT", "environment phải là STAGING hoặc PRODUCTION", HttpStatus.BAD_REQUEST);
    String token = required(request.token(), "token");
    if (request.shopId() == null || request.shopId() <= 0)
      throw problem("INVALID_SHOP_ID", "shopId phải lớn hơn 0", HttpStatus.BAD_REQUEST);
    if (request.branchId() == null || request.warehouseId() == null)
      throw problem("BRANCH_WAREHOUSE_REQUIRED", "Cần branchId và warehouseId", HttpStatus.BAD_REQUEST);
    if (request.sender() == null || !request.sender().isObject() || request.returnAddress() == null || !request.returnAddress().isObject())
      throw problem("SENDER_REQUIRED", "sender và returnAddress phải là object", HttpStatus.BAD_REQUEST);
    validateMapping(tenantId, request.branchId(), request.warehouseId());

    String shopName = required(request.shopName(), "shopName");
    UUID accountId = UUID.randomUUID();
    jdbc.update("insert into retail.shipping_account(id,tenant_id,carrier_code,name,environment,credential_ref) values(?,?,'GHN',?,?,?)",
        accountId, tenantId, name, environment, token);
    UUID shopRecordId = UUID.randomUUID();
    jdbc.update("insert into retail.shipping_shop(id,tenant_id,shipping_account_id,branch_id,warehouse_id,external_shop_id,shop_name,sender_snapshot,return_snapshot,default_service_type_id,default_payment_type_id,default_required_note,is_default) values(?,?,?,?,?,?,?,?::jsonb,?::jsonb,?,?,?,?)",
        shopRecordId, tenantId, accountId, request.branchId(), request.warehouseId(), request.shopId(),
        shopName, request.sender().toString(), request.returnAddress().toString(),
        request.defaultServiceTypeId(), request.defaultPaymentTypeId(), request.defaultRequiredNote(),
        Boolean.TRUE.equals(request.isDefault()));
    return Map.of("accountId", accountId, "shopRecordId", shopRecordId, "carrier", "GHN",
        "environment", environment, "shopId", request.shopId(), "shopName", shopName);
  }

  @Transactional
  public Object updateCredentials(org.springframework.security.core.Authentication authentication,
      UUID accountId, UUID shopRecordId, GhnShippingController.UpdateCredentialsRequest request) {
    UUID tenantId = access.tenant(authentication);
    if (request.shopId() == null || request.shopId() <= 0)
      throw problem("INVALID_SHOP_ID", "shopId phải lớn hơn 0", HttpStatus.BAD_REQUEST);
    if (request.branchId() == null || request.warehouseId() == null)
      throw problem("BRANCH_WAREHOUSE_REQUIRED", "Cần branchId và warehouseId", HttpStatus.BAD_REQUEST);
    if (request.sender() != null && !request.sender().isObject() || request.returnAddress() != null && !request.returnAddress().isObject())
      throw problem("INVALID_ADDRESS", "Thông tin người gửi và hoàn hàng phải là object", HttpStatus.BAD_REQUEST);
    validateMapping(tenantId, request.branchId(), request.warehouseId());
    int accounts;
    if (request.token() != null && !request.token().isBlank())
      accounts = jdbc.update("update retail.shipping_account set credential_ref=?,updated_at=now() where tenant_id=? and id=? and carrier_code='GHN' and active",
          request.token().trim(), tenantId, accountId);
    else
      accounts = jdbc.queryForObject("select count(*) from retail.shipping_account where tenant_id=? and id=? and carrier_code='GHN' and active",
          Integer.class, tenantId, accountId);
    if (accounts == 0) throw problem("GHN_ACCOUNT_NOT_FOUND", "Không tìm thấy tài khoản GHN", HttpStatus.NOT_FOUND);
    int shops = jdbc.update("update retail.shipping_shop set external_shop_id=?,branch_id=?,warehouse_id=?,sender_snapshot=coalesce(?::jsonb,sender_snapshot),return_snapshot=coalesce(?::jsonb,return_snapshot),updated_at=now() where tenant_id=? and shipping_account_id=? and id=? and active",
        request.shopId(), request.branchId(), request.warehouseId(), request.sender()==null?null:request.sender().toString(),
        request.returnAddress()==null?null:request.returnAddress().toString(), tenantId, accountId, shopRecordId);
    if (shops == 0) throw problem("GHN_SHOP_NOT_FOUND", "Tài khoản chưa có shop GHN", HttpStatus.NOT_FOUND);
    return Map.of("accountId", accountId, "shopId", request.shopId(), "updated", true);
  }

  @Transactional
  public Object deleteAccount(org.springframework.security.core.Authentication authentication, UUID accountId) {
    UUID tenantId = access.tenant(authentication);
    int changed = jdbc.update("update retail.shipping_account set active=false,updated_at=now() where tenant_id=? and id=? and carrier_code='GHN' and active",
        tenantId, accountId);
    if (changed == 0) throw problem("GHN_ACCOUNT_NOT_FOUND", "Không tìm thấy tài khoản GHN đang hoạt động", HttpStatus.NOT_FOUND);
    jdbc.update("update retail.shipping_shop set active=false,is_default=false,updated_at=now() where tenant_id=? and shipping_account_id=? and active",
        tenantId, accountId);
    return Map.of("accountId", accountId, "deleted", true);
  }

  private static String required(String value, String field) {
    if (value == null || value.isBlank())
      throw problem("REQUIRED_FIELD", field + " không được để trống", HttpStatus.BAD_REQUEST);
    return value.trim();
  }

  private void validateMapping(UUID tenantId, UUID branchId, UUID warehouseId) {
    if (!Boolean.TRUE.equals(jdbc.queryForObject("select exists(select 1 from retail.branch where tenant_id=? and id=? and active)",
        Boolean.class, tenantId, branchId)))
      throw problem("INVALID_BRANCH", "Chi nhánh không tồn tại hoặc đã ngưng hoạt động", HttpStatus.BAD_REQUEST);
    Boolean validWarehouse = jdbc.queryForObject("select exists(select 1 from retail.warehouse where tenant_id=? and id=? and branch_id=? and active)",
        Boolean.class, tenantId, warehouseId, branchId);
    if (!Boolean.TRUE.equals(validWarehouse))
      throw problem("WAREHOUSE_BRANCH_MISMATCH", "Kho không hoạt động hoặc không thuộc chi nhánh đã chọn", HttpStatus.BAD_REQUEST);
  }
}

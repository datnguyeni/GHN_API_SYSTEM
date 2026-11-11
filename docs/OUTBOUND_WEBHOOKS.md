# GHN Service → CRM webhook

Webhook được cấu hình riêng trong `clients[].webhook` của `GHN_CONFIG_FILE`. Xem cấu hình mẫu trong [README](../README.md#cấu-hình-webhook-gửi-về-crm). Không có URL CRM mặc định; `enabled: false` không gửi HTTP ra ngoài. Bật sau khi có URL và khóa ký riêng.

## Request

```http
POST <clients[].webhook.url>
Content-Type: application/json
X-GHN-Service-Event-Id: <event UUID>
X-GHN-Service-Timestamp: <Unix seconds của lần gửi>
X-GHN-Service-Signature: sha256=<HMAC hex>
X-GHN-Service-Attempt: 1
```

```json
{
  "schemaVersion": 1,
  "eventId": "<event UUID>",
  "sequence": 42,
  "eventType": "shipment.status_changed",
  "occurredAt": "2026-11-11T03:00:00.000Z",
  "shipmentId": "<shipment UUID>",
  "referenceCode": "WEB-123",
  "shopCode": "HCM-01",
  "trackingCode": "<GHN order code>",
  "state": "CREATED",
  "carrierStatus": "delivered",
  "carrierUpdatedAt": "2026-11-11T03:00:00.000Z"
}
```

- `shipment.created`: lần đầu xác nhận đã tạo vận đơn GHN (gồm trường hợp phục hồi UNKNOWN qua lookup).
- `shipment.status_changed`: trạng thái GHN đã thay đổi và có timestamp mới hơn dữ liệu đang lưu. Sự kiện cũ, trùng hoặc cùng trạng thái chỉ được lưu lịch sử nội bộ, không tạo outbound mới.
- `state` là trạng thái tích hợp, `carrierStatus` là trạng thái giao hàng GHN. `CREATED` không đồng nghĩa giao thành công.
- Payload không chứa token, khóa ký, địa chỉ, điện thoại, nội dung đơn bán hay dữ liệu công nợ.
- `occurredAt` của created là thời điểm service xác nhận; của status_changed là thời điểm GHN báo. `carrierUpdatedAt` có thể null ở sự kiện created.

## Xác minh và xử lý ở CRM

Chữ ký bằng HMAC-SHA256 với khóa `webhook.secret`, trên đúng bytes UTF-8 của:

```text
<X-GHN-Service-Timestamp>.<raw HTTP body>
```

Khóa HMAC là chuỗi cấu hình được dùng nguyên dạng UTF-8; nếu tạo khóa dạng hex, không giải mã hex trước khi ký/xác minh. Signature có prefix `sha256=`. Timestamp thay đổi mỗi lần gửi; eventId và bytes body giữ nguyên.

Ví dụ Java, dùng raw body trước khi parse JSON:

```java
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.time.Instant;
import java.util.HexFormat;
import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;

static boolean verify(String secret, String timestamp, String signature, byte[] rawBody) {
  if (timestamp == null || !timestamp.matches("[0-9]{10,}") || signature == null
      || !signature.matches("sha256=[a-f0-9]{64}")) return false;
  try {
    long age = Math.subtractExact(Instant.now().getEpochSecond(), Long.parseLong(timestamp));
    if (age < -300 || age > 300) return false;
    Mac mac = Mac.getInstance("HmacSHA256");
    mac.init(new SecretKeySpec(secret.getBytes(StandardCharsets.UTF_8), "HmacSHA256"));
    mac.update((timestamp + ".").getBytes(StandardCharsets.UTF_8));
    String expected = "sha256=" + HexFormat.of().formatHex(mac.doFinal(rawBody));
    return MessageDigest.isEqual(expected.getBytes(StandardCharsets.US_ASCII),
        signature.getBytes(StandardCharsets.US_ASCII));
  } catch (Exception invalid) { return false; }
}
```

Trong Spring MVC, endpoint CRM có thể nhận `@RequestBody byte[] rawBody` và các header bằng `@RequestHeader`. Xác minh trước, rồi dùng ObjectMapper parse body; không ký lại trên JSON đã format.

CRM cần:

1. Lấy raw body, kiểm tra timestamp trong khoảng ±5 phút và chữ ký bằng khóa tương ứng. Đồng bộ đồng hồ giữa hai hệ thống. Không serialize lại JSON để xác minh.
2. Parse JSON, kiểm tra schemaVersion/eventType và eventId khớp header.
3. Lưu eventId với UNIQUE constraint. Trong cùng transaction, cập nhật trạng thái vận chuyển của bản ghi shipmentId/referenceCode. Nếu đã nhận eventId trước đó thì trả 2xx mà không xử lý nghiệp vụ thêm lần nữa.
4. Lưu sequence đã áp dụng theo từng shipmentId; chỉ áp dụng sự kiện có sequence lớn hơn. Sequence tăng trong cùng database Shipping, không nhất thiết liên tục theo client hoặc vận đơn. Không chỉ so occurredAt giữa created và status_changed vì chúng lấy từ hai đồng hồ khác nhau.
5. Trả HTTP 2xx sau khi đã commit hoặc đưa vào hàng đợi bền vững của CRM. Dùng 4xx/5xx nếu chưa nhận được. Mọi non-2xx đều được gửi lại đến hết lượt cấu hình, gồm cả 401/403.

Chỉ dùng webhook để nhận thông tin vận chuyển. CRM tự quyết định tác động tới đơn bán, kho, công nợ của nó.

## Lưu bền vững, gửi lại và thứ tự

Webhook bảo đảm **at least once**, không phải exactly once. Nếu CRM đã commit nhưng mất phản hồi HTTP, Shipping sẽ gửi lại cùng eventId. Khi tiến trình Shipping dừng, lượt IN_FLIGHT được khôi phục sau khi lease hết hạn (timeoutMs + 5 giây từ lúc claim). Số lượt thử đã được lưu trước khi gửi.

Worker kiểm tra hàng đợi khoảng mỗi giây, gửi tuần tự. Các sự kiện của cùng shipment chờ sự kiện trước nhận 2xx hoặc chuyển FAILED; sự kiện của shipment khác vẫn có thể được gửi khi một shipment đang chờ retry. Khi một sự kiện hết lượt, các sự kiện mới hơn có thể tiếp tục. Manual retry sau đó vẫn giữ sequence cũ; CRM phải tránh ghi đè trạng thái mới bằng sự kiện cũ.

Mặc định: timeout 10 giây, maxAttempts 12 lượt tổng cộng, baseDelay 5 giây, maxDelay 1 giờ. Thời gian chờ sau lượt lỗi thứ n là `min(maxDelayMs, baseDelayMs * 2^(n-1))`. Không follow redirect; HTTP 3xx được ghi nhận là lỗi để tránh gửi dữ liệu sang endpoint khác. Body phản hồi CRM không được ghi vào database hoặc log.

Worker dùng URL snapshot trong hàng đợi và khóa ký hiện tại trong cấu hình. Đổi URL yêu cầu chủ động retry các sự kiện FAILED/ENDPOINT_CHANGED; đổi khóa ký không đổi payload/eventId. Khi luân chuyển khóa, CRM nên chấp nhận cả khóa cũ và mới trong giai đoạn chuyển tiếp để xử lý request đang bay.

Tắt webhook ngăn xếp hàng sự kiện mới và tạm ngừng gửi các sự kiện đang chờ. Không có backfill cho khoảng thời gian tắt. Sau khi bật lần đầu, dùng API tra cứu/reconcile để CRM đồng bộ dữ liệu có sẵn.

## API vận hành

Các API sau đều cần `Authorization: Bearer <service-token>` và chỉ thao tác dữ liệu của client đó:

| Method | Path | Kết quả |
|---|---|---|
| GET | `/internal/shipping/ghn/webhook` | enabled, URL, timeout/retry settings và secretConfigured; không trả secret |
| GET | `/internal/shipping/ghn/webhook/deliveries` | 200 sự kiện gần nhất, trạng thái và lỗi gửi |
| POST | `/internal/shipping/ghn/webhook/deliveries/{eventId}/retry` | 202, xếp lại FAILED vào PENDING, reset attempts, giữ eventId/payload/sequence |

Trạng thái: PENDING → IN_FLIGHT → DELIVERED hoặc PENDING (retry) hoặc FAILED. HTTP 404 nếu event không thuộc client; 409 nếu webhook đang tắt hoặc event chưa ở FAILED. Không cho sửa URL hay đọc khóa ký bằng service token; quản trị viên sửa file rồi restart service.

Schema SQLite được tự thêm bằng CREATE TABLE IF NOT EXISTS khi khởi động; không thay đổi dữ liệu shipment hiện có. Không tự tạo outbound cho các shipment đã CREATED từ trước phiên bản này. Vẫn yêu cầu chạy một tiến trình/replica với database hiện tại.

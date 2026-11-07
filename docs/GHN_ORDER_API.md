# CRM → GHN

Triển khai controller/service trong package `vn.aicrm.shipping`, lưu bằng JDBC.
Flyway V47 bổ sung hàng đợi yêu cầu giao, báo phí và trạng thái giao của đơn sale.

## Sales xác nhận báo giá và tự giao GHN

`POST /api/v1/retail/quotes/{quoteId}/fulfillment` thực hiện xác nhận khách đồng ý, tạo đơn,
xuất toàn bộ hàng và tạo vận đơn. V51 bổ sung `retail.quote_fulfillment_attempt` để đối soát
API ngoài mà không giữ lại đơn hoặc phiếu xuất khi giao dịch nghiệp vụ rollback.

Form gọi `POST /api/v1/retail/quotes/{quoteId}/fulfillment/preview` sau khi đủ thông tin giao hàng,
khối lượng/kích thước và số kiện. API nhận trực tiếp thông tin shipping, trả `totalFee`, `fee`,
`paymentTypeId`, `expectedDeliveryTime`; không ghi dữ liệu nghiệp vụ, không tạo vận đơn hoặc trừ tồn.
Frontend chờ 600 ms sau lần chỉnh sửa cuối, ẩn phí cũ khi dữ liệu thay đổi và bỏ qua phản hồi cũ.

- GHN preview chạy trước khi ghi nhận khách đồng ý hoặc trừ tồn. Lỗi địa chỉ, tuyến hoặc phí
  sẽ dừng tại đây.
- Xác nhận khách đồng ý, đơn, ISSUE, tồn kho, công nợ, delivery, command, audit và outbox cùng
  nằm trong transaction của `RetailCommands.execute`. GHN từ chối tạo vận đơn thì transaction rollback.
- Nhật ký gọi GHN dùng transaction độc lập. Mã shop gửi GHN cố định là `CRM-Q-{quoteId}`.
  Timeout hoặc mất kết nối giữ trạng thái UNKNOWN; lần thử lại chỉ tra cứu cùng mã, không tạo lại.
- Nếu GHN đã thành công nhưng commit dữ liệu nghiệp vụ lỗi, phản hồi GHN vẫn được lưu trong
  nhật ký; lần thử lại dùng kết quả đó để hoàn tất database mà không gọi create lần nữa.
- Các phiếu đã xuất từ luồng cũ vẫn dùng nhánh gửi/thử lại cũ, không tự đảo sổ kho đã ghi.

Áp dụng migration V51 trước khi chạy backend mới. Các API tạo, sửa và xóa cấu hình tài khoản/shop
GHN trong `GhnShippingService` đã dùng `@Transactional`.

## Luồng xử lý

1. Khi `retail.sales_order.status = CONFIRMED`, trigger tạo một yêu cầu giao nội bộ trong cùng transaction. Migration cũng đưa các đơn CONFIRMED hiện có vào danh sách.
2. Kho ghi sổ phiếu xuất ISSUE từ đơn sale. Tính phí và tạo vận đơn chỉ nhận phiếu POSTED thuộc đúng đơn, kho và chi nhánh của shop GHN. Backend kiểm tra từng SKU, lượng đã xuất trên sổ kho, hàng trả và công nợ còn lại. Tồn kho/lô/serial được kiểm tra và trừ khi ghi sổ ISSUE; tạo vận đơn không trừ lần nữa.
3. Nhân viên mở **Giao hàng → Đơn giao & Tracking**, chọn phiếu xuất và shop, điền người nhận, tỉnh/phường GHN, kích thước, khối lượng, kiện hàng, dịch vụ, người trả phí và COD.
4. Backend gọi GHN preview để tính phí cho địa chỉ mới 2 cấp, lưu báo phí có hiệu lực 15 phút. Chưa tạo đơn GHN ở bước này.
5. Nhân viên xác nhận đúng báo phí, COD và người trả phí. Backend lưu delivery, delivery_item và shipping_request rồi commit trước khi gọi GHN create.
6. Lưu `order_code` vào `retail.delivery.tracking`. GHN gửi webhook cập nhật trạng thái; CRM lưu lịch sử và tổng hợp `sales_order.shipping_status`.

Một phiếu xuất có một vận đơn. Đơn bán xuất nhiều đợt có nhiều vận đơn; chỉ đánh dấu giao đủ khi lượng giao thành công phủ đủ các dòng đơn bán chưa hủy.

## Quyền

- Xem yêu cầu giao, tracking, danh mục địa chỉ: `delivery.VIEW`, kèm phạm vi khách hàng/kho.
- Báo phí, xác nhận và kiểm tra lại tạo đơn: `delivery.CREATE`.
- Thêm/sửa/xóa token, shop, tạo/đổi khóa webhook: CEO hoặc quản trị viên hệ thống cao nhất.
- Token GHN chỉ đọc trên backend, không trả cho giao diện.

## API nội bộ

Các API dưới đây yêu cầu Bearer token CRM. Prefix: `/api/v1/retail/shipping/ghn`.

| Method | Path | Nội dung |
|---|---|---|
| GET | /orders | Danh sách yêu cầu giao từ đơn sale đã xác nhận, tối đa 500 đơn gần nhất trong phạm vi |
| GET | /orders/{orderId} | Phiếu xuất còn chờ, hàng hóa, shop hợp lệ, vận đơn và lịch sử webhook |
| GET | /orders/{orderId}/shops/{shopRecordId}/provinces | Danh mục tỉnh mới GHN |
| GET | /orders/{orderId}/shops/{shopRecordId}/provinces/{provinceId}/wards | Danh mục phường/xã GHN |
| POST | /orders/{orderId}/quote | Kiểm tra dữ liệu và lấy phí dự kiến |
| POST | /orders/{orderId}/confirm | Xác nhận báo phí, tạo vận đơn |
| POST | /orders/{orderId}/deliveries/{deliveryId}/retry | Kiểm tra/thử lại yêu cầu đã lưu |
| POST | /accounts/{accountId}/webhook-secret | Tạo/đổi khóa xác thực webhook (hiển thị một lần) |

`orderId` là UUID của sales_order. `shopRecordId` là UUID liên kết shop trong CRM, khác ShopId dạng số của GHN.

### Lấy phí

`POST /orders/{orderId}/quote`

```json
{
  "issueId": "11111111-1111-4111-8111-111111111111",
  "shopRecordId": "22222222-2222-4222-8222-222222222222",
  "recipient": {
    "name": "Nguyễn Văn An",
    "phone": "0901234567",
    "address": "123 đường Nguyễn Huệ",
    "provinceId": 1000001,
    "wardId": 2000001
  },
  "weight": 1000,
  "length": 30,
  "width": 20,
  "height": 10,
  "serviceTypeId": 2,
  "paymentTypeId": 1,
  "codAmount": 250000,
  "insuranceValue": 250000,
  "requiredNote": "CHOXEMHANGKHONGTHU",
  "note": "Gọi trước khi giao",
  "items": [
    {
      "issueLineId": "33333333-3333-4333-8333-333333333333",
      "quantity": 1
    }
  ]
}
```

Các ID chỉ là minh họa: dùng UUID thực từ CRM và mã tỉnh/phường trả về từ danh mục GHN. Backend lấy tên tỉnh/phường chuẩn từ GHN; không tin tên địa chỉ do client tự gửi. Người gửi/hoàn hàng lấy từ cấu hình shop và cũng được kiểm tra.

`items` phải có đúng các dòng phiếu xuất. `quantity` là số kiện/đơn vị đóng gói nguyên gửi GHN; số lượng hàng thực tế vẫn lấy từ phiếu xuất. Dịch vụ 5 yêu cầu mỗi item thêm `weight`, `length`, `width`, `height`; tổng `quantity × weight` phải khớp khối lượng cả đơn. Dịch vụ 2 dùng cho tổng dưới 20 kg. COD không vượt công nợ phiếu xuất, tối đa 50 triệu; khai giá tối đa 5 triệu.

Response có `quoteId`, `totalFee`, `fee`, `expectedDeliveryTime`, `codAmount`, `paymentTypeId`, `recipient`, `expiresInSeconds: 900`.

### Xác nhận tạo vận đơn

`POST /orders/{orderId}/confirm`

```json
{
  "quoteId": "44444444-4444-4444-8444-444444444444",
  "acceptedFee": 22000,
  "codAmount": 250000,
  "paymentTypeId": 1
}
```

Dùng đúng giá trị từ báo phí. Thay đổi địa chỉ, kiện hàng, dịch vụ hoặc COD phải lấy báo phí mới.

Response là chi tiết đơn giao, có `deliveries[].tracking`, `integration_status`, `carrier_status`, phí và lỗi nếu có. HTTP 200 của API này có nghĩa đã xử lý yêu cầu nội bộ; cần đọc `integration_status` để biết GHN đã tạo thành công hay chưa.

- `CREATED`: đã có vận đơn.
- `CREATING`: một request khác đang gọi GHN; không gửi thêm.
- `ERROR`: GHN từ chối rõ ràng, có thể thử lại cùng yêu cầu sau khi sửa cấu hình.
- `UNKNOWN`: mất kết nối/kết quả chưa rõ. Nút “Tra cứu kết quả GHN” chỉ tìm theo mã nội bộ; không tự tạo vận đơn khác. Nếu chưa tìm thấy, kiểm tra trên GHN trước khi xử lý tiếp.

Idempotency dùng quoteId ở CRM và `client_order_code = CRM-{deliveryUUID}` ở GHN. Gửi lại cùng quoteId trả cùng delivery; request đồng thời bị chặn bằng lock và lease. Request và payload được giữ nguyên qua các lần thử.

## Webhook

1. CEO/admin mở **Tài khoản GHN → Webhook GHN → Tạo/đổi khóa**.
2. Sao chép URL và header vào cấu hình Order webhook tại GHN Developer Portal, đúng môi trường. URL phải là HTTPS công khai của backend.
3. Header tùy chỉnh: `X-GHN-Webhook-Secret: <khóa vừa sinh>`.

Endpoint nhận:
`POST /api/v1/webhooks/ghn/{tenantId}/{accountId}`.

Không dùng Bearer token CRM. Khóa được lưu dạng SHA-256; đổi khóa làm khóa cũ hết hiệu lực. Callback được kiểm tra tenant/account, ShopID, mã vận đơn hoặc mã nội bộ. Body PascalCase theo GHN:

```json
{
  "ShopID": 123456,
  "OrderCode": "GHN123ABC",
  "ClientOrderCode": "CRM-55555555-5555-4555-8555-555555555555",
  "Type": "switch_status",
  "Time": "2026-11-02T08:00:00Z",
  "Status": "delivered",
  "Reason": "",
  "ReasonCode": "",
  "IsPartialReturn": false
}
```

Thay Time và mã thực tế khi thử. Inbox lưu bền vững; khử trùng lặp theo shop + OrderCode + Type + Time. Callback đến trước kết quả create có thể ghép bằng ClientOrderCode; callback chưa ghép được lưu UNMATCHED và được xử lý lại khi đã có mã vận đơn.

Trạng thái cũ không ghi đè trạng thái mới; delivered/returned/cancel và các trạng thái kết thúc không bị lùi về đang giao. delivery_fail có thể chuyển lại delivering khi hãng giao lại. Trạng thái lạ được lưu lịch sử để theo dõi.

Giao một phần được đánh dấu PARTIAL, cần đối chiếu số lượng thực tế. Giao thất bại/hoàn hàng không tự nhập lại kho; lập nghiệp vụ trả hàng sau khi kho nhận hàng thực. Delivered không tự coi là đã nhận tiền COD; dùng luồng đối soát hiện có. Thay đổi COD từ GHN được ghi riêng và đánh dấu cần đối chiếu.

## Tài liệu GHN dùng để tích hợp

- [Xem trước đơn / tính phí với địa chỉ mới](https://developer.ghn.vn/vi/docs/order/preview)
- [Tạo đơn, client_order_code và cấu trúc kiện hàng](https://developer.ghn.vn/vi/docs/order/create)
- [Callback, header tùy chỉnh và sự kiện](https://developer.ghn.vn/vi/docs/webhook/callback-order-status)
- [Tra cứu theo mã nội bộ](https://developer.ghn.vn/vi/docs/order/info-by-client-code)

Kiểm tra tự động dùng HTTP giả lập, không tạo vận đơn thật. Cần kiểm thử Staging với tài khoản GHN và đăng ký webhook trước khi vận hành Production.

### Nhận callback staging khi backend chạy localhost

`scripts/ghn-webhook-relay.mjs` tạo relay chỉ lắng nghe loopback và chỉ chuyển tiếp POST tới
đúng tenant/account webhook đã chỉ định. Các route khác bị chặn; header secret vẫn do backend xác thực.
Relay không ghi token, header hoặc nội dung callback vào log. Chạy kiểm thử relay bằng
`node --test scripts/ghn-webhook-relay.test.mjs` tại thư mục gốc.

```powershell
node scripts/ghn-webhook-relay.mjs --backend http://127.0.0.1:8185 --path /api/v1/webhooks/ghn/<tenantId>/<accountId> --port 8190
```

Để nhận từ GHN thật, cần mở tunnel HTTPS tạm tới relay `127.0.0.1:8190`, sau đó đăng ký URL
và header tại Developer Portal staging. Tunnel chỉ tới relay nhận callback, không trực tiếp toàn bộ backend. Đóng tunnel và relay
khi kết thúc test. Không dùng callback giả lập để thay trạng thái vận đơn thật.

# Contract Shipping độc lập

## Tạo vận đơn

```http
POST /internal/shipping/ghn/create-order
Authorization: Bearer <service-token>
Idempotency-Key: web-retail-order-123-shipment-1
Content-Type: application/json
```

```json
{
  "referenceCode": "WEB-123",
  "shopCode": "HCM-01",
  "recipient": {
    "name": "Nguyễn Văn An", "phone": "0901234567", "address": "123 Nguyễn Huệ",
    "provinceId": 1000001, "wardId": 2000001
  },
  "weight": 1000, "length": 30, "width": 20, "height": 10,
  "codAmount": 250000, "insuranceValue": 250000,
  "serviceTypeId": 2, "paymentTypeId": 1,
  "items": [{ "name": "Áo thun", "quantity": 1 }]
}
```

Địa chỉ trên chỉ minh họa; lấy mã thực bằng API danh mục GHN. Đơn vị: gram, cm, đồng. Không gửi orderId, issueId, warehouseId hay thông tin công nợ. Người gửi và địa chỉ hoàn được cấu hình theo shop. CRM tự kiểm tra nghiệp vụ trước khi gọi.

`requiredNote` mặc định `CHOXEMHANGKHONGTHU`, cho phép thêm `KHONGCHOXEMHANG` hoặc `CHOTHUHANG`. `note` tùy chọn, tối đa 5000 ký tự. Service 2 hoặc 5; từ 20 kg dùng service 5. Với service 5, mỗi item cần weight/length/width/height; tổng quantity × weight phải bằng khối lượng đơn. COD từ 0 đến 50 triệu; khai giá từ 0 đến 5 triệu. Service không so sánh COD với công nợ CRM.

Kết quả:

```json
{
  "id": "<shipment UUID>", "referenceCode": "WEB-123", "shopCode": "HCM-01",
  "state": "CREATED", "trackingCode": "<GHN order code>",
  "carrierStatus": "ready_to_pick", "carrierUpdatedAt": null,
  "result": { "trackingCode": "<GHN order code>", "totalFee": 32000 },
  "error": null, "createdAt": "<ISO time>", "updatedAt": "<ISO time>", "events": []
}
```

| HTTP | Ý nghĩa |
|---|---|
| 201 | Đã tạo vận đơn mới |
| 200 | Kết quả đã lưu cho cùng Idempotency-Key |
| 202 | CREATING hoặc UNKNOWN; giữ khóa và tra cứu lại |
| 400 | Contract không hợp lệ, chưa lưu yêu cầu |
| 401 / 403 | Token sai / shop chưa được cấp quyền |
| 409 | Cùng khóa nhưng payload khác |
| 422 | Yêu cầu đã lưu ở trạng thái REJECTED; đọc error |
| 502 | Không tra cứu/tính phí được từ GHN |

Không tạo lại khi UNKNOWN. Gọi `POST /internal/shipping/ghn/shipments/{id}/reconcile` (body `{}` tùy chọn) để lookup GHN theo UUID đã gửi. GHN chưa tìm thấy hoặc lỗi tra cứu không có nghĩa là an toàn để tạo lại; state UNKNOWN được giữ nguyên. Payload lưu theo snapshot; đổi cấu hình shop không làm thay đổi fingerprint của cùng yêu cầu. Khóa phải được giữ ổn định ở bên CRM.

`POST /preview` dùng cùng body, không tạo shipment, trả `totalFee` nếu GHN trả phí. Phí preview là ước tính; phí lúc tạo và phí thực tế có thể thay đổi.

## Tra cứu trạng thái từ CRM

1. Lưu `id` và `trackingCode` nhận được vào CRM.
2. Đọc `GET /shipments/{id}` dưới prefix API để lấy carrierStatus và events.
3. Khi cần tra cứu trực tiếp GHN, gọi POST reconcile rồi đọc kết quả trả về.
4. CRM tự ánh xạ trạng thái GHN vào đơn bán. Service không truy cập database CRM.

`GET /shipments?referenceCode=...` trả tối đa 200 yêu cầu gần nhất của bên gọi; chi tiết trả tối đa 100 sự kiện gần nhất. Chưa có phân trang. Có thể cấu hình [webhook gửi chủ động sang CRM](OUTBOUND_WEBHOOKS.md) thay cho polling thường xuyên.

## Webhook GHN

`POST /webhooks/ghn/HCM-01`, header `X-GHN-Webhook-Secret: <secret trong cấu hình shop>`.

```json
{
  "ShopID": 123456,
  "OrderCode": "<GHN order code>",
  "ClientOrderCode": "<shipment UUID, nếu có>",
  "Status": "delivered",
  "Time": "2026-11-11T10:00:00+07:00"
}
```

Time bắt buộc là chuỗi thời gian parse được, không ở tương lai quá 5 phút. Sự kiện cũ được giữ trong lịch sử nhưng không ghi đè trạng thái mới hơn. Hai sự kiện cùng timestamp giữ trạng thái được áp dụng trước. ShopID nếu có phải đúng cấu hình. Webhook đến trước kết quả create có ClientOrderCode thì service xác minh tracking qua API lookup GHN.

Endpoint yêu cầu header bí mật từ tầng tiếp nhận callback đã xác thực. Nếu cấu hình webhook GHN không hỗ trợ header tùy chỉnh, cần gateway/relay xác thực callback trước khi thêm header này; không công khai endpoint không được bảo vệ. Chưa tự triển khai gateway trong repo.

## Cấu hình

`GHN_CONFIG_FILE`: đường dẫn file JSON bắt buộc. `GHN_DB_PATH`: mặc định `data/shipping.sqlite`. `PORT`: 8080. `HOST`: 127.0.0.1. `GHN_MODE`: live (mặc định) hoặc mock (chỉ demo). Không có kết nối hoặc fallback tới CRM.

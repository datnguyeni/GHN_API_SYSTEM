# GHN Shipping Service

Dịch vụ vận chuyển độc lập: CRM/Web bán lẻ gọi API → Shipping Service → GHN. Không cần backend Java, database, schema, phân quyền hoặc module CRM. Backend mới dùng Node.js 24 và SQLite riêng; frontend React gọi API thật của service.

Đã bỏ code đơn bán, phiếu xuất, tồn kho, khuyến mãi, công nợ, xác nhận báo giá và cập nhật đơn CRM. CRM tự quyết định COD, hàng gửi và đợt giao. Service chỉ xác thực bên gọi, kiểm tra dữ liệu vận chuyển, lấy cấu hình shop, tính phí, tạo/tra cứu vận đơn và nhận webhook GHN. Trạng thái gửi về CRM qua **API polling**; chưa có webhook đẩy chủ động sang CRM.

## Chạy thử không cần tài khoản GHN

Yêu cầu Node.js 24+.

```powershell
npm ci
npm run build
npm run demo
```

Mở http://127.0.0.1:8080. Nhập service token mẫu `demo-only-service-access-token-1234567890`, bấm Kết nối rồi Tính phí/Tạo vận đơn. Chế độ demo dùng adapter giả lập, không gọi GHN; dữ liệu được lưu tại `data/demo.sqlite` và tồn tại sau khi khởi động lại. Payload mẫu chỉ có mã địa chỉ demo.

## Kết nối GHN thật

1. Chép `config/service.example.json` thành `config/service.json` (file này bị git bỏ qua).
2. Thay service token, webhook secret bằng chuỗi ngẫu nhiên ít nhất 32 ký tự; điền token GHN, Shop ID và mã tỉnh/phường GHN thật cho địa chỉ gửi/hoàn.
3. Chọn `STAGING` hoặc `PRODUCTION` cho từng shop. Service token và token GHN là hai khóa khác nhau. Mỗi hệ thống gọi có `id`, token và danh sách shop được phép riêng. Cấu hình chỉ được quản trị bằng file, không trả token GHN qua API.

Tạo khóa ngẫu nhiên:

```powershell
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

Chạy local:

```powershell
$env:GHN_CONFIG_FILE = 'config/service.json'
npm run build
npm start
```

Hoặc chạy `docker compose up --build` sau khi tạo cấu hình. Docker lưu database trong volume `shipping-data`; file cấu hình mount chỉ đọc. Node mặc định bind `127.0.0.1:8080`; Docker bind trong container và chỉ publish loopback trên host. Khi cho hệ thống khác gọi, cấu hình reverse proxy HTTPS và quyền truy cập mạng phù hợp.

Để sửa giao diện: chạy backend ở một terminal và `npm run dev` ở terminal khác. Vite proxy API đến `127.0.0.1:8080`.

## API giữa CRM và Shipping

Tất cả `/internal/shipping/ghn/*` cần `Authorization: Bearer <service-token>`. Xem [contract và ví dụ](docs/API.md).

| Method | Path | Chức năng |
|---|---|---|
| GET | `/health` | Trạng thái dịch vụ, chế độ live/mock |
| GET | `/internal/shipping/ghn/shops` | Shop được cấp quyền, không trả khóa bí mật |
| GET | `/internal/shipping/ghn/shops/{shopCode}/provinces` | Mã tỉnh GHN |
| GET | `/internal/shipping/ghn/shops/{shopCode}/wards?provinceId=...` | Mã phường GHN |
| POST | `/internal/shipping/ghn/preview` | Kiểm tra dữ liệu và tính phí |
| POST | `/internal/shipping/ghn/create-order` | Tạo vận đơn, bắt buộc Idempotency-Key |
| GET | `/internal/shipping/ghn/shipments?referenceCode=WEB-123` | Tra cứu dữ liệu đã lưu của bên gọi |
| GET | `/internal/shipping/ghn/shipments/{id}` | Chi tiết và lịch sử trạng thái đã lưu |
| POST | `/internal/shipping/ghn/shipments/{id}/reconcile` | Tra cứu GHN để cập nhật dữ liệu đã lưu |
| POST | `/webhooks/ghn/{shopCode}` | GHN callback, cần X-GHN-Webhook-Secret |

GET shipment đọc dữ liệu local. CRM gọi reconcile theo lịch khi cần cập nhật từ GHN, sau đó tự cập nhật đơn bán của mình. Bên gọi chỉ xem vận đơn của chính nó, dù hai bên được dùng chung một shop.

## Vận hành và giới hạn

- Chạy **một tiến trình/replica** trên một database SQLite. Không dùng cluster hoặc nhiều container dùng chung file. Đổi quy mô cần chuyển store sang database hỗ trợ nhiều worker và thêm cơ chế lease.
- `Idempotency-Key` được lưu bền vững theo hệ thống gọi. Cùng khóa/cùng payload trả vận đơn cũ; khác payload trả 409. Cùng mã tham chiếu nhưng khóa mới được coi là một đợt giao khác.
- Mỗi vận đơn dùng UUID nội bộ làm `client_order_code` GHN. Timeout hoặc khởi động lại giữa lúc tạo được đánh dấu UNKNOWN; chỉ lookup, không tự tạo lại. Không đổi khóa để xử lý UNKNOWN vì có thể tạo thêm vận đơn.
- Webhook được khử trùng và áp dụng theo thời gian sự kiện. Webhook của mã vận đơn chưa biết trả 404 để bên gửi có thể gửi lại; có thể reconcile rồi gửi lại sự kiện. Không ghi nhận doanh thu, tồn kho hay công nợ từ webhook.
- Database chứa địa chỉ/điện thoại giao hàng; bảo vệ và sao lưu cả database/WAL. Không commit cấu hình thật hoặc đưa nó vào Docker image. Khởi động lại service sau khi đổi cấu hình.
- Đây là thay đổi API và runtime so với gói CRM cũ; không tự chuyển dữ liệu từ schema CRM. CRM cần đổi sang contract mới. Chưa hỗ trợ API hủy vận đơn hoặc đối soát chuyển tiền COD.

## Kiểm tra

```powershell
npm test
npm run build
```

Kiểm thử tự động dùng GHN giả lập: auth, phân quyền, idempotency đồng thời, timeout/restart, webhook, lưu bền vững và contract HTTP. Kết nối GHN thật cần kiểm thử Staging bằng tài khoản và mã địa chỉ thực tế trước khi triển khai.

Backend dùng [SQLite tích hợp trong Node.js](https://nodejs.org/docs/latest-v24.x/api/sqlite.html), không cần cài database CRM.

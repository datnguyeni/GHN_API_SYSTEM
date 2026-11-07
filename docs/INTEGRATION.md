# Tích hợp vào CRM

## 1. Backend

Chép `backend/src/...` vào cùng đường dẫn trong host. Đảm bảo Spring scan `vn.aicrm.shipping`. Host cung cấp Java 21, Spring Web/Security/JDBC/Transaction, Jackson và PostgreSQL. Xem POM gốc ở `integration/reference/backend/pom.xml` để đối chiếu dependency thực tế; gói này không có POM chạy độc lập.

Các bean phụ thuộc host:

| Thành phần | Vai trò |
|---|---|
| `RetailAccess` | Tenant, actor, quyền, scope, JDBC, JSON, tra cứu và kiểm tra nghiệp vụ |
| `RetailCommands` | Transaction/idempotency của xác nhận báo giá và audit/outbox |
| `RetailDocuments` | Đọc báo giá, tạo đơn, ghi nhận phản hồi, xuất kho |
| `JdbcTemplate`, `PlatformTransactionManager` | Truy cập database và transaction |
| `SecurityConfig.sha256`, `ApiExceptionHandler.ApiProblem` | Hash và cấu trúc lỗi hiện tại |

Không chép đè toàn bộ shared/security từ `integration/reference`. Đó là bản tham chiếu để đối chiếu với host, không phải dependency tự đủ. Host phải có các dịch vụ tương thích hoặc người tích hợp cung cấp adapter tương đương.

`GhnOrderService` hiện đọc/ghi trực tiếp bảng CRM; chỉ tạo một interface mới mà không thay truy vấn chưa làm module độc lập. Khi đổi hệ thống, gom thay đổi vào adapter: đọc đơn/phiếu xuất/hàng hóa, kiểm tra công nợ/kho, tenant/quyền và cập nhật trạng thái đơn bán. Danh sách phụ thuộc SQL được tạo ở `docs/SQL-DEPENDENCIES.txt`.

## 2. Luồng Sales tùy chọn

`integration/crm-overlay/backend/.../QuoteFulfillmentController.java` nối xác nhận báo giá với Shipping. Controller này cần `QuoteFulfillmentAttempts` trong backend Shipping cùng `RetailCommands` và `RetailDocuments` của Sales.

Giữ cơ chế hiện tại: preview trước, ghi đơn/xuất kho trong transaction, nhật ký GHN ở transaction riêng; timeout giữ UNKNOWN và lần sau tra cùng client_order_code. GHN đã thành công nhưng commit nghiệp vụ thất bại phải dùng lại phản hồi cũ, không tạo vận đơn mới.

Màn hình đơn bán/quote host phải gọi form `quote-fulfillment.tsx` và `shipping-preview.ts`; xem `sales-workspace.tsx` và `quotes.tsx` trong reference để lấy vị trí sử dụng. Không thay cả màn hình host chỉ để thêm chức năng này.

## 3. Frontend

Chép `frontend/app/retail/shipping` vào host và giữ type `frontend/app/module-contract.ts` tương thích. Màn hình nhận props `request`, `apiUrl`, `onNavigate`, `isCeo`, `isPlatformAdmin`.

- `request<T>(path, init)` phải gửi Bearer token CRM và xử lý lỗi API.
- `apiUrl` là địa chỉ backend công khai dùng hiển thị URL webhook.
- Route/view `retail-shipping` render `GhnShippingWorkspace`.
- CSS chung của retail vẫn cần từ host; bản tham chiếu `data-table.css` được kèm theo.
- Không cung cấp .env hoặc auth token của môi trường nguồn.

## 4. Quyền, menu, bảo mật

- Quyền `delivery.VIEW`: danh sách, chi tiết, danh mục địa chỉ.
- Quyền `delivery.CREATE`: báo phí, xác nhận, retry.
- CEO/platform admin: cấu hình tài khoản/shop và đổi webhook secret.
- Luồng fulfillment cần quyền Orders tương ứng trong controller/service.
- Cho phép POST `/api/v1/webhooks/ghn/*/*` đi vào mà không có Bearer token; service tự kiểm tra `X-GHN-Webhook-Secret`. Giữ kiểm tra secret, tenant/account/shop và chống trùng webhook.
- Giữ transaction context `core.tenant_id` để RLS hoạt động đúng.

Hiện shipping được gán cho Sales. Nếu đăng ký thành module `aicrm-shipping-ghn`, phải cập nhật đồng bộ:

1. `BusinessModules.owner("delivery")`, `screenOwner("shipping")`, `packageOwner(...shipping)`.
2. Module contributor đăng ký resource/navigation; loại menu shipping trùng khỏi `SalesModule`.
3. Ownership trong module runtime, module-platform.json và registry frontend.
4. POM đóng gói `vn/aicrm/shipping/**` vào artifact shipping; bỏ khỏi artifact Sales để tránh trùng class.
5. Khai báo Sales phụ thuộc module Shipping khi Sales còn gọi fulfillment.

Các file đăng ký hiện tại có trong reference. Manifest bàn giao không tự thực hiện các thay đổi này. Đợt tích hợp đầu có thể giữ đăng ký Sales hiện tại để xác nhận luồng chạy trước.

## 5. Database và vận hành

Đọc `migrations/README.md`. Giữ URL API hiện tại để frontend/webhook không phải đổi. Nhập tài khoản GHN Staging, gắn đúng kho/chi nhánh, cấu hình địa chỉ gửi/hoàn, tạo secret rồi đăng ký webhook HTTPS công khai.

Không tự coi delivered là đã nhận tiền COD. Hoàn hàng không tự tăng lại tồn kho. Các thao tác đó vẫn theo nghiệp vụ kho/kế toán của host.

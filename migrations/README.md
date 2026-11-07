# Database / migration

`reference/` chứa nguyên văn migration nguồn. Không đặt cả thư mục này vào Flyway của một CRM đã có migration tương ứng. Không sửa migration đã áp dụng hoặc chạy lại V37 dưới số version mới.

| Migration | Nội dung |
|---|---|
| V24 | Nền retail, trong đó tạo delivery, document, line và các bảng nghiệp vụ khác |
| V25 | delivery.actual_fee |
| V37 | sales_order và liên kết nghiệp vụ; tài khoản/shop, mở rộng delivery, delivery_item, request, event, đối soát COD |
| V47 | shipping_order_queue, shipping_quote, sales_order.shipping_status, trigger và các cột delivery bổ sung |
| V51 | quote_fulfillment_attempt |

## CRM nguồn hoặc database cùng lịch sử

Kiểm tra `flyway_schema_history`: các version 24, 25, 37, 47, 51 phải thành công. Nếu chưa có version mới, nâng cấp bằng chuỗi migration chuẩn của host. Các migration trong gói không phải toàn bộ chuỗi migration CRM.

## Database mới hoặc hệ thống khác

Đối chiếu schema host trước. Các migration tham chiếu retail.document/line/sales_order/partner/branch/warehouse/payment, platform.tenant, identity.account và các ràng buộc unique của chúng. Không thể chạy riêng 5 file trên một PostgreSQL trống.

Người tích hợp cần tạo migration mới theo version/namespace của host, tách đúng DDL shipping trong V37, ánh xạ khóa ngoại nghiệp vụ và giữ RLS. Không tự bỏ khóa ngoại hoặc RLS để làm SQL chạy qua. Gói giữ bản gốc để người sau có đầy đủ cấu trúc, không cung cấp một script cài trống giả định sai schema host.

## Các bảng

- Cấu hình: retail.shipping_account, retail.shipping_shop.
- Giao hàng: retail.delivery, retail.delivery_item.
- API và webhook: retail.shipping_request, retail.shipping_event.
- Hàng đợi/báo phí: retail.shipping_order_queue, retail.shipping_quote.
- Điều phối Sales: retail.quote_fulfillment_attempt.
- Schema chuẩn bị cho đối soát: retail.cod_reconciliation, retail.cod_reconciliation_line (chưa thấy code Java sử dụng hai bảng này).

V47 tạo trigger sales_order_shipping_queue và hàm retail.enqueue_confirmed_shipping_order(). Đơn CONFIRMED chỉ sinh việc giao nội bộ, không tự tạo vận đơn GHN.

Giữ ràng buộc một delivery trên một ISSUE, unique client_order_code/tracking theo shop, idempotency của request, dedup webhook, tenant_id và RLS ENABLE/FORCE. Shipping không trừ tồn kho lần nữa sau khi ISSUE đã POSTED.

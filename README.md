# Shipping GHN — gói mã nguồn tích hợp

## Chạy demo độc lập để xem giao diện

Cài và mở Docker Desktop (Linux containers), rồi chạy trong thư mục này:

```powershell
docker compose up --build
```

Mở http://localhost:8080. Dừng bằng `Ctrl+C`, dọn container bằng `docker compose down`.

Demo dùng **giao diện Shipping hiện có** với API giả lập trong bộ nhớ trình duyệt, không cần CRM, PostgreSQL hoặc token GHN. Không nhập token thật. Dữ liệu tự khôi phục khi tải lại trang; mỗi tab trình duyệt có dữ liệu riêng.

- Đơn `SO-DEMO-001`: chọn **Xử lý / Tracking**, chọn phiếu xuất, tỉnh/phường, nhập khối lượng rồi **Tính phí GHN** và xác nhận để xem vận đơn mẫu.
- Đơn `002` và `003`: xem trạng thái đang giao/thành công và lịch sử tracking mẫu.
- Đơn `004`: thử gửi lại vận đơn lỗi.
- Tab **Shop & kho**: xem, sửa hoặc thêm cấu hình bằng token giả bất kỳ. Tab **Tài khoản GHN**: thử tạo khóa webhook giả lập hoặc xóa tài khoản mẫu.

Phí, địa chỉ và tracking trong demo đều giả lập; demo không chạy backend Java, migration, phân quyền CRM hay gọi GHN thật. Kiểm thử tích hợp thật vẫn theo tài liệu bên dưới.

Nếu không có Docker, dùng Node.js 22.18+:

```powershell
npm ci
npm run dev
```

Mở URL Local mà Vite in ra (thường http://127.0.0.1:5173). Kiểm tra bằng `npm run build` và `npm run test:demo`.

Gói code lấy từ CRM Đại Thắng ngày 07/11/2026 để bàn giao và đưa vào module Shipping.
Chạy chung backend/database của CRM. Không cần service riêng.

## Bắt đầu

1. Đọc `docs/INTEGRATION.md` để hiểu các phụ thuộc với CRM.
2. Xem trước việc chép code vào một checkout CRM tương thích:

```powershell
./scripts/install-source.ps1 -CrmRoot D:\path\to\crm -WhatIf
```

3. Chép backend, frontend, phần nối Sales và test:

```powershell
./scripts/install-source.ps1 -CrmRoot D:\path\to\crm
```

Script chỉ thêm file mới hoặc bỏ qua file giống hệt. Nếu có file khác nội dung, script dừng trước khi chép để người tích hợp merge thủ công. Script không chạy SQL, không sửa đăng ký module, không cài dependency và không deploy.

4. Nối menu/quyền/security và kiểm tra database theo tài liệu.
5. Build/test trong CRM đích, sau đó kiểm tra GHN Staging.

## Các thư mục

| Thư mục | Nội dung |
|---|---|
| `backend/` | 5 file backend Shipping và 2 file test hiện có |
| `frontend/` | Màn hình cấu hình, vận đơn/tracking, CSS và type giao tiếp với host |
| `integration/crm-overlay/` | Controller và form Sales để nối xác nhận báo giá với Shipping; test frontend |
| `integration/reference/` | Bản tham chiếu các file host có liên quan; không tự động chép vào host |
| `migrations/reference/` | 5 migration gốc, giữ nguyên để đối chiếu và không làm sai checksum |
| `docs/` | API, phụ thuộc, database và hướng dẫn kiểm thử |
| `scripts/` | Chép source, xác minh checksum, relay webhook và test relay |

## Phạm vi bàn giao

Giữ nguyên code xử lý đang có để giảm thay đổi nghiệp vụ. Chưa refactor toàn bộ thành adapter độc lập: `RetailAccess` và các truy vấn SQL vẫn phụ thuộc schema CRM. `integration/reference/` và tài liệu chỉ rõ các điểm đó cho người tích hợp. Với một hệ thống khác CRM này, cần viết adapter hoặc sửa các truy vấn tương ứng; không thể chỉ chép code rồi chạy.

Không có token GHN thật, file .env hay dữ liệu khách hàng. Tài khoản/shop/token được nhập trong giao diện cấu hình sau khi tích hợp. Không thay đổi CRM gốc.

`module-manifest.json` mô tả gói bàn giao, chưa phải cơ chế cài plugin tự động của host.

## Kiểm tra gói

```powershell
./scripts/verify-package.ps1
node --test scripts/ghn-webhook-relay.test.mjs
```

Xem `docs/VALIDATION.md` để biết kiểm tra đã chạy và các kiểm tra cần thực hiện trong CRM đích.

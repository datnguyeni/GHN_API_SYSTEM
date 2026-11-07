# Kết quả kiểm tra gói — 07/11/2026

## Demo độc lập bổ sung

- `npm run build`: PASS (TypeScript và Vite). Vite bỏ qua chỉ thị `use client` của các component CRM; không ảnh hưởng bản demo trình duyệt.
- `npm run test:demo`: 2/2 PASS, kiểm tra báo phí → xác nhận → tracking, báo phí không tái sử dụng, dữ liệu mới khi khởi tạo lại, gửi lại lỗi và thêm/sửa/xóa tài khoản mẫu.
- Kiểm tra trình duyệt: mở danh sách, chọn phiếu xuất/tỉnh/phường, nhập 1.200 gram, tính phí mẫu 36.000 đ, xác nhận và thấy `DEMO000001`, trạng thái chờ lấy hàng và lịch sử.
- Chưa chạy Docker build/Compose trên máy thực hiện vì không có Docker CLI/Desktop. Dockerfile dùng cùng lệnh build đã PASS; cần kiểm tra container trên máy có Docker.
- Demo chỉ dùng dữ liệu giả lập trong bộ nhớ; không thay thế các kiểm tra CRM, PostgreSQL và GHN Staging bên dưới.

## Gói tích hợp ban đầu

- 39 file nguồn được sao chép, giữ checksum SHA-256 và revision trong source-manifest.json.
- Test relay webhook: 2/2 PASS, dùng HTTP giả lập trên loopback, không gọi GHN thật.
- Script install-source: PASS chế độ WhatIf không chép file; thêm 16 file vào checkout mô phỏng; chạy lại bỏ qua file giống hệt; file có thay đổi bị từ chối và được giữ nguyên.
- Chạy WhatIf trên CRM nguồn: 0 file cần thêm, không sửa CRM.
- Chưa chạy build Java hoặc React: gói không có runtime/dependency độc lập; frontend nguồn chưa có node_modules. Cần chạy build/test trong CRM đích sau tích hợp.
- Chưa chạy transaction test PostgreSQL, migration trên database hoặc GHN Staging. Các bước này được mô tả tại TESTING.md.
- package-checksums.json bao phủ mọi file của gói trừ chính file checksum. Chạy scripts/verify-package.ps1 để xác minh bản bàn giao.

# Kiểm thử sau tích hợp

Trong backend CRM đích:

```powershell
mvn -Dtest=GhnOrderServiceTest,QuoteFulfillmentTransactionTest test
```

Test transaction cần PostgreSQL dùng riêng và các biến `FULFILLMENT_TX_TEST_URL`, `FULFILLMENT_TX_TEST_USER`, `FULFILLMENT_TX_TEST_PASSWORD`. Test chỉ nhận tên database có tiền tố `codex_fulfillment_tx_`; không dùng database thật. Không có cấu hình này thì các test transaction được skip.

Trong frontend CRM đích đã cài dependency:

```powershell
node --test tests/quote-fulfillment.test.mjs tests/shipping-preview.test.mjs
```

Trong thư mục gói:

```powershell
node --test scripts/ghn-webhook-relay.test.mjs
./scripts/verify-package.ps1
```

Kiểm tra GHN Staging: nhập shop, danh mục tỉnh/phường, preview, tạo vận đơn, retry sau timeout, webhook trùng/sai thứ tự, tenant/quyền, lỗi GHN không làm xuất kho thêm và GHN thành công nhưng CRM rollback không tạo trùng vận đơn. Kiểm tra cả đơn nhiều đợt xuất và COD/phí thực tế.

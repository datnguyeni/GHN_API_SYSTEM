import test from 'node:test';
import assert from 'node:assert/strict';
import { createDemoApi } from './mock-api.ts';

const base = '/api/v1/retail/shipping/ghn';
const post = (body: unknown) => ({ method: 'POST', body: JSON.stringify(body) });
test('demo: báo phí, xác nhận, tracking và chống xác nhận lại báo phí', async () => {
  const request = createDemoApi();
  const quote = await request<any>(base + '/orders/order-1/quote', post({ issueId: 'issue-order-1', shopRecordId: 'shop-1', recipient: { wardId: 101 }, weight: 1200, codAmount: 350000, paymentTypeId: 1 }));
  assert.equal(quote.totalFee, 36000);
  const result = await request<any>(base + '/orders/order-1/confirm', post({ quoteId: quote.quoteId }));
  assert.equal(result.deliveries[0].tracking, 'DEMO000001');
  assert.equal(result.deliveries[0].cod, 350000);
  assert.equal(result.issues.length, 0);
  assert.equal(result.events.length, 1);
  await assert.rejects(request(base + '/orders/order-1/confirm', post({ quoteId: quote.quoteId })));
  const orders = await request<any[]>(base + '/orders');
  assert.equal(orders[0].shipping_status, 'PREPARING');
  const fresh = await createDemoApi()<any[]>(base + '/orders');
  assert.equal(fresh[0].shipping_status, 'PENDING');
});
test('demo: gửi lại vận đơn lỗi, sửa/thêm/xóa tài khoản', async () => {
  const request = createDemoApi();
  const retried = await request<any>(base + '/orders/order-4/deliveries/delivery-4/retry', post({}));
  assert.equal(retried.deliveries[0].integration_status, 'CREATED');
  const created = await request<any>(base + '/import', post({ name: 'Shop test', shopId: 999, branchId: 'branch-1', warehouseId: 'warehouse-1', sender: {}, returnAddress: {} }));
  const path = base + '/accounts/' + created.accountId + '/shops/' + created.shopRecordId;
  await request(path, { method: 'PUT', body: JSON.stringify({ shopId: 888, branchId: 'branch-1', warehouseId: 'warehouse-1', sender: { name: 'Mẫu' }, returnAddress: {} }) });
  assert.equal((await request<any>(path)).shop_id, 888);
  await request(base + '/accounts/' + created.accountId, { method: 'DELETE' });
  assert.equal((await request<any>(base + '/accounts')).accounts.length, 1);
});

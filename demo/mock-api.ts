import type { ModuleRequest } from '../frontend/app/module-contract';

type Row = Record<string, any>;
const prefix = '/api/v1/retail/shipping/ghn';
const address = { name: 'Kho demo', phone: '0900000000', address: '123 Đường mẫu', provinceId: 201, provinceName: 'Hà Nội', wardId: 101, wardName: 'Phường mẫu' };
const provinces = [{ _id: 201, name: 'Hà Nội', status: 1 }, { _id: 202, name: 'TP. Hồ Chí Minh', status: 1 }];
const wards = [{ _id: 101, name: 'Phường mẫu 1', status: 1 }, { _id: 102, name: 'Phường mẫu 2', status: 1 }];

/** Per-page memory only: no network calls, credentials or persistent storage. */
export function createDemoApi(): ModuleRequest {
  const branches = [{ id: 'branch-1', name: 'Chi nhánh Hà Nội', code: 'HN' }];
  const warehouses = [{ id: 'warehouse-1', branch_id: 'branch-1', name: 'Kho trung tâm', code: 'KHO-HN' }];
  let accounts: Row[] = [{ account_id: 'account-1', name: 'GHN Demo', environment: 'STAGING', account_active: true, shop_record_id: 'shop-1', shop_id: 123456, shop_name: 'Shop Hà Nội', branch_id: 'branch-1', branch_name: branches[0].name, warehouse_id: 'warehouse-1', warehouse_name: warehouses[0].name, sender_snapshot: JSON.stringify(address), return_snapshot: JSON.stringify(address), is_default: true, shop_active: true, token_configured: true, default_payment_type_id: 1, default_required_note: 'CHOXEMHANGKHONGTHU', default_service_type_id: 2 }];
  const orders: Row[] = [
    { id: 'order-1', order_number: 'SO-DEMO-001', customer: 'Nguyễn An (mẫu)', warehouse: 'Kho trung tâm', shipping_status: 'PENDING', tracking: '' },
    { id: 'order-2', order_number: 'SO-DEMO-002', customer: 'Trần Bình (mẫu)', warehouse: 'Kho trung tâm', shipping_status: 'SHIPPING', tracking: 'DEMO000002' },
    { id: 'order-3', order_number: 'SO-DEMO-003', customer: 'Lê Chi (mẫu)', warehouse: 'Kho trung tâm', shipping_status: 'DELIVERED', tracking: 'DEMO000003' },
    { id: 'order-4', order_number: 'SO-DEMO-004', customer: 'Phạm Dũng (mẫu)', warehouse: 'Kho trung tâm', shipping_status: 'FAILED', tracking: '' }
  ];
  const delivery = (id: string, status: string): Row => ({ id: 'delivery-' + id, tracking: status === 'ERROR' ? '' : 'DEMO00000' + id, integration_status: status === 'ERROR' ? 'ERROR' : 'CREATED', carrier_status: status === 'ERROR' ? '' : status, status: 'SHIPPING', cod: 350000, fee: 32000, expected_delivery_at: '2026-11-10T10:00:00+07:00', last_error_message: status === 'ERROR' ? 'Lỗi giả lập: thử gửi lại để xem kết quả thành công.' : '' });
  const deliveries: Record<string, Row[]> = { 'order-1': [], 'order-2': [delivery('2', 'delivering')], 'order-3': [delivery('3', 'delivered')], 'order-4': [delivery('4', 'ERROR')] };
  const events: Record<string, Row[]> = {};
  for (const order of orders.slice(1, 3)) events[order.id] = [
    { id: order.id + '-created', event_time: '2026-11-07T08:00:00+07:00', carrier_order_code: order.tracking, carrier_status: 'ready_to_pick', reason: 'Sự kiện mẫu: đã tạo vận đơn' },
    { id: order.id + '-latest', event_time: '2026-11-07T14:00:00+07:00', carrier_order_code: order.tracking, carrier_status: order.id === 'order-3' ? 'delivered' : 'delivering', reason: 'Sự kiện tracking giả lập' }
  ];
  const quotes = new Map<string, Row>();
  function detail(order: Row): Row {
    return { ...order, status: 'CONFIRMED', canCreate: true,
      customer_snapshot: { name: order.customer, phone: '0900000001' }, shipping_address_snapshot: { fullAddress: '45 Đường demo, Hà Nội' },
      issues: deliveries[order.id].length ? [] : [{ id: 'issue-' + order.id, number: 'PX-' + order.order_number, warehouse_id: 'warehouse-1', warehouse: 'Kho trung tâm', outstanding: 350000 }],
      items: [{ id: 'line-' + order.id, issue_id: 'issue-' + order.id, name: 'Áo thun mẫu', qty: 2, unit: 'cái' }],
      shops: accounts.filter(a => a.shop_active).map(a => ({ ...a, id: a.shop_record_id })), deliveries: deliveries[order.id], events: events[order.id] ?? [] };
  }
  const handler = async (path: string, init?: RequestInit): Promise<unknown> => {
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    if (!path.startsWith(prefix + '/')) throw new Error('Đường dẫn ngoài phạm vi demo.');
    const route = path.slice(prefix.length);
    if (method === 'GET' && route.endsWith('/wards')) return wards;
    if (method === 'GET' && route.endsWith('/provinces')) return provinces;
    if (route === '/accounts' && method === 'GET') return { accounts, branches, warehouses };
    if (route === '/import' && method === 'POST') {
      if (!body.name || !body.shopId || !body.branchId || !body.warehouseId) throw new Error('Vui lòng nhập tên, Shop ID, chi nhánh và kho.');
      const id = crypto.randomUUID();
      accounts.push({ account_id: id, shop_record_id: 'shop-' + id, name: body.name, environment: body.environment, account_active: true, shop_active: true, shop_id: body.shopId, shop_name: body.shopName || body.name, branch_id: body.branchId, branch_name: branches[0].name, warehouse_id: body.warehouseId, warehouse_name: warehouses[0].name, sender_snapshot: JSON.stringify(body.sender), return_snapshot: JSON.stringify(body.returnAddress), token_configured: true, is_default: body.isDefault, default_service_type_id: body.defaultServiceTypeId, default_payment_type_id: body.defaultPaymentTypeId, default_required_note: body.defaultRequiredNote });
      return { accountId: id, shopRecordId: 'shop-' + id };
    }
    const accountMatch = route.match(/^\/accounts\/([^/]+)(?:\/shops\/([^/]+))?$/);
    if (accountMatch) {
      const account = accounts.find(a => a.account_id === accountMatch[1] && (!accountMatch[2] || a.shop_record_id === accountMatch[2]));
      if (!account) throw new Error('Không tìm thấy tài khoản mẫu.');
      if (method === 'GET') return account;
      if (method === 'DELETE') { accounts = accounts.filter(a => a.account_id !== account.account_id); return {}; }
      if (method === 'PUT') { Object.assign(account, { shop_id: body.shopId, branch_id: body.branchId, warehouse_id: body.warehouseId, sender_snapshot: JSON.stringify(body.sender), return_snapshot: JSON.stringify(body.returnAddress) }); return {}; }
    }
    if (route.endsWith('/webhook-secret') && method === 'POST') return { path: '/api/v1/webhooks/ghn/demo/demo', headerName: 'X-GHN-Webhook-Secret', secret: 'DEMO-ONLY-' + crypto.randomUUID() };
    if (route === '/orders' && method === 'GET') return orders;
    const orderMatch = route.match(/^\/orders\/([^/]+)(.*)$/);
    if (orderMatch) {
      const order = orders.find(o => o.id === orderMatch[1]);
      if (!order) throw new Error('Không tìm thấy đơn mẫu.');
      const action = orderMatch[2];
      if (!action && method === 'GET') return detail(order);
      if (action === '/quote' && method === 'POST') {
        if (!body.issueId || !body.shopRecordId || !body.recipient?.wardId || body.weight <= 0 || !body.weight) throw new Error('Chọn phiếu xuất, shop, địa chỉ và khối lượng hợp lệ.');
        const quote = { quoteId: crypto.randomUUID(), totalFee: 28000 + Math.ceil(body.weight / 1000) * 4000, codAmount: body.codAmount, paymentTypeId: body.paymentTypeId, expectedDeliveryTime: new Date(Date.now() + 3 * 86400000).toISOString(), orderId: order.id };
        quotes.set(quote.quoteId, quote); return quote;
      }
      if (method === 'POST' && (action === '/confirm' || /^\/deliveries\/[^/]+\/retry$/.test(action))) {
        let quote: Row | undefined;
        if (action === '/confirm') {
          quote = quotes.get(body.quoteId);
          if (!quote || quote.orderId !== order.id) throw new Error('Báo phí mẫu hết hiệu lực, hãy tính phí lại.');
          quotes.delete(body.quoteId);
        } else if (!deliveries[order.id].some(d => action.includes('/' + d.id + '/'))) throw new Error('Không tìm thấy vận đơn mẫu.');
        const d = delivery(order.id.slice(-1), 'ready_to_pick');
        if (quote) { d.cod = quote.codAmount; d.fee = quote.totalFee; d.expected_delivery_at = quote.expectedDeliveryTime; }
        deliveries[order.id] = [d]; order.tracking = d.tracking; order.shipping_status = 'PREPARING';
        events[order.id] = [{ id: crypto.randomUUID(), event_time: new Date().toISOString(), carrier_order_code: d.tracking, carrier_status: 'ready_to_pick', reason: 'Demo đã tạo vận đơn giả lập, chờ lấy hàng.' }];
        return detail(order);
      }
    }
    throw new Error(`Demo chưa hỗ trợ ${method} ${route}`);
  };
  return async <T>(path: string, init?: RequestInit): Promise<T> => structuredClone(await handler(path, init)) as T;
}

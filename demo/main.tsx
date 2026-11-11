import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './style.css';

type Shipment = { id: string; referenceCode: string; shopCode: string; state: string; trackingCode: string | null; carrierStatus: string | null; error: string | null };
const prefix = '/internal/shipping/ghn';
const sample = {
  referenceCode: 'WEB-123', shopCode: 'HCM-01',
  recipient: { name: 'Nguyễn Văn An', phone: '0901234567', address: '123 Nguyễn Huệ', provinceId: 1000001, wardId: 2000001 },
  weight: 1000, length: 30, width: 20, height: 10, codAmount: 250000, insuranceValue: 250000, serviceTypeId: 2, paymentTypeId: 1,
  items: [{ name: 'Áo thun', quantity: 1 }]
};
function App() {
  const [token, setToken] = useState('');
  const [mode, setMode] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [shipments, setShipments] = useState<Shipment[]>([]);
  const [shops, setShops] = useState<unknown[]>([]);
  const [body, setBody] = useState(JSON.stringify(sample, null, 2));
  const [key, setKey] = useState<string>(crypto.randomUUID());
  const [detail, setDetail] = useState<unknown>(null);
  const [filter, setFilter] = useState('');
  useEffect(() => { fetch('/health').then(r => r.json()).then(h => setMode(h.mode)).catch(() => setMode('offline')); }, []);
  async function request(path: string, data?: unknown, idempotencyKey?: string) {
    const response = await fetch(prefix + path, {
      method: data === undefined ? 'GET' : 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}) },
      ...(data === undefined ? {} : { body: JSON.stringify(data) })
    });
    const result = await response.json();
    if (!response.ok && !(response.status === 422 && result.id)) throw new Error(result.code + ': ' + (result.message ?? result.error ?? 'Yêu cầu thất bại'));
    return result;
  }
  async function run(action: () => Promise<void>) {
    setBusy(true); setMessage('');
    try { await action(); } catch (e) { setMessage(e instanceof Error ? e.message : 'Có lỗi xảy ra'); }
    finally { setBusy(false); }
  }
  async function refresh() {
    const [list, config] = await Promise.all([request('/shipments' + (filter ? '?referenceCode=' + encodeURIComponent(filter) : '')), request('/shops')]);
    setShipments(list); setShops(config);
  }
  async function send(preview: boolean) {
    const result = await request(preview ? '/preview' : '/create-order', JSON.parse(body), preview ? undefined : key);
    setDetail(result);
    setMessage(preview ? 'Đã tính phí từ dữ liệu vận chuyển.' : `Kết quả: ${result.state}. Giữ nguyên khóa khi gửi lại cùng yêu cầu.`);
    if (!preview) await refresh();
  }
  return <>
    <header><div><strong>GHN Shipping</strong><p>Dịch vụ vận chuyển độc lập</p></div><span className={'badge ' + mode}>{mode === 'mock' ? 'DEMO · Vận đơn giả lập' : mode === 'live' ? 'Kết nối GHN thật' : 'Chưa kết nối backend'}</span></header>
    <main>
      <section><h2>Kết nối hệ thống</h2><p>Nhập service access token để xem các shop và yêu cầu vận chuyển được cấp quyền. Token chỉ giữ trong bộ nhớ của trang.</p>
        <label>Service access token<input type="password" autoComplete="off" value={token} disabled={busy} onChange={e => { setToken(e.target.value); setShipments([]); setShops([]); setDetail(null); setMessage(''); }} /></label>
        <button disabled={busy || !token} onClick={() => run(refresh)}>Kết nối / tải lại</button>
        {shops.length > 0 && <details><summary>Shop được cấp quyền ({shops.length})</summary><pre>{JSON.stringify(shops, null, 2)}</pre></details>}
      </section>
      {message && <div className="message" role="status">{message}</div>}
      <div className="columns"><section><h2>Tạo yêu cầu vận chuyển</h2><p>Hệ thống gọi cung cấp người nhận, hàng gửi và COD. Người gửi lấy từ cấu hình shop.</p>
        <label>Idempotency-Key<input value={key} disabled={busy} onChange={e => setKey(e.target.value)} /></label>
        <label>Payload JSON<textarea spellCheck={false} rows={27} value={body} disabled={busy} onChange={e => setBody(e.target.value)} /></label>
        <div className="actions"><button disabled={busy || !token} onClick={() => run(() => send(true))}>Tính phí</button><button disabled={busy || !token || !key} onClick={() => run(() => send(false))}>Tạo vận đơn</button>
          <button className="secondary" disabled={busy} onClick={() => { setKey(crypto.randomUUID()); setDetail(null); setMessage('Khóa mới dành cho một đợt giao mới. Với yêu cầu UNKNOWN, hãy tra cứu GHN trước.'); }}>Đợt giao mới</button></div>
      </section><section><h2>Vận đơn của hệ thống</h2>
        <label>Mã tham chiếu<input value={filter} disabled={busy} placeholder="WEB-123" onChange={e => setFilter(e.target.value)} /></label>
        <button disabled={busy || !token} onClick={() => run(refresh)}>Tra cứu</button>
        {shipments.length === 0 && <p>Chưa có dữ liệu vận chuyển.</p>}
        <div className="shipments">{shipments.map(s => <article key={s.id}><strong>{s.referenceCode}</strong><span className="badge">{s.state}</span><p>{s.shopCode} · {s.trackingCode ?? 'Chưa có mã GHN'}</p><p>{s.carrierStatus ?? s.error ?? 'Đang xử lý'}</p>
          <div className="actions"><button className="secondary" disabled={busy} onClick={() => run(async () => setDetail(await request('/shipments/' + s.id)))}>Chi tiết</button>
            <button disabled={busy} onClick={() => run(async () => { setDetail(await request('/shipments/' + s.id + '/reconcile', {})); await refresh(); })}>Đồng bộ từ GHN</button></div>
        </article>)}</div>
        {detail !== null && <><h3>Kết quả / lịch sử</h3><pre>{JSON.stringify(detail, null, 2)}</pre></>}
      </section></div>
    </main>
  </>;
}
createRoot(document.getElementById('root')!).render(<App />);

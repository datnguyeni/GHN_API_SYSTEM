import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import GhnShippingWorkspace from '../frontend/app/retail/shipping/ghn-shipping-workspace';
import { createDemoApi } from './mock-api';
import './style.css';

const request = createDemoApi();
function App() {
  const [message, setMessage] = useState('');
  return <><aside className="demo-banner"><strong>GHN · Bản demo độc lập</strong><span>Dữ liệu giả lập · Không tạo vận đơn thật · Tải lại trang để khôi phục mẫu</span></aside>
    {message && <div className="demo-message" role="status">{message}<button onClick={() => setMessage('')}>Đóng</button></div>}
    <GhnShippingWorkspace view="retail-shipping" isCeo isPlatformAdmin request={request} apiUrl={window.location.origin}
      onNavigate={() => setMessage('Màn hình kho thuộc CRM. Trong demo, phiếu xuất mẫu đã được chuẩn bị sẵn trong đơn chờ giao.')} />
  </>;
}
createRoot(document.getElementById('root')!).render(<App />);

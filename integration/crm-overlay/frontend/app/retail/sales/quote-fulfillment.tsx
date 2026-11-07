"use client";

import { useEffect, useState } from "react";
import type { ModuleRequest } from "../../module-contract";
import { scheduleShippingPreview, shippingPreviewPayload, shippingPreviewReason, type ShippingFeeState } from "./shipping-preview";

type Row = Record<string, unknown>;
type Location = { _id: number; name: string; status?: number };
type Quote = { id: string; total?: unknown; metadata?: unknown; lines?: Row[] };
export type ShippingInput = {
  shopRecordId: string; recipient: { name: string; phone: string; address: string; provinceId: number; wardId: number };
  weight: number; length: number; width: number; height: number; serviceTypeId: number; paymentTypeId: number;
  codAmount: number; insuranceValue: number; requiredNote: string;
  items: { quoteLineId: string; quantity: number; weight: number; length: number; width: number; height: number; lot: string; serials: string[] }[];
};
const text = (row: Row, key: string) => String(row[key] ?? "");
export function initialShipping(quote: Quote): ShippingInput {
  const meta = (quote.metadata ?? {}) as Row, partner = (meta.partnerSnapshot ?? {}) as Row;
  return { shopRecordId: "", recipient: { name: text(partner, "name"), phone: text(partner, "phone"), address: text(meta, "address"), provinceId: 0, wardId: 0 },
    weight: 0, length: 0, width: 0, height: 0, serviceTypeId: 2, paymentTypeId: 1, codAmount: Number(quote.total ?? 0), insuranceValue: 0, requiredNote: "KHONGCHOXEMHANG",
    items: (quote.lines ?? []).map(line => ({ quoteLineId: text(line, "id"), quantity: Math.max(1, Math.ceil(Number(line.qty))), weight: 0, length: 0, width: 0, height: 0, lot: "", serials: [] })) };
}

export async function fulfillQuote(request: ModuleRequest, quoteId: string, body: unknown) {
  const result = await request<{ orderId: string; orderNumber: string; issueId: string; shippingError?: string; shipping?: { deliveries: Row[] } }>(
    `/api/v1/retail/quotes/${quoteId}/fulfillment`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const delivery = result.shipping?.deliveries?.[0];
  if (result.shippingError || !delivery || delivery.integration_status !== "CREATED") {
    throw new Error(`Đơn ${result.orderNumber} đã tạo, đã trừ tồn và phát sinh công nợ. ${result.shippingError || text(delivery ?? {}, "last_error_message") || "GHN đang xử lý, chưa có mã vận đơn."} Bấm xác nhận lại để kiểm tra/gửi tiếp; hệ thống không xuất kho lần nữa.`);
  }
  return { ...result, tracking: text(delivery, "tracking") };
}

export default function QuoteShippingFields({ quote, request, value, onChange, disabled }: {
  quote: Quote; request: ModuleRequest; value: ShippingInput; onChange: (value: ShippingInput) => void; disabled: boolean;
}) {
  const [shops, setShops] = useState<Row[]>([]), [provinces, setProvinces] = useState<Location[]>([]), [wards, setWards] = useState<Location[]>([]);
  const [error, setError] = useState(""), [loading, setLoading] = useState(true), [postedOrder,setPostedOrder] = useState(""), [attemptStatus,setAttemptStatus] = useState("");
  const [feeState, setFeeState] = useState<ShippingFeeState | null>(null), [feeRetry, setFeeRetry] = useState(0);
  const base = `/api/v1/retail/quotes/${quote.id}/fulfillment`;
  const reconciling = ["UNKNOWN", "CREATING", "CREATED"].includes(attemptStatus);
  const feePayload = JSON.stringify(shippingPreviewPayload(value));
  const feeKey = `${base}|${feePayload}|${feeRetry}`;
  const feeReason = !loading && value.shopRecordId && !shops.some(shop => shop.id === value.shopRecordId)
    ? "Chọn shop GHN đang hoạt động để tính phí." : shippingPreviewReason(value);
  // A result belongs to its exact shipping fields; edits immediately hide the old fee.
  const currentFee = feeState?.key === feeKey ? feeState : null;
  const expectedDelivery = currentFee?.fee?.expectedDeliveryTime ? new Date(currentFee.fee.expectedDeliveryTime) : null;
  useEffect(() => {
    let active = true; setLoading(true);
    Promise.all([request<Row[]>(base + "/shops"),request<{stockPosted:boolean;orderNumber?:string;attemptStatus?:string;shippingInput?:ShippingInput}>(base)]).then(([rows,state]) => { if (active) { setShops(rows);setAttemptStatus(state.attemptStatus||"");if(state.shippingInput?.items)onChange(state.shippingInput);if(state.stockPosted)setPostedOrder(state.orderNumber||""); } })
      .catch(e => { if (active) setError(e instanceof Error ? e.message : "Không tải được shop GHN."); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [base, request, onChange]);
  useEffect(() => {
    let active = true; setProvinces([]); setWards([]);
    if (value.shopRecordId) request<Location[]>(`${base}/shops/${value.shopRecordId}/provinces`)
      .then(rows => { if (active) { setProvinces(rows.filter(row => row.status === undefined || row.status === 1)); setError(""); } })
      .catch(e => { if (active) setError(e instanceof Error ? e.message : "Không tải được tỉnh/thành GHN."); });
    return () => { active = false; };
  }, [base, request, value.shopRecordId]);
  useEffect(() => {
    let active = true; setWards([]);
    if (value.shopRecordId && value.recipient.provinceId) request<Location[]>(`${base}/shops/${value.shopRecordId}/provinces/${value.recipient.provinceId}/wards`)
      .then(rows => { if (active) { setWards(rows.filter(row => row.status === undefined || row.status === 1)); setError(""); } })
      .catch(e => { if (active) setError(e instanceof Error ? e.message : "Không tải được phường/xã GHN."); });
    return () => { active = false; };
  }, [base, request, value.shopRecordId, value.recipient.provinceId]);
  useEffect(() => {
    if (loading || disabled || reconciling || feeReason) return;
    return scheduleShippingPreview(request, base, feePayload, feeKey, setFeeState);
  }, [base, request, feePayload, feeKey, feeReason, loading, disabled, reconciling]);
  const recipient = (key: "name" | "phone" | "address", next: string) => onChange({ ...value, recipient: { ...value.recipient, [key]: next } });
  const numberField = (key: "weight" | "length" | "width" | "height" | "codAmount" | "insuranceValue", label: string) =>
    <label key={key}><span>{label}</span><input required={key !== "codAmount" && key !== "insuranceValue"} type="number" min={key === "codAmount" || key === "insuranceValue" ? 0 : 1} step="1" value={value[key] || ""} onChange={event => onChange({ ...value, [key]: Number(event.target.value) })} /></label>;
  return <fieldset disabled={disabled || reconciling} className="quote-ghn-fields">
    <legend>Giao hàng GHN</legend>
    <p>Hệ thống kiểm tra phí GHN, rồi tạo đơn, xuất toàn bộ hàng và tạo vận đơn. GHN từ chối thì đơn, xuất kho và công nợ trong lần xác nhận mới sẽ rollback.</p>
    {postedOrder && <p role="status">Đơn {postedOrder} đã xuất kho. Xác nhận lại chỉ kiểm tra hoặc gửi tiếp GHN, không trừ tồn thêm.</p>}
    {!postedOrder && reconciling && <p role="status">Lần trước GHN có thể đã tạo vận đơn nhưng dữ liệu đơn và xuất kho chưa được lưu. Giữ nguyên thông tin; bấm xác nhận để đối soát cùng mã vận đơn.</p>}
    {error && <p role="alert">{error}</p>}
    {!loading && !shops.length && <p role="alert">Chưa có shop GHN hoạt động gắn với kho báo giá. CEO cần cấu hình GHN trước khi xác nhận.</p>}
    <div className="quote-review-grid">
      <label><span>Shop lấy hàng *</span><select required value={value.shopRecordId} onChange={event => {
        const shop = shops.find(row => row.id === event.target.value);
        onChange({ ...value, shopRecordId: event.target.value, recipient: { ...value.recipient, provinceId: 0, wardId: 0 },
          serviceTypeId: Number(shop?.default_service_type_id || 2), paymentTypeId: Number(shop?.default_payment_type_id || 1), requiredNote: String(shop?.default_required_note || "KHONGCHOXEMHANG") });
      }}><option value="">{loading ? "Đang tải shop…" : "Chọn shop GHN"}</option>{shops.map(shop => <option key={text(shop, "id")} value={text(shop, "id")}>{text(shop, "shop_name")} · {text(shop, "environment")}</option>)}</select></label>
      <label><span>Người nhận *</span><input required maxLength={160} value={value.recipient.name} onChange={event => recipient("name", event.target.value)} /></label>
      <label><span>Điện thoại nhận hàng *</span><input required type="tel" maxLength={20} value={value.recipient.phone} onChange={event => recipient("phone", event.target.value)} /></label>
      <label><span>Địa chỉ nhận hàng *</span><input required maxLength={1024} value={value.recipient.address} onChange={event => recipient("address", event.target.value)} /></label>
      <label><span>Tỉnh / thành GHN *</span><select required value={value.recipient.provinceId || ""} onChange={event => onChange({ ...value, recipient: { ...value.recipient, provinceId: Number(event.target.value), wardId: 0 } })}><option value="">Chọn tỉnh/thành</option>{provinces.map(row => <option key={row._id} value={row._id}>{row.name}</option>)}</select></label>
      <label><span>Phường / xã GHN *</span><select required value={value.recipient.wardId || ""} onChange={event => onChange({ ...value, recipient: { ...value.recipient, wardId: Number(event.target.value) } })}><option value="">Chọn phường/xã</option>{wards.map(row => <option key={row._id} value={row._id}>{row.name}</option>)}</select></label>
      {numberField("weight", "Tổng khối lượng (gram) *")}{numberField("length", "Dài (cm) *")}{numberField("width", "Rộng (cm) *")}{numberField("height", "Cao (cm) *")}
      {numberField("codAmount", "GHN thu hộ COD (đ)")}{numberField("insuranceValue", "Giá trị bảo hiểm (đ)")}
      <label><span>Dịch vụ GHN</span><select value={value.serviceTypeId} onChange={event => onChange({ ...value, serviceTypeId: Number(event.target.value) })}><option value={2}>Hàng nhẹ (dưới 20 kg)</option><option value={5}>Hàng nặng</option></select></label>
      <label><span>Người trả phí vận chuyển</span><select value={value.paymentTypeId} onChange={event => onChange({ ...value, paymentTypeId: Number(event.target.value) })}><option value={1}>Người gửi</option><option value={2}>Người nhận</option></select></label>
      <label><span>Yêu cầu giao</span><select value={value.requiredNote} onChange={event => onChange({ ...value, requiredNote: event.target.value })}><option value="KHONGCHOXEMHANG">Không cho xem hàng</option><option value="CHOXEMHANGKHONGTHU">Cho xem, không thử</option><option value="CHOTHUHANG">Cho thử hàng</option></select></label>
    </div>
    {value.items.map((item, index) => {
      const line = quote.lines?.find(line => line.id === item.quoteLineId) ?? {}, snap = (line.sku_snapshot ?? {}) as Row;
      const update = (next: Partial<typeof item>) => onChange({ ...value, items: value.items.map((row, i) => i === index ? { ...row, ...next } : row) });
      return <div key={item.quoteLineId} className="quote-ghn-package"><strong>{text(snap, "name") || text(snap, "code")} · {String(line.qty ?? "")} {String(line.unit ?? "")}</strong><div className="quote-review-grid">
        <label><span>Số đơn vị đóng gói *</span><input required type="number" min={1} step="1" value={item.quantity} onChange={event => update({ quantity: Number(event.target.value) })} /></label>
        {value.serviceTypeId === 5 && ([ ["weight", "Gram / kiện"], ["length", "Dài / kiện (cm)"], ["width", "Rộng / kiện (cm)"], ["height", "Cao / kiện (cm)"] ] as const).map(([key, label]) => <label key={key}><span>{label} *</span><input type="number" min={1} step="1" value={item[key] || ""} onChange={event => update({ [key]: Number(event.target.value) })} /></label>)}
        {text(snap, "tracking") === "SERIAL" && <label><span>Serial xuất kho (mỗi dòng một số) *</span><textarea required value={item.serials.join("\n")} onChange={event => update({ serials: event.target.value.split("\n") })} /></label>}
        {text(snap, "tracking") === "LOT" && <label><span>Mã lô xuất (để trống để tự chọn theo hạn)</span><input value={item.lot} onChange={event => update({ lot: event.target.value })} /></label>}
      </div></div>;
    })}
    <div className="quote-ghn-fee" aria-live="polite">
      <span>Phí vận chuyển GHN dự kiến</span>
      {loading ? <p role="status">Đang tải thông tin giao hàng…</p>
        : reconciling ? <p>Phí áp dụng theo lần xác nhận đã lưu; hệ thống sẽ đối soát vận đơn khi xác nhận lại.</p>
        : feeReason ? <p>{feeReason}</p>
        : currentFee?.status === "ready" && currentFee.fee ? <>
          <strong>{Number(currentFee.fee.totalFee).toLocaleString("vi-VN")} đ</strong>
          <p>{currentFee.fee.paymentTypeId === 1 ? "Người gửi trả phí" : "Người nhận trả phí"}
            {expectedDelivery && Number.isFinite(expectedDelivery.getTime()) && <> · Dự kiến giao: {expectedDelivery.toLocaleString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh" })}</>}</p>
          <small>Phí thực tế có thể thay đổi sau khi GHN cân đo. Phí được kiểm tra lại khi xác nhận đơn.</small>
        </>
        : currentFee?.status === "error" ? <><p role="alert">{currentFee.error}</p><button type="button" disabled={disabled} onClick={() => setFeeRetry(count => count + 1)}>Tính lại phí GHN</button></>
        : <p role="status">{currentFee?.status === "loading" ? "Đang tính phí GHN…" : "Đang chờ tính phí GHN…"}</p>}
    </div>
  </fieldset>;
}

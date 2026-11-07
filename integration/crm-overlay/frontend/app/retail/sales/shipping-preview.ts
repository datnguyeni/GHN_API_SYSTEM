import type { ModuleRequest } from "../../module-contract";
import type { ShippingInput } from "./quote-fulfillment";

export type ShippingFeePreview = { totalFee: number; paymentTypeId: number; expectedDeliveryTime?: string };
export type ShippingFeeState = { key: string; status: "loading" | "ready" | "error"; fee?: ShippingFeePreview; error?: string };
const integer = (value: number, min: number, max: number) => Number.isInteger(value) && value >= min && value <= max;

/** Package/recipient data used for the fee; warehouse serial/lot selections do not affect it. */
export function shippingPreviewPayload(value: ShippingInput) {
  return { ...value, items: value.items.map(({ quoteLineId, quantity, weight, length, width, height }) => ({ quoteLineId, quantity, weight, length, width, height })) };
}

export function shippingPreviewReason(value: ShippingInput): string {
  if (!value.shopRecordId) return "Chọn shop lấy hàng để tính phí GHN.";
  if (!value.recipient.name.trim() || !value.recipient.address.trim()) return "Nhập tên và địa chỉ người nhận để tính phí.";
  if (!/^(0|\+84)[0-9]{9,10}$/.test(value.recipient.phone.replace(/[ -]/g, ""))) return "Nhập số điện thoại người nhận hợp lệ để tính phí.";
  if (!value.recipient.provinceId || !value.recipient.wardId) return "Chọn tỉnh/thành và phường/xã người nhận để tính phí.";
  if (!integer(value.weight, 1, 50000) || ![value.length, value.width, value.height].every(v => integer(v, 1, 200))) return "Nhập khối lượng 1–50.000 gram và kích thước kiện 1–200 cm để tính phí.";
  if (![2, 5].includes(value.serviceTypeId) || (value.weight >= 20000 && value.serviceTypeId !== 5)) return "Kiện từ 20 kg cần chọn dịch vụ hàng nặng.";
  if (!integer(value.codAmount, 0, 50000000) || !integer(value.insuranceValue, 0, 5000000)) return "COD phải từ 0–50 triệu đồng, bảo hiểm từ 0–5 triệu đồng.";
  if (![1, 2].includes(value.paymentTypeId) || !value.requiredNote) return "Chọn bên trả phí và yêu cầu giao hàng.";
  if (!value.items.length || value.items.some(item => !integer(item.quantity, 1, 10000))) return "Nhập số đơn vị đóng gói cho từng sản phẩm.";
  if (value.serviceTypeId === 5) {
    if (value.items.some(item => !integer(item.weight, 1, 50000) || ![item.length, item.width, item.height].every(v => integer(v, 1, 200)))) return "Nhập khối lượng và kích thước từng kiện hàng nặng để tính phí.";
    if (value.items.reduce((sum, item) => sum + item.quantity * item.weight, 0) !== value.weight) return "Tổng khối lượng phải bằng tổng số kiện × khối lượng mỗi kiện.";
  }
  return "";
}

/** Debounce edits and ignore responses from a canceled/older set of shipping fields. */
export function scheduleShippingPreview(request: ModuleRequest, base: string, payload: string, key: string, update: (state: ShippingFeeState) => void, delay = 600) {
  let active = true;
  const timer = setTimeout(async () => {
    if (!active) return;
    update({ key, status: "loading" });
    try {
      const fee = await request<ShippingFeePreview>(base + "/preview", { method: "POST", headers: { "Content-Type": "application/json" }, body: payload });
      if (fee.totalFee == null || !Number.isFinite(Number(fee.totalFee)) || Number(fee.totalFee) < 0) throw new Error("GHN chưa trả phí vận chuyển hợp lệ.");
      if (active) update({ key, status: "ready", fee });
    } catch (error) {
      if (active) update({ key, status: "error", error: error instanceof Error ? error.message : "Chưa tính được phí GHN." });
    }
  }, delay);
  return () => { active = false; clearTimeout(timer); };
}

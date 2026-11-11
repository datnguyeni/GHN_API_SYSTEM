export class ApiError extends Error {
  constructor(status, code, message = code) { super(message); this.status = status; this.code = code; }
}
export function text(value, field, max = 250) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new ApiError(400, 'INVALID_FIELD', `${field} không hợp lệ`);
  return value.trim();
}
export function integer(value, field, min, max) {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new ApiError(400, 'INVALID_FIELD', `${field}: số nguyên từ ${min} đến ${max}`);
  return value;
}
export function address(input, label) {
  const a = input ?? {};
  const phone = text(a.phone, `${label}.phone`, 20).replace(/[ -]/g, '');
  if (!/^(0|\+84)[0-9]{9,10}$/.test(phone)) throw new ApiError(400, 'INVALID_PHONE');
  return { name: text(a.name, `${label}.name`), phone, address: text(a.address, `${label}.address`, 1024),
    provinceId: integer(a.provinceId, `${label}.provinceId`, 1, Number.MAX_SAFE_INTEGER),
    wardId: integer(a.wardId, `${label}.wardId`, 1, Number.MAX_SAFE_INTEGER) };
}
export function contract(input, shop) {
  const b = input ?? {};
  const serviceTypeId = integer(b.serviceTypeId ?? 2, 'serviceTypeId', 2, 5);
  const weight = integer(b.weight, 'weight', 1, 50000);
  if (![2, 5].includes(serviceTypeId) || (weight >= 20000 && serviceTypeId !== 5)) throw new ApiError(400, 'INVALID_SERVICE');
  const requiredNote = b.requiredNote ?? 'CHOXEMHANGKHONGTHU';
  if (!['KHONGCHOXEMHANG', 'CHOXEMHANGKHONGTHU', 'CHOTHUHANG'].includes(requiredNote)) throw new ApiError(400, 'INVALID_REQUIRED_NOTE');
  if (!Array.isArray(b.items) || !b.items.length || b.items.length > 100) throw new ApiError(400, 'INVALID_ITEMS');
  const items = b.items.map((item) => {
    const out = { name: text(item?.name, 'items.name'), quantity: integer(item?.quantity, 'items.quantity', 1, 10000) };
    if (serviceTypeId === 5) for (const key of ['weight', 'length', 'width', 'height']) out[key] = integer(item[key], `items.${key}`, 1, key === 'weight' ? 50000 : 200);
    return out;
  });
  if (serviceTypeId === 5 && items.reduce((sum, item) => sum + item.weight * item.quantity, 0) !== weight) throw new ApiError(400, 'INVALID_PACKAGE_WEIGHT');
  if (b.note !== undefined && (typeof b.note !== 'string' || b.note.length > 5000)) throw new ApiError(400, 'INVALID_NOTE');
  return { referenceCode: text(b.referenceCode, 'referenceCode', 100), shopCode: shop.code,
    recipient: address(b.recipient, 'recipient'), weight,
    length: integer(b.length, 'length', 1, 200), width: integer(b.width, 'width', 1, 200), height: integer(b.height, 'height', 1, 200),
    codAmount: integer(b.codAmount, 'codAmount', 0, 50000000), insuranceValue: integer(b.insuranceValue, 'insuranceValue', 0, 5000000),
    serviceTypeId, paymentTypeId: integer(b.paymentTypeId ?? 1, 'paymentTypeId', 1, 2), requiredNote, note: b.note ?? '', items };
}
export function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
  return JSON.stringify(value);
}

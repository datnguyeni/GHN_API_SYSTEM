import { ApiError } from './contract.mjs';

export class CarrierError extends Error {
  constructor(code, unknown = false) { super(code); this.code = code; this.unknown = unknown; }
}
export class GhnCarrier {
  constructor(fetcher = fetch) { this.fetch = fetcher; }
  async call(shop, path, body) {
    const origin = shop.environment === 'STAGING' ? 'https://dev-online-gateway.ghn.vn' : 'https://online-gateway.ghn.vn';
    let response;
    try {
      response = await this.fetch(origin + path, { method: body === undefined ? 'GET' : 'POST',
        headers: { Token: shop.token, ShopId: String(shop.shopId), 'Content-Type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(25000), redirect: 'error' });
    } catch { throw new CarrierError('GHN_UNAVAILABLE', true); }
    if (!response.ok) throw new CarrierError(`GHN_HTTP_${response.status}`, response.status >= 500 || [408, 429].includes(response.status));
    let result;
    try { result = await response.json(); } catch { throw new CarrierError('GHN_INVALID_RESPONSE', true); }
    if (result.code !== 200) throw new CarrierError('GHN_REJECTED', !Number.isInteger(result.code) || result.code >= 500);
    if (result.data === null || result.data === undefined) throw new CarrierError('GHN_INVALID_RESPONSE', true);
    return result.data;
  }
  async locations(shop, province) {
    const rows = [];
    for (let offset = 0; offset < 10000; offset += 200) {
      const path = province === undefined ? '/shiip/public-api/v3/master-data/province/all?' : `/shiip/public-api/v3/master-data/ward/all-by-province-id?province_id=${province}&`;
      const data = await this.call(shop, `${path}offset=${offset}&limit=200`);
      if (!Array.isArray(data)) throw new CarrierError('GHN_INVALID_RESPONSE', true);
      rows.push(...data.filter(row => row.status === undefined || row.status === 1));
      if (data.length < 200) return rows;
    }
    throw new CarrierError('GHN_LOCATION_LIMIT', true);
  }
  async resolvedAddress(shop, address) {
    const provinces = await this.locations(shop);
    const province = provinces.find(p => Number(p._id) === address.provinceId);
    if (!province) throw new ApiError(400, 'INVALID_PROVINCE');
    const ward = (await this.locations(shop, address.provinceId)).find(w => Number(w._id) === address.wardId);
    if (!ward) throw new ApiError(400, 'INVALID_WARD');
    return { ...address, provinceName: province.name, wardName: ward.name };
  }
  async payload(shop, input, id) {
    const out = { client_order_code: id, weight: input.weight, length: input.length, width: input.width, height: input.height,
      cod_amount: input.codAmount, insurance_value: input.insuranceValue, service_type_id: input.serviceTypeId,
      payment_type_id: input.paymentTypeId, required_note: input.requiredNote, note: input.note, items: input.items };
    for (const [prefix, address] of [['from', shop.sender], ['return', shop.returnAddress ?? shop.sender], ['to', input.recipient]]) {
      const a = await this.resolvedAddress(shop, address);
      for (const key of ['name', 'phone', 'address']) out[`${prefix}_${key}`] = a[key];
      out[`${prefix}_province_name`] = a.provinceName;
      out[`${prefix}_ward_name`] = a.wardName;
      out[`is_new_${prefix}_address`] = true;
    }
    return out;
  }
  create(shop, payload) { return this.call(shop, '/shiip/public-api/v2/shipping-order/create', payload); }
  preview(shop, payload) { return this.call(shop, '/shiip/public-api/v2/shipping-order/preview', payload); }
  lookup(shop, id) { return this.call(shop, '/shiip/public-api/v2/shipping-order/detail-by-client-code?client_order_code=' + encodeURIComponent(id)); }
}

// Explicit opt-in local demonstration. Never used as a fallback when GHN fails.
export class MockCarrier extends GhnCarrier {
  async locations(_shop, province) { return province === undefined ? [{ _id: 1000001, name: 'Tỉnh demo', status: 1 }] : [{ _id: 2000001, name: 'Phường demo', status: 1 }]; }
  async create(_shop, payload) { return { order_code: 'DEMO-' + payload.client_order_code, total_fee: 32000, expected_delivery_time: new Date(Date.now() + 259200000).toISOString(), status: 'ready_to_pick' }; }
  async preview() { return { total_fee: 32000 }; }
  async lookup(_shop, id) { return { order_code: 'DEMO-' + id, status: 'ready_to_pick' }; }
}

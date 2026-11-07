import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

const source = await readFile(new URL("../app/retail/sales/shipping-preview.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
const { shippingPreviewPayload, shippingPreviewReason, scheduleShippingPreview } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`);
const valid = () => ({ shopRecordId: "shop", recipient: { name: "Khách", phone: "0901234567", address: "123 A", provinceId: 1, wardId: 2 },
  weight: 1000, length: 20, width: 10, height: 10, serviceTypeId: 2, paymentTypeId: 1, codAmount: 0, insuranceValue: 0, requiredNote: "KHONGCHOXEMHANG",
  items: [{ quoteLineId: "line", quantity: 1, weight: 0, length: 0, width: 0, height: 0, lot: "lot-1", serials: ["serial-1"] }] });
const tick = () => new Promise(resolve => setTimeout(resolve, 20));

test("only complete valid light-parcel data is ready; zero COD and insurance are valid", () => {
  assert.equal(shippingPreviewReason(valid()), "");
  for (const change of [v => v.recipient.wardId = 0, v => v.weight = 0, v => v.length = 201, v => v.recipient.phone = "123", v => v.items[0].quantity = 0]) {
    const value = valid(); change(value); assert.notEqual(shippingPreviewReason(value), "");
  }
});

test("heavy parcels need individual measurements and the matching total weight", () => {
  const value = valid(); value.serviceTypeId = 5; value.weight = 20000;
  assert.notEqual(shippingPreviewReason(value), "");
  Object.assign(value.items[0], { quantity: 2, weight: 10000, length: 20, width: 10, height: 10 });
  assert.equal(shippingPreviewReason(value), "");
  value.weight = 21000; assert.notEqual(shippingPreviewReason(value), "");
});

test("warehouse lot and serial changes do not invalidate a fee; COD or dimensions do", () => {
  const value = valid(), before = JSON.stringify(shippingPreviewPayload(value));
  value.items[0].serials = ["serial-2"]; value.items[0].lot = "lot-2";
  assert.equal(JSON.stringify(shippingPreviewPayload(value)), before);
  assert.equal("serials" in shippingPreviewPayload(value).items[0], false);
  value.codAmount = 100; assert.notEqual(JSON.stringify(shippingPreviewPayload(value)), before);
});

test("editing before the debounce finishes does not send a preview", async () => {
  let requests = 0;
  const cancel = scheduleShippingPreview(async () => { requests++; }, "/fulfillment", "{}", "old", () => {}, 5);
  cancel(); await tick(); assert.equal(requests, 0);
});

test("a late response for older fields cannot overwrite the current fee", async () => {
  let resolveOld; const states = [];
  const cancel = scheduleShippingPreview(() => new Promise(resolve => { resolveOld = resolve; }), "/fulfillment", "{}", "old", state => states.push(state), 0);
  await tick(); assert.equal(states[0].status, "loading"); cancel();
  scheduleShippingPreview(async () => ({ totalFee: 20000, paymentTypeId: 1 }), "/fulfillment", "{}", "new", state => states.push(state), 0);
  await tick(); resolveOld({ totalFee: 99999, paymentTypeId: 1 }); await tick();
  assert.equal(states.at(-1).key, "new"); assert.equal(states.at(-1).fee.totalFee, 20000);
  assert.equal(states.some(state => state.key === "old" && state.status === "ready"), false);
});

test("zero fee is displayed as a valid preview and the endpoint receives only a dry-run request", async () => {
  const states = [];
  scheduleShippingPreview(async (path, options) => {
    assert.equal(path, "/fulfillment/preview"); assert.equal(options.method, "POST"); assert.equal(options.body, "{}");
    return { totalFee: 0, paymentTypeId: 2 };
  }, "/fulfillment", "{}", "current", state => states.push(state), 0);
  await tick(); assert.equal(states.at(-1).status, "ready"); assert.equal(states.at(-1).fee.totalFee, 0);
});

test("GHN errors and malformed fees produce an error instead of a misleading zero fee", async () => {
  for (const result of [new Error("GHN chưa hỗ trợ tuyến"), { totalFee: null }, { totalFee: -1 }]) {
    const states = [];
    scheduleShippingPreview(async () => { if (result instanceof Error) throw result; return result; }, "/fulfillment", "{}", "current", state => states.push(state), 0);
    await tick(); assert.equal(states.at(-1).status, "error"); assert.equal(states.at(-1).fee, undefined);
  }
});

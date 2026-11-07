import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

const source = await readFile(new URL("../app/retail/sales/quote-fulfillment.tsx", import.meta.url), "utf8");
// Exercise the request/result adapter without mounting the location-picker UI.
const helpers = source.slice(0, source.indexOf("export default function QuoteShippingFields"));
const compiled = ts.transpileModule(helpers, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
const { initialShipping, fulfillQuote } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`);

test("shipping starts with customer details and COD equal to the full quote total", () => {
  const shipping = initialShipping({ id: "q", total: "2250000", metadata: { address: "123 A", partnerSnapshot: { name: "Khách A", phone: "0901234567" } }, lines: [{ id: "line", qty: 2 }] });
  assert.equal(shipping.recipient.address, "123 A");
  assert.equal(shipping.recipient.phone, "0901234567");
  assert.equal(shipping.weight, 0);
  assert.equal(shipping.codAmount, 2250000);
  assert.equal(shipping.items[0].quoteLineId, "line");
});

test("confirmation uses the atomic fulfillment endpoint and shows GHN tracking only after creation", async () => {
  const body = { version: 3, shipping: { shopRecordId: "shop" } };
  const result = await fulfillQuote(async (path, options) => {
    assert.equal(path, "/api/v1/retail/quotes/q/fulfillment");
    assert.equal(options.method, "POST");assert.deepEqual(JSON.parse(options.body), body);
    return { orderId: "order", orderNumber: "SO-1", issueId: "issue", shipping: { deliveries: [{ integration_status: "CREATED", tracking: "GHN123" }] } };
  }, "q", body);
  assert.equal(result.tracking, "GHN123");assert.equal(result.orderId, "order");
});

test("carrier failure tells Sales that stock has already been deducted and retry must reuse it", async () => {
  await assert.rejects(() => fulfillQuote(async () => ({ orderNumber: "SO-2", shippingError: "GHN chưa phản hồi" }), "q", {}),
    error => /SO-2/.test(error.message) && /đã trừ tồn/.test(error.message) && /không xuất kho lần nữa/.test(error.message));
});

for (const status of ["QUEUED", "CREATING", "UNKNOWN", "ERROR"]) {
  test(`${status} never reports a successfully created GHN shipment`, async () => {
    await assert.rejects(() => fulfillQuote(async () => ({ orderNumber: "SO-3", shipping: { deliveries: [{ integration_status: status }] } }), "q", {}), /đã trừ tồn/);
  });
}

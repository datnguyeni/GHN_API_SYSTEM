import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { createWebhookRelay } from "./ghn-webhook-relay.mjs";

const path = "/api/v1/webhooks/ghn/00000000-0000-0000-0000-000000000001/00000000-0000-0000-0000-000000000002";
const listen = server => new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const stop = server => new Promise(resolve => server.close(resolve));

test("relay only forwards the configured POST webhook and strips unrelated credentials", async () => {
  let received = 0;
  const backend = createServer(async (request, response) => {
    received++; assert.equal(request.url, path); assert.equal(request.headers["x-ghn-webhook-secret"], "test-secret");
    assert.equal(request.headers.authorization, undefined);
    let body = ""; for await (const chunk of request) body += chunk;
    assert.deepEqual(JSON.parse(body), { Type: "create" });
    response.writeHead(200, { "Content-Type": "application/json" }); response.end('{"code":200}');
  });
  await listen(backend);
  const relay = createWebhookRelay({ backend: `http://127.0.0.1:${backend.address().port}`, callbackPath: path }); await listen(relay);
  const base = `http://127.0.0.1:${relay.address().port}`;
  try {
    for (const [route, method] of [["/api/v1/retail/catalog", "GET"], [path, "GET"], [path + "?extra=1", "POST"]]) {
      assert.equal((await fetch(base + route, { method })).status, 404);
    }
    assert.equal((await fetch(base + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })).status, 401);
    assert.equal(received, 0);
    const result = await fetch(base + path, { method: "POST", headers: { "Content-Type": "application/json", "X-GHN-Webhook-Secret": "test-secret", Authorization: "Bearer must-not-forward" }, body: '{"Type":"create"}' });
    assert.equal(result.status, 200); assert.deepEqual(await result.json(), { code: 200 }); assert.equal(received, 1);
  } finally { await stop(relay); await stop(backend); }
});

test("relay refuses oversized payloads and non-local forwarding targets", async () => {
  assert.throws(() => createWebhookRelay({ backend: "https://example.com", callbackPath: path }), /local backend/);
  assert.throws(() => createWebhookRelay({ backend: "http://127.0.0.1:8185", callbackPath: "/api/v1/retail" }), /exact tenant/);
  const relay = createWebhookRelay({ backend: "http://127.0.0.1:1", callbackPath: path, maxBytes: 10 }); await listen(relay);
  try {
    const response = await fetch(`http://127.0.0.1:${relay.address().port}${path}`, { method: "POST", headers: { "Content-Type": "application/json", "X-GHN-Webhook-Secret": "test-secret" }, body: JSON.stringify({ long: "payload bigger than limit" }) });
    assert.equal(response.status, 413);
  } finally { await stop(relay); }
});

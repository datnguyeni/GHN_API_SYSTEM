// Local relay for staging callbacks. A tunnel should point here, never at the whole CRM backend.
import { createServer } from "node:http";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";

export function createWebhookRelay({ backend, callbackPath, maxBytes = 256 * 1024 }) {
  const origin = new URL(backend);
  if (!["http:", "https:"].includes(origin.protocol) || !["127.0.0.1", "localhost", "[::1]"].includes(origin.hostname) || origin.username || origin.password) {
    throw new Error("Relay target must be a local backend URL without credentials.");
  }
  const uuid = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
  if (!new RegExp(`^/api/v1/webhooks/ghn/${uuid}/${uuid}$`, "i").test(callbackPath)) throw new Error("Use the exact tenant/account webhook path shown by CRM.");
  const reply = (response, status, message) => {
    response.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    response.end(JSON.stringify({ message }));
  };
  return createServer(async (request, response) => {
    if (request.method !== "POST" || request.url !== callbackPath) { request.resume(); reply(response, 404, "Not found"); return; }
    const secret = request.headers["x-ghn-webhook-secret"];
    if (typeof secret !== "string" || !secret || secret.length > 256) { request.resume(); reply(response, 401, "Webhook secret required"); return; }
    if (!request.headers["content-type"]?.toLowerCase().startsWith("application/json")) { request.resume(); reply(response, 415, "JSON required"); return; }
    try {
      let size = 0; const chunks = [];
      for await (const chunk of request) {
        size += chunk.length;
        if (size > maxBytes) { reply(response, 413, "Payload too large"); request.resume(); return; }
        chunks.push(chunk);
      }
      const upstream = await fetch(new URL(callbackPath, origin), {
        method: "POST", headers: { "Content-Type": "application/json", "X-GHN-Webhook-Secret": secret },
        body: Buffer.concat(chunks), signal: AbortSignal.timeout(10000), redirect: "error",
      });
      const body = await upstream.text();
      response.writeHead(upstream.status, { "Content-Type": "application/json", "Cache-Control": "no-store" }); response.end(body);
    } catch { if (!response.headersSent) reply(response, 502, "Local webhook backend unavailable"); }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { values } = parseArgs({ options: { backend: { type: "string", default: "http://127.0.0.1:8185" }, path: { type: "string" }, port: { type: "string", default: "8190" } } });
  if (!values.path) throw new Error("Provide --path /api/v1/webhooks/ghn/{tenantId}/{accountId}");
  const port = Number(values.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid local relay port");
  const relay = createWebhookRelay({ backend: values.backend, callbackPath: values.path });
  relay.listen(port, "127.0.0.1", () => console.log(`GHN relay: http://127.0.0.1:${port}${values.path}`));
  relay.on("error", error => { console.error(error.code || "Relay error"); process.exitCode = 1; });
  for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => relay.close());
}

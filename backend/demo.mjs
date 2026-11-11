process.env.GHN_MODE = 'mock';
process.env.GHN_CONFIG_FILE = 'config/demo.json';
process.env.GHN_DB_PATH = process.env.GHN_DB_PATH ?? 'data/demo.sqlite';
// Importing the server does not start a listener; compose the demo explicitly.
const { loadConfig } = await import('./config.mjs');
const { openStore } = await import('./store.mjs');
const { MockCarrier } = await import('./carrier.mjs');
const { ShippingService } = await import('./service.mjs');
const { createApp } = await import('./server.mjs');
const { WebhookDispatcher } = await import('./outbound-webhooks.mjs');
const db = openStore(process.env.GHN_DB_PATH);
const config = loadConfig(process.env.GHN_CONFIG_FILE);
const dispatcher = new WebhookDispatcher(db, config);
const server = createApp(new ShippingService(db, config, new MockCarrier()), { mode: 'mock' });
server.listen(Number(process.env.PORT ?? 8080), '127.0.0.1', () => { dispatcher.start(); console.log('GHN demo: http://127.0.0.1:' + (process.env.PORT ?? 8080)); });
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close(async () => { await dispatcher.stop(); db.close(); process.exit(0); }));

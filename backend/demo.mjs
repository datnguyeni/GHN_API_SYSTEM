process.env.GHN_MODE = 'mock';
process.env.GHN_CONFIG_FILE = 'config/demo.json';
process.env.GHN_DB_PATH = process.env.GHN_DB_PATH ?? 'data/demo.sqlite';
// Importing the server does not start a listener; compose the demo explicitly.
const { loadConfig } = await import('./config.mjs');
const { openStore } = await import('./store.mjs');
const { MockCarrier } = await import('./carrier.mjs');
const { ShippingService } = await import('./service.mjs');
const { createApp } = await import('./server.mjs');
const db = openStore(process.env.GHN_DB_PATH);
const server = createApp(new ShippingService(db, loadConfig(process.env.GHN_CONFIG_FILE), new MockCarrier()), { mode: 'mock' });
server.listen(Number(process.env.PORT ?? 8080), '127.0.0.1', () => console.log('GHN demo: http://127.0.0.1:' + (process.env.PORT ?? 8080)));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close(() => { db.close(); process.exit(0); }));

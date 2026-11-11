import { defineConfig } from 'vite';
export default defineConfig({ server: { proxy: { '/internal': 'http://127.0.0.1:8080', '/health': 'http://127.0.0.1:8080', '/webhooks': 'http://127.0.0.1:8080' } } });

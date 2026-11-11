import { PHASE_DEVELOPMENT_SERVER } from 'next/constants.js';
export default function config(phase) {
 if (phase === PHASE_DEVELOPMENT_SERVER) {
  const backend = (process.env.BACKEND_URL || 'http://127.0.0.1:8080').replace(/\/$/, '');
  return { async rewrites() { return ['/health', '/internal/:path*', '/webhooks/:path*'].map(source => ({source, destination: backend + source})); } };
 }
 return { output: 'export' };
}

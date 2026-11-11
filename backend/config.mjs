import { readFileSync } from 'node:fs';
import { address } from './contract.mjs';

export function validateConfig(config) {
  if (!Array.isArray(config.clients) || !config.clients.length || !Array.isArray(config.shops)) throw new Error('Config requires clients and shops');
  const unique = (rows, field) => new Set(rows.map(row => row[field])).size === rows.length;
  if (!unique(config.clients, 'id') || !unique(config.clients, 'token') || !unique(config.shops, 'code') || !unique(config.shops, 'shopId')) throw new Error('Duplicate client, token, shop code or GHN shop ID');
  for (const shop of config.shops) {
    if (typeof shop.code !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(shop.code) || typeof shop.name !== 'string' || !shop.name || !Number.isSafeInteger(shop.shopId) || shop.shopId <= 0 || !['STAGING', 'PRODUCTION'].includes(shop.environment)) throw new Error('Invalid shop configuration');
    if (typeof shop.token !== 'string' || !shop.token || typeof shop.webhookSecret !== 'string' || shop.webhookSecret.length < 32) throw new Error('GHN token and webhook secret (32+ characters) required');
    shop.sender = address(shop.sender, 'sender');
    if (shop.returnAddress) shop.returnAddress = address(shop.returnAddress, 'returnAddress');
  }
  for (const client of config.clients) {
    if (typeof client.id !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(client.id) || typeof client.token !== 'string' || client.token.length < 32 || !Array.isArray(client.shops) || client.shops.some(code => !config.shops.some(s => s.code === code))) throw new Error('Invalid client or shop access; service token must have 32+ characters');
  }
  return config;
}
export function loadConfig(filename) {
  if (!filename) throw new Error('Set GHN_CONFIG_FILE to a private JSON configuration file');
  return validateConfig(JSON.parse(readFileSync(filename, 'utf8')));
}

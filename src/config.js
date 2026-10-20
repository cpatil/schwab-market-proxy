import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const envFile = path.join(ROOT, '.env');
if (existsSync(envFile)) process.loadEnvFile(envFile);

function required(name) {
  const value = process.env[name]?.trim();
  return value ? value : null;
}

export function loadConfig(env = process.env) {
  const port = Number(env.PORT ?? 8787);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`PORT must be an integer from 1 to 65535, got "${env.PORT}"`);
  }
  const callbackUrl = env.SCHWAB_CALLBACK_URL?.trim() || 'https://127.0.0.1:8182';
  const parsed = new URL(callbackUrl);
  if (parsed.protocol !== 'https:') {
    throw new Error('SCHWAB_CALLBACK_URL must be https:// (Schwab rejects other schemes)');
  }
  const allowedHosts = list(env.ALLOWED_HOSTS).map((h) => h.toLowerCase());
  for (const h of allowedHosts) {
    if (!/^[a-z0-9.-]+$/.test(h)) throw new Error(`ALLOWED_HOSTS entry "${h}" must be a host name or IPv4 address, without port`);
  }
  return Object.freeze({
    port,
    bindHost: env.BIND_HOST?.trim() || '127.0.0.1',
    allowedHosts,
    clientId: required('SCHWAB_CLIENT_ID'),
    clientSecret: required('SCHWAB_CLIENT_SECRET'),
    callbackUrl,
    tokenFile: path.resolve(ROOT, env.TOKEN_FILE ?? 'data/tokens.json'),
    corsOrigins: list(env.CORS_ORIGINS),
  });
}

function list(value) {
  return (value ?? '').split(',').map((s) => s.trim()).filter(Boolean);
}

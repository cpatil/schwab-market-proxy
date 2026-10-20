import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { createApp } from '../src/server.js';
import { FakeWebSocket, fakeFetch } from './helpers.js';

let app;
let port;
let upstream;

before(async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'smp-server-'));
  const tokenFile = path.join(dir, 'tokens.json');
  await writeFile(tokenFile, JSON.stringify({
    access_token: 'access-1',
    refresh_token: 'refresh-1',
    expires_at: Date.now() + 3_600_000,
    refresh_expires_at: Date.now() + 86_400_000,
  }));
  upstream = fakeFetch((url) => ({ body: { echoed: url } }));
  app = await createApp({
    config: {
      port: 0,
      bindHost: '127.0.0.1',
      allowedHosts: ['spark.example.lan'],
      clientId: 'KEY',
      clientSecret: 'SECRET',
      callbackUrl: 'https://127.0.0.1',
      tokenFile,
      corsOrigins: [],
    },
    fetchImpl: upstream,
    WebSocketImpl: FakeWebSocket,
  });
  port = await app.listen(0);
});

after(() => app.close());

function request(pathname, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: pathname, method, headers: { Host: `127.0.0.1:${port}`, ...headers } }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

test('serves the dashboard with a strict CSP', async () => {
  const res = await request('/');
  assert.equal(res.status, 200);
  assert.match(res.headers['content-security-policy'], /script-src 'self'/);
  assert.match(res.body, /Schwab Market Proxy/);
});

test('rejects requests that arrive under a foreign Host name', async () => {
  const res = await request('/api/status', { headers: { Host: 'attacker.example:80' } });
  assert.equal(res.status, 421);
});

test('accepts ALLOWED_HOSTS names (any case) and treats them as the dashboard origin', async () => {
  const status = await request('/api/status', { headers: { Host: `SPARK.example.lan:${port}` } });
  assert.equal(status.status, 200);
  const login = await request('/api/auth/complete', {
    method: 'POST',
    headers: { Host: `spark.example.lan:${port}`, Origin: `http://spark.example.lan:${port}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ redirectUrl: 'not a url' }),
  });
  assert.equal(login.status, 400, 'reaches login validation instead of the cross-origin 403');
  const otherPort = await request('/api/status', { headers: { Host: 'spark.example.lan:1' } });
  assert.equal(otherPort.status, 421, 'the port is part of the allowed host');
});

test('rejects cross-origin login actions', async () => {
  const res = await request('/api/auth/complete', {
    method: 'POST',
    headers: { Origin: 'https://attacker.example', 'Content-Type': 'application/json' },
    body: JSON.stringify({ redirectUrl: 'https://127.0.0.1/?code=x&state=y' }),
  });
  assert.equal(res.status, 403);
});

test('/auth/start redirects to the Schwab login page', async () => {
  const res = await request('/auth/start');
  assert.equal(res.status, 302);
  assert.match(res.headers.location, /^https:\/\/api\.schwabapi\.com\/v1\/oauth\/authorize\?/);
});

test('market data passthrough keeps encoded symbols and query, adds the bearer token', async () => {
  const res = await request('/api/marketdata/%2FES/quotes?fields=quote');
  assert.equal(res.status, 200);
  const call = upstream.calls.at(-1);
  assert.equal(call.url, 'https://api.schwabapi.com/marketdata/v1/%2FES/quotes?fields=quote');
  assert.equal(call.init.headers.Authorization, 'Bearer access-1');
});

test('market data passthrough refuses to climb out of /marketdata/v1', async () => {
  const before = upstream.calls.length;
  const res = await request('/api/marketdata/%2E%2E/%2E%2E/trader/v1/accounts');
  assert.equal(res.status, 400);
  assert.equal(upstream.calls.length, before);
});

test('stream endpoint validates the service before opening SSE', async () => {
  const res = await request('/api/stream?service=NEWS_HEADLINE&keys=AAPL');
  assert.equal(res.status, 400);
  assert.equal(JSON.parse(res.body).error.code, 'bad_request');
});

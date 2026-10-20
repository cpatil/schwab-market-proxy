import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT, loadConfig } from './config.js';
import { ProxyError, badRequest } from './errors.js';
import { SERVICE_FIELDS, STREAM_SERVICES } from './fields.js';
import { SchwabApi } from './schwabApi.js';
import { SchwabAuth } from './schwabAuth.js';
import { Streamer } from './streamer.js';
import { TokenStore } from './tokenStore.js';

const STATIC = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/styles.css': ['styles.css', 'text/css; charset=utf-8'],
  '/format.js': ['format.js', 'text/javascript; charset=utf-8'],
  '/stream.js': ['stream.js', 'text/javascript; charset=utf-8'],
  '/options.js': ['options.js', 'text/javascript; charset=utf-8'],
};
const SSE_HEARTBEAT_MS = 15_000;
const MAX_JSON_BODY = 16 * 1024;

export async function createApp({ config = loadConfig(), fetchImpl = fetch, WebSocketImpl = globalThis.WebSocket } = {}) {
  const auth = new SchwabAuth({
    clientId: config.clientId,
    clientSecret: config.clientSecret,
    callbackUrl: config.callbackUrl,
    store: new TokenStore(config.tokenFile),
    fetchImpl,
  });
  await auth.init();
  const api = new SchwabApi({ auth, fetchImpl });
  const streamer = new Streamer({ api, auth, WebSocketImpl });

  const selfOrigins = new Set();
  const allowedHosts = new Set();
  const setPort = (port) => {
    selfOrigins.clear();
    allowedHosts.clear();
    // Loopback names always; LAN/tailnet names only when listed in ALLOWED_HOSTS.
    for (const host of ['127.0.0.1', 'localhost', '[::1]', ...(config.allowedHosts ?? [])]) {
      allowedHosts.add(`${host}:${port}`);
      selfOrigins.add(`http://${host}:${port}`);
    }
  };
  setPort(config.port);
  const hostHint = () => [...selfOrigins].join(', ');

  const server = http.createServer((req, res) => {
    handle(req, res).catch((err) => sendError(res, err));
  });

  async function handle(req, res) {
    // Reject DNS-rebinding style requests that arrive under a foreign Host name.
    if (!allowedHosts.has(String(req.headers.host ?? '').toLowerCase())) {
      return sendJson(res, 421, {
        error: { code: 'bad_host', message: `Unknown host name. Use one of: ${hostHint()} (add names to ALLOWED_HOSTS).` },
      });
    }
    const origin = req.headers.origin;
    const crossOrigin = origin && !selfOrigins.has(origin);
    if (crossOrigin && config.corsOrigins.includes(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
    }
    const url = new URL(req.url, `http://${req.headers.host}`);

    if (req.method === 'OPTIONS') {
      if (crossOrigin && config.corsOrigins.includes(origin)) {
        res.setHeader('Access-Control-Allow-Methods', 'GET');
        res.setHeader('Access-Control-Max-Age', '600');
        res.writeHead(204).end();
      } else res.writeHead(403).end();
      return;
    }

    if (req.method === 'GET' && STATIC[url.pathname]) {
      const [file, type] = STATIC[url.pathname];
      const body = await readFile(path.join(ROOT, 'public', file));
      res.writeHead(200, {
        'Content-Type': type,
        'Cache-Control': 'no-store',
        'Content-Security-Policy': "default-src 'self'; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'",
        'X-Content-Type-Options': 'nosniff',
      });
      return res.end(body);
    }

    if (req.method === 'GET' && url.pathname === '/api/status') {
      return sendJson(res, 200, { auth: auth.status(), stream: streamer.status(), services: STREAM_SERVICES });
    }
    if (req.method === 'GET' && url.pathname === '/api/fields') {
      return sendJson(res, 200, SERVICE_FIELDS);
    }

    // Login actions only from this app's own page.
    if (url.pathname.startsWith('/auth/') || url.pathname.startsWith('/api/auth/')) {
      if (crossOrigin) throw new ProxyError('forbidden_origin', 403, 'Login actions are only accepted from the local dashboard.');
      if (req.method === 'GET' && url.pathname === '/auth/start') {
        res.writeHead(302, { Location: auth.startLogin(), 'Cache-Control': 'no-store' });
        return res.end();
      }
      if (req.method === 'POST' && url.pathname === '/api/auth/complete') {
        const { redirectUrl } = await readJson(req);
        await auth.completeLogin(redirectUrl);
        return sendJson(res, 200, { auth: auth.status() });
      }
      if (req.method === 'POST' && url.pathname === '/api/auth/logout') {
        await readJson(req);
        await auth.logout();
        return sendJson(res, 200, { auth: auth.status() });
      }
    }

    // Match on the raw path: URL parsing would resolve %2E%2E segments before we see them,
    // and the passthrough must keep encoded segments such as %2FES intact.
    const rawPath = req.url.split('?')[0];
    if (req.method === 'GET' && rawPath.startsWith('/api/marketdata/')) {
      const upstream = await api.marketData(rawPath.slice('/api/marketdata/'.length), url.searchParams);
      res.writeHead(upstream.status, { 'Content-Type': upstream.contentType, 'Cache-Control': 'no-store' });
      return res.end(upstream.body);
    }

    if (req.method === 'GET' && url.pathname === '/api/stream') {
      return openEventStream(req, res, url);
    }

    sendJson(res, 404, { error: { code: 'not_found', message: `No route for ${req.method} ${url.pathname}` } });
  }

  function openEventStream(req, res, url) {
    const service = (url.searchParams.get('service') ?? 'LEVELONE_EQUITIES').toUpperCase();
    const keys = (url.searchParams.get('keys') ?? '').split(',');
    const write = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    // Validates service/keys before any bytes are sent, so errors are plain JSON.
    const unsubscribe = streamer.subscribe(service, keys, (ev) => write('data', ev));
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write('retry: 3000\n\n');
    write('status', streamer.status());
    const offStatus = streamer.onStatus((s) => write('status', s));
    const beat = setInterval(() => res.write(': keep-alive\n\n'), SSE_HEARTBEAT_MS);
    req.on('close', () => {
      clearInterval(beat);
      offStatus();
      unsubscribe();
    });
  }

  return {
    server,
    auth,
    streamer,
    listen(port = config.port) {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, config.bindHost ?? '127.0.0.1', () => {
          setPort(server.address().port);
          resolve(server.address().port);
        });
      });
    },
    async close() {
      streamer.close();
      server.closeAllConnections?.();
      await new Promise((r) => server.close(r));
    },
  };
}

async function readJson(req) {
  if (!String(req.headers['content-type'] ?? '').startsWith('application/json')) {
    throw badRequest('Send Content-Type: application/json');
  }
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_JSON_BODY) throw badRequest('Request body too large');
    chunks.push(chunk);
  }
  if (size === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw badRequest('Body is not valid JSON');
  }
}

function sendJson(res, status, body) {
  if (res.headersSent) return res.end();
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

function sendError(res, err) {
  if (err instanceof ProxyError) {
    return sendJson(res, err.status, { error: { code: err.code, message: err.message, details: err.details } });
  }
  console.error(err);
  sendJson(res, 500, { error: { code: 'internal', message: 'Internal error; see the server log.' } });
}

/** One line per login/streamer state change, for journald; never logs token values. */
function logLifecycle({ auth, streamer }) {
  const when = (ms) => (ms ? new Date(ms).toISOString() : 'n/a');
  const logAuth = (s) =>
    console.log(s.loggedIn ? `auth: logged in; re-login required by ${when(s.refreshExpiresAt)}` : 'auth: logged out');
  logAuth(auth.status());
  auth.onChange(logAuth);
  let last = '';
  streamer.onStatus((s) => {
    const line = `stream: ${s.state}${s.lastError ? ` (${s.lastError})` : ''}`;
    if (line !== last) console.log(line);
    last = line;
  });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const config = loadConfig();
  const app = await createApp({ config });
  const port = await app.listen();
  console.log(`Schwab market proxy listening on ${config.bindHost}:${port}`);
  console.log(`  reachable as: ${[`127.0.0.1`, 'localhost', ...config.allowedHosts].map((h) => `http://${h}:${port}`).join(', ')}`);
  if (config.bindHost !== '127.0.0.1' && config.allowedHosts.length === 0) {
    console.log('  note: BIND_HOST is not loopback but ALLOWED_HOSTS is empty, so remote requests will be rejected.');
  }
  if (!config.clientId || !config.clientSecret) console.log('Not configured yet: copy .env.example to .env and fill in your client ID/secret.');
  logLifecycle(app);
  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, async () => {
      await app.close();
      process.exit(0);
    });
  }
}

import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { SchwabAuth, TOKEN_URL } from '../src/schwabAuth.js';
import { TokenStore } from '../src/tokenStore.js';
import { fakeFetch } from './helpers.js';

async function makeAuth(handler, { now } = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), 'smp-auth-'));
  const store = new TokenStore(path.join(dir, 'tokens.json'));
  const fetchImpl = fakeFetch(handler);
  const auth = new SchwabAuth({ clientId: 'KEY', clientSecret: 'SECRET', callbackUrl: 'https://127.0.0.1', store, fetchImpl, now });
  await auth.init();
  return { auth, store, fetchImpl };
}

const tokenBody = (n) => ({ access_token: `access-${n}`, refresh_token: 'refresh-1', expires_in: 1800, token_type: 'Bearer', scope: 'api' });

test('login URL carries the client ID, callback and a fresh state', async () => {
  const { auth } = await makeAuth(() => ({}));
  const url = new URL(auth.startLogin());
  assert.equal(url.origin + url.pathname, 'https://api.schwabapi.com/v1/oauth/authorize');
  assert.equal(url.searchParams.get('client_id'), 'KEY');
  assert.equal(url.searchParams.get('redirect_uri'), 'https://127.0.0.1');
  assert.equal(url.searchParams.get('response_type'), 'code');
  assert.ok(url.searchParams.get('state').length >= 20);
});

test('completes login from the pasted redirect and stores tokens owner-only', async () => {
  const { auth, store, fetchImpl } = await makeAuth(() => ({ body: tokenBody(1) }));
  const state = new URL(auth.startLogin()).searchParams.get('state');
  // Schwab codes contain "@", which arrives percent-encoded.
  await auth.completeLogin(`https://127.0.0.1/?code=C0DE%40&session=s&state=${state}`);

  const call = fetchImpl.calls[0];
  assert.equal(call.url, TOKEN_URL);
  assert.equal(call.init.headers.Authorization, `Basic ${Buffer.from('KEY:SECRET').toString('base64')}`);
  const form = new URLSearchParams(call.init.body);
  assert.equal(form.get('grant_type'), 'authorization_code');
  assert.equal(form.get('code'), 'C0DE@');
  assert.equal(form.get('redirect_uri'), 'https://127.0.0.1');

  assert.equal(await auth.getAccessToken(), 'access-1');
  const saved = JSON.parse(await readFile(store.file, 'utf8'));
  assert.equal(saved.refresh_token, 'refresh-1');
  assert.equal((await stat(store.file)).mode & 0o777, 0o600);
});

test('rejects redirects for another host, without a code, or with an unknown state', async () => {
  const { auth, fetchImpl } = await makeAuth(() => ({ body: tokenBody(1) }));
  const state = new URL(auth.startLogin()).searchParams.get('state');
  await assert.rejects(auth.completeLogin(`https://evil.example/?code=x&state=${state}`), /callback URL/);
  await assert.rejects(auth.completeLogin(`https://127.0.0.1/?state=${state}`), /no "code"/);
  await assert.rejects(auth.completeLogin('https://127.0.0.1/?code=x&state=forged'), /stale/);
  await assert.rejects(auth.completeLogin('not a url'), /not a URL/);
  assert.equal(fetchImpl.calls.length, 0, 'no token request for rejected input');
});

test('refreshes an expiring access token once for concurrent callers', async () => {
  let t = 1_000_000;
  let n = 0;
  const { auth, fetchImpl } = await makeAuth(() => ({ body: tokenBody(++n) }), { now: () => t });
  const state = new URL(auth.startLogin()).searchParams.get('state');
  await auth.completeLogin(`https://127.0.0.1/?code=x&state=${state}`);

  t += 1800 * 1000; // access token now expired
  const [a, b] = await Promise.all([auth.getAccessToken(), auth.getAccessToken()]);
  assert.equal(a, 'access-2');
  assert.equal(b, 'access-2');
  assert.equal(fetchImpl.calls.length, 2, 'one code exchange + one shared refresh');
  assert.equal(new URLSearchParams(fetchImpl.calls[1].init.body).get('grant_type'), 'refresh_token');
});

test('a rejected refresh logs out; a network failure keeps the session', async () => {
  let t = 1_000_000;
  let mode = 'ok';
  const { auth } = await makeAuth(() => {
    if (mode === 'network') throw new Error('ECONNRESET');
    if (mode === 'reject') return { status: 400, body: { error: 'invalid_grant' } };
    return { body: tokenBody(1) };
  }, { now: () => t });
  const state = new URL(auth.startLogin()).searchParams.get('state');
  await auth.completeLogin(`https://127.0.0.1/?code=x&state=${state}`);
  t += 1800 * 1000;

  mode = 'network';
  await assert.rejects(auth.getAccessToken(), /Could not reach Schwab/);
  assert.equal(auth.status().loggedIn, true);

  mode = 'reject';
  await assert.rejects(auth.getAccessToken(), /invalid_grant/);
  assert.equal(auth.status().loggedIn, false);
});

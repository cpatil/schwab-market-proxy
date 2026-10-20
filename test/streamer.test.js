import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { Streamer } from '../src/streamer.js';
import { FakeWebSocket, STREAMER_INFO, fakeAuth, sleep } from './helpers.js';

const L1 = 'LEVELONE_EQUITIES';

function setup() {
  const auth = fakeAuth();
  const api = { userPreference: async () => ({ streamerInfo: [STREAMER_INFO] }) };
  const streamer = new Streamer({ api, auth, WebSocketImpl: FakeWebSocket, coalesceMs: 1, idleCloseMs: 20 });
  return { auth, streamer };
}

async function connectAndLogin(streamer) {
  await sleep(5);
  const ws = FakeWebSocket.instances.at(-1);
  ws.open();
  const login = ws.requests().find((r) => r.command === 'LOGIN');
  ws.receive({ response: [{ service: 'ADMIN', command: 'LOGIN', requestid: login.requestid, content: { code: 0, msg: 'ok' } }] });
  await sleep(5);
  return { ws, login };
}

beforeEach(() => {
  FakeWebSocket.instances.length = 0;
});

test('logs in with streamerInfo and subscribes the union of local keys', async () => {
  const { streamer } = setup();
  const off1 = streamer.subscribe(L1, ['aapl', 'MSFT'], () => {});
  const { ws, login } = await connectAndLogin(streamer);

  assert.equal(ws.url, STREAMER_INFO.streamerSocketUrl);
  assert.deepEqual(login.parameters, { Authorization: 'access-token', SchwabClientChannel: 'N9', SchwabClientFunctionId: 'APIAPP' });
  assert.equal(login.SchwabClientCustomerId, 'cust');
  assert.equal(streamer.state, 'ready');

  const subs = ws.requests().find((r) => r.command === 'SUBS');
  assert.equal(subs.service, L1);
  assert.equal(subs.parameters.keys, 'AAPL,MSFT');
  assert.equal(subs.parameters.fields.split(',').length, 52);

  const off2 = streamer.subscribe(L1, ['AAPL', 'SPY'], () => {});
  await sleep(5);
  const add = ws.requests().filter((r) => r.command === 'ADD');
  assert.deepEqual(add.map((r) => r.parameters.keys), ['SPY'], 'only the new key is added');

  off1();
  await sleep(5);
  const unsubs = ws.requests().filter((r) => r.command === 'UNSUBS');
  assert.deepEqual(unsubs.map((r) => r.parameters.keys), ['MSFT'], 'AAPL stays: another client still wants it');

  off2();
  await sleep(5);
  assert.deepEqual(ws.requests().filter((r) => r.command === 'UNSUBS').map((r) => r.parameters.keys).sort(), ['AAPL,SPY', 'MSFT']);
  await sleep(30);
  assert.equal(streamer.state, 'idle', 'closes the upstream after the idle delay');
  assert.ok(ws.closed);
});

test('merges level-one deltas and replays the snapshot to late subscribers', async () => {
  const { streamer } = setup();
  const seen = [];
  streamer.subscribe(L1, ['AAPL'], (ev) => seen.push(ev));
  const { ws } = await connectAndLogin(streamer);

  ws.receive({ data: [{ service: L1, timestamp: 1, command: 'SUBS', content: [{ key: 'AAPL', 1: 100, 2: 101 }] }] });
  ws.receive({ data: [{ service: L1, timestamp: 2, command: 'SUBS', content: [{ key: 'AAPL', 3: 100.5 }] }] });
  ws.receive({ data: [{ service: L1, timestamp: 3, command: 'SUBS', content: [{ key: 'MSFT', 3: 1 }] }] });

  assert.equal(seen.length, 2, 'MSFT was not requested by this client');
  assert.deepEqual(seen[1].fields, { BID_PRICE: 100, ASK_PRICE: 101, LAST_PRICE: 100.5 });
  assert.deepEqual(seen[1].changed, ['LAST_PRICE']);

  const late = [];
  streamer.subscribe(L1, ['AAPL'], (ev) => late.push(ev));
  assert.equal(late.length, 1);
  assert.deepEqual(late[0].fields, { BID_PRICE: 100, ASK_PRICE: 101, LAST_PRICE: 100.5 });
  streamer.close();
});

test('a failed streamer login schedules a reconnect and resubscribes after it', async () => {
  const { streamer } = setup();
  streamer.subscribe(L1, ['AAPL'], () => {});
  await sleep(5);
  const first = FakeWebSocket.instances.at(-1);
  first.open();
  const login = first.requests().find((r) => r.command === 'LOGIN');
  first.receive({ response: [{ service: 'ADMIN', command: 'LOGIN', requestid: login.requestid, content: { code: 3, msg: 'Login denied' } }] });
  await sleep(5);
  assert.equal(streamer.state, 'reconnecting');
  assert.match(streamer.lastError, /Login denied/);

  await sleep(1100); // first backoff step is 1s
  const second = FakeWebSocket.instances.at(-1);
  assert.notEqual(second, first);
  second.open();
  const login2 = second.requests().find((r) => r.command === 'LOGIN');
  second.receive({ response: [{ service: 'ADMIN', command: 'LOGIN', requestid: login2.requestid, content: { code: 0 } }] });
  await sleep(5);
  assert.equal(second.requests().find((r) => r.command === 'SUBS').parameters.keys, 'AAPL');
  streamer.close();
});

test('waits for login instead of retrying when logged out, then connects on login', async () => {
  const { streamer, auth } = setup();
  auth.loggedIn = false;
  auth.getAccessToken = async () => {
    const { notLoggedIn } = await import('../src/errors.js');
    throw notLoggedIn();
  };
  streamer.subscribe(L1, ['AAPL'], () => {});
  await sleep(5);
  assert.equal(streamer.state, 'waiting_for_login');
  assert.equal(FakeWebSocket.instances.length, 0);

  auth.getAccessToken = async () => 'access-token';
  auth.setLoggedIn(true);
  await sleep(5);
  assert.equal(FakeWebSocket.instances.length, 1);
  streamer.close();
});

test('keeps the internal spaces of option symbols in subscriptions and events', async () => {
  const { streamer } = setup();
  const contract = 'SPY   261023C00767000';
  const seen = [];
  streamer.subscribe('LEVELONE_OPTIONS', [` ${contract} `], (ev) => seen.push(ev));
  const { ws } = await connectAndLogin(streamer);
  const subs = ws.requests().find((r) => r.command === 'SUBS');
  assert.equal(subs.parameters.keys, contract);
  ws.receive({ data: [{ service: 'LEVELONE_OPTIONS', timestamp: 1, content: [{ key: contract, 2: 5.41, 28: 0.543 }] }] });
  assert.deepEqual(seen[0].fields, { BID_PRICE: 5.41, DELTA: 0.543 });
  streamer.close();
});

test('rejects unknown services and empty key lists', () => {
  const { streamer } = setup();
  assert.throws(() => streamer.subscribe('NEWS_HEADLINE', ['AAPL'], () => {}), /Unknown service/);
  assert.throws(() => streamer.subscribe(L1, [' ', ''], () => {}), /at least one key/);
});

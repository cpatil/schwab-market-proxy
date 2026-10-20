import { ProxyError, badRequest } from './errors.js';
import { STREAM_SERVICES, allFields, labelContent } from './fields.js';

const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 30_000;
const SILENCE_LIMIT_MS = 90_000; // the streamer sends heartbeats well inside this

/**
 * One upstream Schwab streamer connection shared by every local subscriber.
 *
 * Local subscriptions are reference-counted per (service, key). The upstream
 * subscription is reconciled to the union of what local clients want, and the
 * latest merged fields per key are kept so a new client gets values at once
 * (level-one updates carry only the fields that changed).
 */
export class Streamer {
  constructor({
    api,
    auth,
    WebSocketImpl = globalThis.WebSocket,
    idleCloseMs = 60_000,
    coalesceMs = 25,
    now = Date.now,
  }) {
    this.api = api;
    this.auth = auth;
    this.WebSocketImpl = WebSocketImpl;
    this.idleCloseMs = idleCloseMs;
    this.coalesceMs = coalesceMs;
    this.now = now;

    this.state = 'idle'; // idle | waiting_for_login | connecting | ready | reconnecting
    this.lastError = null;
    this.lastMessageAt = null;
    this.ws = null;
    this.session = null; // { customerId, correlId, channel, functionId }
    this.requestId = 0;
    this.loginRequestId = null;
    this.attempt = 0;

    this.wanted = new Map(); // service -> Map<key, refcount>
    this.active = new Map(); // service -> Set<key> currently subscribed upstream
    this.snapshots = new Map(); // `${service}\u0000${key}` -> merged labeled fields
    this.subscribers = new Set();
    this.statusListeners = new Set();
    this.timers = { sync: null, reconnect: null, idle: null, watchdog: null };

    auth.onChange((s) => {
      if (!s.loggedIn) this.#disconnect('waiting_for_login', 'Logged out');
      else if (this.#hasWanted() && (this.state === 'waiting_for_login' || this.state === 'idle')) this.#connect();
    });
  }

  status() {
    const services = {};
    for (const [svc, keys] of this.wanted) services[svc] = [...keys.keys()].sort();
    return {
      state: this.state,
      lastError: this.lastError,
      lastMessageAt: this.lastMessageAt,
      subscribers: this.subscribers.size,
      services,
    };
  }

  onStatus(fn) {
    this.statusListeners.add(fn);
    return () => this.statusListeners.delete(fn);
  }

  /**
   * @param {string} service e.g. LEVELONE_EQUITIES
   * @param {string[]} keys symbols
   * @param {(event: object) => void} listener receives { service, key, timestamp, fields, changed }
   * @returns {() => void} unsubscribe
   */
  subscribe(service, keys, listener) {
    if (!STREAM_SERVICES.includes(service)) {
      throw badRequest(`Unknown service "${service}"`, { services: STREAM_SERVICES });
    }
    const keySet = new Set(keys.map((k) => String(k).trim().toUpperCase()).filter(Boolean));
    if (keySet.size === 0) throw badRequest('Give at least one key, e.g. keys=AAPL,MSFT');

    const sub = { service, keys: keySet, listener };
    this.subscribers.add(sub);
    const counts = this.wanted.get(service) ?? new Map();
    this.wanted.set(service, counts);
    for (const key of keySet) counts.set(key, (counts.get(key) ?? 0) + 1);

    clearTimeout(this.timers.idle);
    this.timers.idle = null;
    for (const key of keySet) {
      const fields = this.snapshots.get(snapshotId(service, key));
      if (fields) safeCall(listener, { service, key, timestamp: null, fields, changed: [] });
    }
    this.#scheduleSync();
    if (this.state === 'idle' || this.state === 'waiting_for_login') this.#connect();
    this.#emitStatus();

    let done = false;
    return () => {
      if (done) return;
      done = true;
      this.subscribers.delete(sub);
      for (const key of keySet) {
        const n = (counts.get(key) ?? 1) - 1;
        if (n > 0) counts.set(key, n);
        else counts.delete(key);
      }
      if (counts.size === 0) this.wanted.delete(service);
      this.#scheduleSync();
      if (!this.#hasWanted()) {
        this.timers.idle = later(() => this.#disconnect('idle', null), this.idleCloseMs);
      }
      this.#emitStatus();
    };
  }

  close() {
    this.#disconnect('idle', null);
    for (const t of Object.values(this.timers)) clearTimeout(t);
  }

  // --- connection lifecycle -------------------------------------------------

  async #connect() {
    if (this.ws || this.state === 'connecting') return;
    clearTimeout(this.timers.reconnect);
    this.timers.reconnect = null;
    this.#setState('connecting');
    try {
      const prefs = await this.api.userPreference();
      const info = prefs?.streamerInfo?.[0];
      for (const f of ['streamerSocketUrl', 'schwabClientCustomerId', 'schwabClientCorrelId', 'schwabClientChannel', 'schwabClientFunctionId']) {
        if (typeof info?.[f] !== 'string' || !info[f]) {
          throw new ProxyError('upstream_error', 502, `userPreference.streamerInfo is missing ${f}`);
        }
      }
      const token = await this.auth.getAccessToken();
      if (!this.#hasWanted()) return this.#setState('idle');

      this.session = {
        customerId: info.schwabClientCustomerId,
        correlId: info.schwabClientCorrelId,
        channel: info.schwabClientChannel,
        functionId: info.schwabClientFunctionId,
      };
      const ws = new this.WebSocketImpl(info.streamerSocketUrl);
      this.ws = ws;
      ws.addEventListener('open', () => {
        this.loginRequestId = this.#nextId();
        this.#send([this.#request('ADMIN', 'LOGIN', this.loginRequestId, {
          Authorization: token,
          SchwabClientChannel: this.session.channel,
          SchwabClientFunctionId: this.session.functionId,
        })]);
      });
      ws.addEventListener('message', (ev) => this.#onMessage(ev.data));
      ws.addEventListener('error', () => {
        this.lastError = 'WebSocket error';
      });
      ws.addEventListener('close', (ev) => {
        if (this.ws !== ws) return;
        this.ws = null;
        this.active.clear();
        clearTimeout(this.timers.watchdog);
        this.lastError ??= `Streamer closed (code ${ev.code ?? '?'})`;
        this.#afterDrop();
      });
    } catch (err) {
      this.ws = null;
      if (err instanceof ProxyError && (err.code === 'not_logged_in' || err.code === 'not_configured' || err.code === 'token_rejected')) {
        this.lastError = err.message;
        return this.#setState('waiting_for_login');
      }
      this.lastError = err.message;
      this.#afterDrop();
    }
  }

  #afterDrop() {
    if (!this.#hasWanted()) return this.#setState('idle');
    if (!this.auth.status().loggedIn) return this.#setState('waiting_for_login');
    const delay = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** this.attempt);
    this.attempt += 1;
    this.#setState('reconnecting');
    this.timers.reconnect = later(() => this.#connect(), delay);
  }

  #disconnect(nextState, reason) {
    clearTimeout(this.timers.reconnect);
    clearTimeout(this.timers.watchdog);
    clearTimeout(this.timers.idle);
    this.timers.reconnect = this.timers.watchdog = this.timers.idle = null;
    const ws = this.ws;
    this.ws = null;
    this.active.clear();
    if (ws) {
      try {
        if (this.state === 'ready') this.#send([this.#request('ADMIN', 'LOGOUT', this.#nextId(), {})], ws);
        ws.close();
      } catch {
        /* already closing */
      }
    }
    if (nextState === 'idle') this.snapshots.clear();
    this.lastError = reason;
    this.#setState(nextState);
  }

  #armWatchdog() {
    clearTimeout(this.timers.watchdog);
    this.timers.watchdog = later(() => {
      this.lastError = `No messages from the streamer for ${SILENCE_LIMIT_MS / 1000}s`;
      try {
        this.ws?.close();
      } catch {
        /* ignore */
      }
    }, SILENCE_LIMIT_MS);
  }

  // --- protocol ---------------------------------------------------------------

  #onMessage(raw) {
    let msg;
    try {
      msg = JSON.parse(typeof raw === 'string' ? raw : Buffer.from(raw).toString('utf8'));
    } catch {
      this.lastError = 'Unparsable message from streamer';
      return;
    }
    this.lastMessageAt = this.now();
    this.#armWatchdog();

    for (const r of msg.response ?? []) {
      const code = r?.content?.code;
      if (Number(r?.requestid) === this.loginRequestId && r?.service === 'ADMIN' && r?.command === 'LOGIN') {
        if (code === 0) {
          this.attempt = 0;
          this.lastError = null;
          this.#setState('ready');
          this.#sync();
        } else {
          this.lastError = `Streamer login failed (code ${code}): ${r?.content?.msg ?? ''}`.trim();
          this.ws?.close();
        }
      } else if (code !== 0 && code !== undefined) {
        this.lastError = `${r.service} ${r.command} failed (code ${code}): ${r?.content?.msg ?? ''}`.trim();
        this.#emitStatus();
      }
    }

    for (const d of msg.data ?? []) {
      const service = d?.service;
      if (!STREAM_SERVICES.includes(service) || !Array.isArray(d.content)) continue;
      for (const item of d.content) {
        const key = typeof item?.key === 'string' ? item.key : null;
        if (!key) continue;
        const delta = labelContent(service, item);
        delete delta.key;
        const id = snapshotId(service, key);
        const fields = { ...(this.snapshots.get(id) ?? {}), ...delta };
        this.snapshots.set(id, fields);
        const event = { service, key, timestamp: d.timestamp ?? null, fields, changed: Object.keys(delta) };
        for (const sub of this.subscribers) {
          if (sub.service === service && sub.keys.has(key)) safeCall(sub.listener, event);
        }
      }
    }
  }

  #scheduleSync() {
    if (this.timers.sync) return;
    this.timers.sync = later(() => {
      this.timers.sync = null;
      this.#sync();
    }, this.coalesceMs);
  }

  /** Bring the upstream subscription in line with what local clients want. */
  #sync() {
    if (this.state !== 'ready' || !this.ws) return;
    const requests = [];
    const services = new Set([...this.wanted.keys(), ...this.active.keys()]);
    for (const service of services) {
      const want = new Set(this.wanted.get(service)?.keys() ?? []);
      const have = this.active.get(service) ?? new Set();
      const add = [...want].filter((k) => !have.has(k));
      const remove = [...have].filter((k) => !want.has(k));
      if (remove.length) {
        requests.push(this.#request(service, 'UNSUBS', this.#nextId(), { keys: remove.join(',') }));
        for (const k of remove) {
          have.delete(k);
          this.snapshots.delete(snapshotId(service, k));
        }
      }
      if (add.length) {
        const command = have.size === 0 ? 'SUBS' : 'ADD';
        requests.push(this.#request(service, command, this.#nextId(), { keys: add.join(','), fields: allFields(service) }));
        for (const k of add) have.add(k);
      }
      if (have.size) this.active.set(service, have);
      else this.active.delete(service);
    }
    if (requests.length) this.#send(requests);
  }

  #request(service, command, requestid, parameters) {
    return {
      service,
      command,
      requestid: String(requestid),
      SchwabClientCustomerId: this.session?.customerId,
      SchwabClientCorrelId: this.session?.correlId,
      parameters,
    };
  }

  #send(requests, ws = this.ws) {
    ws?.send(JSON.stringify({ requests }));
  }

  #nextId() {
    this.requestId += 1;
    return this.requestId;
  }

  #hasWanted() {
    return this.wanted.size > 0;
  }

  #setState(state) {
    this.state = state;
    this.#emitStatus();
  }

  #emitStatus() {
    const s = this.status();
    for (const fn of this.statusListeners) safeCall(fn, s);
  }
}

/** Timers never keep the process alive by themselves; the HTTP server does. */
function later(fn, ms) {
  return setTimeout(fn, ms).unref();
}

function snapshotId(service, key) {
  return `${service}\u0000${key}`;
}

function safeCall(fn, arg) {
  try {
    fn(arg);
  } catch (err) {
    console.error('stream listener failed:', err.message);
  }
}

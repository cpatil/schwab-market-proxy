export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Minimal stand-in for the WHATWG WebSocket the streamer uses. */
export class FakeWebSocket {
  static instances = [];

  constructor(url) {
    this.url = url;
    this.sent = [];
    this.closed = false;
    this.handlers = { open: [], message: [], close: [], error: [] };
    FakeWebSocket.instances.push(this);
  }

  addEventListener(type, fn) {
    this.handlers[type].push(fn);
  }

  send(text) {
    this.sent.push(JSON.parse(text));
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    queueMicrotask(() => this.handlers.close.forEach((fn) => fn({ code: 1000 })));
  }

  // test-side controls
  open() {
    this.handlers.open.forEach((fn) => fn({}));
  }

  receive(msg) {
    this.handlers.message.forEach((fn) => fn({ data: JSON.stringify(msg) }));
  }

  /** All requests sent so far, flattened. */
  requests() {
    return this.sent.flatMap((frame) => frame.requests);
  }
}

export const STREAMER_INFO = {
  streamerSocketUrl: 'wss://streamer.example.test/ws',
  schwabClientCustomerId: 'cust',
  schwabClientCorrelId: 'correl',
  schwabClientChannel: 'N9',
  schwabClientFunctionId: 'APIAPP',
};

export function fakeAuth({ loggedIn = true } = {}) {
  const listeners = new Set();
  return {
    loggedIn,
    onChange: (fn) => listeners.add(fn),
    status() {
      return { loggedIn: this.loggedIn };
    },
    async getAccessToken() {
      return 'access-token';
    },
    setLoggedIn(v) {
      this.loggedIn = v;
      for (const fn of listeners) fn(this.status());
    },
  };
}

/** A fetch double that records calls and answers from a handler. */
export function fakeFetch(handler) {
  const calls = [];
  const impl = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    const { status = 200, body = {}, headers = { 'content-type': 'application/json' } } = await handler(String(url), init);
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers });
  };
  impl.calls = calls;
  return impl;
}

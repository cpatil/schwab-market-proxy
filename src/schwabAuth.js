import { randomBytes } from 'node:crypto';
import { ProxyError, badRequest, notConfigured, notLoggedIn } from './errors.js';

export const AUTHORIZE_URL = 'https://api.schwabapi.com/v1/oauth/authorize';
export const TOKEN_URL = 'https://api.schwabapi.com/v1/oauth/token';

const REFRESH_TOKEN_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000; // Schwab: 7 days from login
const ACCESS_REFRESH_MARGIN_MS = 60 * 1000;
const PENDING_STATE_TTL_MS = 15 * 60 * 1000;

/**
 * OAuth 2 authorization-code flow against Schwab's own login page.
 * The user's Schwab password is entered only on schwab.com; this process
 * sees the one-time code from the redirect and the resulting tokens.
 */
export class SchwabAuth {
  constructor({ clientId, clientSecret, callbackUrl, store, fetchImpl = fetch, now = Date.now }) {
    this.clientId = clientId;
    this.clientSecret = clientSecret;
    this.callbackUrl = callbackUrl;
    this.store = store;
    this.fetch = fetchImpl;
    this.now = now;
    this.tokens = null;
    this.pendingStates = new Map();
    this.refreshing = null;
    this.listeners = new Set();
  }

  get configured() {
    return Boolean(this.clientId && this.clientSecret);
  }

  async init() {
    this.tokens = await this.store.load();
  }

  onChange(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  #emit() {
    for (const fn of this.listeners) fn(this.status());
  }

  status() {
    const t = this.tokens;
    return {
      configured: this.configured,
      loggedIn: Boolean(t),
      accessExpiresAt: t?.expires_at ?? null,
      refreshExpiresAt: t?.refresh_expires_at ?? null,
      callbackUrl: this.callbackUrl,
    };
  }

  /** Returns the Schwab login URL; the caller opens it in the user's browser. */
  startLogin() {
    if (!this.configured) throw notConfigured();
    this.#prunePendingStates();
    const state = randomBytes(18).toString('base64url');
    this.pendingStates.set(state, this.now());
    const url = new URL(AUTHORIZE_URL);
    url.search = new URLSearchParams({
      response_type: 'code',
      client_id: this.clientId,
      redirect_uri: this.callbackUrl,
      state,
    }).toString();
    return url.toString();
  }

  /** Accepts the full URL Schwab redirected to (pasted by the user). */
  async completeLogin(redirectedUrl) {
    if (!this.configured) throw notConfigured();
    let received;
    try {
      received = new URL(String(redirectedUrl).trim());
    } catch {
      throw badRequest('That is not a URL. Paste the whole address from the browser bar.');
    }
    const expected = new URL(this.callbackUrl);
    if (received.origin !== expected.origin || trimSlash(received.pathname) !== trimSlash(expected.pathname)) {
      throw badRequest(`The URL must start with your callback URL (${this.callbackUrl}).`);
    }
    const error = received.searchParams.get('error');
    if (error) throw badRequest(`Schwab returned an error: ${error}`);
    const code = received.searchParams.get('code');
    const state = received.searchParams.get('state');
    if (!code) throw badRequest('The URL has no "code" parameter. Did the login finish?');
    this.#prunePendingStates();
    if (!state || !this.pendingStates.has(state)) {
      throw badRequest('This login link is stale or was not started here. Start the login again.');
    }
    this.pendingStates.delete(state);

    const issuedAt = this.now();
    const body = await this.#tokenRequest({
      grant_type: 'authorization_code',
      code,
      redirect_uri: this.callbackUrl,
    });
    await this.#setTokens(body, issuedAt, issuedAt + REFRESH_TOKEN_LIFETIME_MS);
  }

  async logout() {
    this.tokens = null;
    this.pendingStates.clear();
    await this.store.clear();
    this.#emit();
  }

  /** A valid access token, refreshing it first when it is about to expire. */
  async getAccessToken() {
    if (!this.configured) throw notConfigured();
    if (!this.tokens) throw notLoggedIn();
    if (this.tokens.expires_at - ACCESS_REFRESH_MARGIN_MS > this.now()) return this.tokens.access_token;
    return this.refresh();
  }

  /** Forces a refresh; concurrent callers share one request. */
  async refresh() {
    if (!this.tokens) throw notLoggedIn();
    this.refreshing ??= (async () => {
      const previous = this.tokens;
      const issuedAt = this.now();
      try {
        const body = await this.#tokenRequest({
          grant_type: 'refresh_token',
          refresh_token: previous.refresh_token,
        });
        const rotated = body.refresh_token && body.refresh_token !== previous.refresh_token;
        await this.#setTokens(
          { ...body, refresh_token: body.refresh_token ?? previous.refresh_token },
          issuedAt,
          rotated ? issuedAt + REFRESH_TOKEN_LIFETIME_MS : previous.refresh_expires_at,
        );
        return this.tokens.access_token;
      } catch (err) {
        // Only a rejected grant means the session is over; keep tokens on network trouble.
        if (err instanceof ProxyError && err.code === 'token_rejected') await this.logout();
        throw err;
      } finally {
        this.refreshing = null;
      }
    })();
    return this.refreshing;
  }

  async #tokenRequest(params) {
    const basic = Buffer.from(`${this.clientId}:${this.clientSecret}`).toString('base64');
    let res;
    try {
      res = await this.fetch(TOKEN_URL, {
        method: 'POST',
        headers: {
          Authorization: `Basic ${basic}`,
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: 'application/json',
        },
        body: new URLSearchParams(params).toString(),
      });
    } catch (err) {
      throw new ProxyError('upstream_unreachable', 502, `Could not reach Schwab: ${err.message}`);
    }
    const text = await res.text();
    let body = null;
    try {
      body = JSON.parse(text);
    } catch {
      /* non-JSON error page */
    }
    if (!res.ok) {
      const reason = body?.error_description ?? body?.error ?? `HTTP ${res.status}`;
      const code = res.status === 400 || res.status === 401 ? 'token_rejected' : 'upstream_error';
      throw new ProxyError(code, 502, `Schwab token request failed: ${reason}`);
    }
    if (typeof body?.access_token !== 'string' || !Number.isFinite(body?.expires_in)) {
      throw new ProxyError('upstream_error', 502, 'Schwab token response was missing access_token or expires_in.');
    }
    return body;
  }

  async #setTokens(body, issuedAt, refreshExpiresAt) {
    this.tokens = {
      access_token: body.access_token,
      refresh_token: body.refresh_token,
      token_type: body.token_type,
      scope: body.scope,
      expires_at: issuedAt + body.expires_in * 1000,
      refresh_expires_at: refreshExpiresAt,
    };
    await this.store.save(this.tokens);
    this.#emit();
  }

  #prunePendingStates() {
    const cutoff = this.now() - PENDING_STATE_TTL_MS;
    for (const [state, at] of this.pendingStates) if (at < cutoff) this.pendingStates.delete(state);
  }
}

function trimSlash(p) {
  return p.length > 1 && p.endsWith('/') ? p.slice(0, -1) : p;
}

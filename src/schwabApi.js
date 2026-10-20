import { ProxyError, badRequest } from './errors.js';

export const API_BASE = 'https://api.schwabapi.com';

/**
 * Read-only REST access. Only /marketdata/v1 and the user-preference call the
 * streamer needs are reachable; trading and account endpoints are not exposed.
 */
export class SchwabApi {
  constructor({ auth, fetchImpl = fetch }) {
    this.auth = auth;
    this.fetch = fetchImpl;
  }

  /**
   * @param {string} rawSubpath path after /marketdata/v1/, still percent-encoded
   *   (so futures symbols such as %2FES stay one segment)
   * @param {URLSearchParams} query
   */
  marketData(rawSubpath, query) {
    return this.#get(`/marketdata/v1/${normalizeSubpath(rawSubpath)}`, query);
  }

  async userPreference() {
    const res = await this.#get('/trader/v1/userPreference', new URLSearchParams());
    if (res.status !== 200) {
      throw new ProxyError('upstream_error', 502, `userPreference returned HTTP ${res.status}`, safeJson(res.body));
    }
    return JSON.parse(res.body);
  }

  async #get(pathname, query) {
    const url = new URL(pathname, API_BASE);
    url.search = query.toString();
    let res = await this.#send(url, await this.auth.getAccessToken());
    if (res.status === 401) res = await this.#send(url, await this.auth.refresh());
    return res;
  }

  async #send(url, token) {
    let res;
    try {
      res = await this.fetch(url, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } });
    } catch (err) {
      throw new ProxyError('upstream_unreachable', 502, `Could not reach Schwab: ${err.message}`);
    }
    return {
      status: res.status,
      contentType: res.headers.get('content-type') ?? 'application/json',
      body: await res.text(),
    };
  }
}

export function normalizeSubpath(raw) {
  const segments = String(raw).split('/').filter(Boolean);
  if (segments.length === 0) throw badRequest('Missing market data path, e.g. /api/marketdata/quotes?symbols=AAPL');
  return segments
    .map((seg) => {
      let decoded;
      try {
        decoded = decodeURIComponent(seg);
      } catch {
        throw badRequest(`Bad percent-encoding in path segment "${seg}"`);
      }
      if (decoded === '.' || decoded === '..') throw badRequest('Relative path segments are not allowed');
      return encodeURIComponent(decoded);
    })
    .join('/');
}

function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

# Schwab Market Proxy

A local-only proxy and browser dashboard for **Schwab Trader API** market data:

- You log in on Schwab's own page (OAuth). The proxy never sees your password.
- `GET /api/marketdata/...` passes through to Schwab's read-only `/marketdata/v1` REST endpoints.
- The dashboard has a live watchlist and an options chain (calls/puts by strike,
  in-the-money shading, live bid/ask/IV/delta).
- `GET /api/stream` serves live streamer data as Server-Sent Events. One upstream
  WebSocket is shared by every local client; symbols are reference-counted, and the
  latest merged fields are replayed to new clients.
- Trading and account endpoints are deliberately not exposed.

No npm dependencies. Requires Node 22.4+ (global `fetch` and `WebSocket`).

## Setup

1. Create an app at <https://developer.schwab.com> with the **Market Data** (and
   **Accounts and Trading**, needed for `userPreference`, which tells the streamer who you are) products.
   Use the callback URL `https://127.0.0.1:8182`. Wait until the app status is
   **Ready For Use**.
2. `cp .env.example .env` and fill in `SCHWAB_CLIENT_ID`, `SCHWAB_CLIENT_SECRET` and the
   exact `SCHWAB_CALLBACK_URL` you registered.
3. `npm start`, then open <http://127.0.0.1:8787>.
4. Click **Open Schwab login**, sign in and approve. Schwab redirects to your callback
   URL, which won't load. Copy the whole address from the address bar, paste it into
   the dashboard, then click **Finish login**.

Tokens are stored in `data/tokens.json` (mode 0600, git-ignored). Access tokens refresh
automatically. Schwab refresh tokens last 7 days from login, so log in again weekly; see
[Re-authenticating](#re-authenticating-every-7-days).

## Re-authenticating (every 7 days)

Schwab issues two tokens at login:

| Token | Lifetime | Who renews it |
| --- | --- | --- |
| Access token | 30 minutes | The proxy, automatically, using the refresh token |
| Refresh token | 7 days from the moment you logged in | **You**, by logging in again on Schwab's page |

Nothing can extend the refresh token. Schwab requires an interactive login (password and
2-factor) at least once every 7 days.

**When is it due?**

- The dashboard header shows `Auth: OK · re-login by <date>`.
- `curl -s http://myserver.local:8787/api/status | jq -r '.auth.refreshExpiresAt | ./1000 | todate'` (UTC)
- The service log prints `auth: logged in; re-login required by <date>` at startup and whenever tokens change.

Renew any time before that date. A good habit is renewing on the same day each week, which
restarts the 7-day clock.

**Steps (from any device on your LAN or tailnet):**

1. Open the dashboard, e.g. `http://myserver.local:8787` (or `http://127.0.0.1:8787` on the server itself).
2. Click **Renew login** in the header. If the login has already expired, the login panel is
   shown without it.
3. Click **Open Schwab login**. In the new tab, sign in to Schwab (password and 2-factor)
   and approve access for the app and its accounts.
4. Schwab redirects to `https://127.0.0.1:8182/?code=…&session=…`. That page fails to load;
   this is expected. Copy the **whole address** from the address bar.
5. Back in the dashboard, paste it and click **Finish login**. Do it right away: the code is
   single-use and expires quickly.
6. The header shows the new `re-login by` date, one week out.

While renewing, the existing login keeps working and streams are not interrupted.

**If it lapses:** the next time the proxy needs a token, Schwab rejects the refresh and the
proxy logs out. REST calls then return HTTP 401 `not_logged_in` and streams report the state
`waiting_for_login`. Open SSE connections stay open. Once you log in, the proxy reconnects to
Schwab and resubscribes their symbols automatically, so clients don't have to reconnect.

**Troubleshooting**

| Message | Cause | Fix |
| --- | --- | --- |
| "This login link is stale or was not started here" | The login was started more than 15 minutes ago, before a proxy restart, or by a different proxy instance | Click **Open Schwab login** again and paste the new URL |
| "Schwab token request failed: invalid_grant" (or similar) | The code was already used or expired | Start the login again and paste promptly |
| "The URL must start with your callback URL" | Pasted the wrong address, or `SCHWAB_CALLBACK_URL` differs from the portal | Copy the `127.0.0.1:8182` address; check `.env` matches the portal exactly |
| Login works but streaming fails | The app lost the *Accounts and Trading Production* API in the portal | Re-add it on developer.schwab.com |

If you regenerate the client secret in the portal, update `SCHWAB_CLIENT_SECRET` in the
server's `.env`, run `systemctl --user restart schwab-market-proxy`, then log in again.

## Endpoints

| Endpoint | Purpose |
| --- | --- |
| `GET /api/stream?service=LEVELONE_EQUITIES&keys=AAPL,MSFT` | SSE. `data` events: `{service, key, timestamp, fields, changed}`; `status` events: streamer state. |
| `GET /api/marketdata/quotes?symbols=AAPL,MSFT` | Any `/marketdata/v1/...` path: `{symbol}/quotes`, `pricehistory`, `chains`, `expirationchain`, `movers/{index}`, `markets`, `instruments`. Percent-encode slashes in symbols (`%2FES`). |
| `GET /api/marketdata/expirationchain?symbol=SPY` | Option expirations (`expirationList[].expirationDate`, `daysToExpiration`, `expirationType`). |
| `GET /api/marketdata/chains?symbol=SPY&fromDate=2026-11-20&toDate=2026-11-20&strikeCount=20` | Option chain with bid/ask, volume, OI, IV (in percent) and greeks, in `callExpDateMap`/`putExpDateMap` keyed by expiration then strike. |
| `GET /api/stream?service=LEVELONE_OPTIONS&keys=SPY%20%20%20261120C00770000` | Live option quotes. Keys are the chain's `symbol` values, internal spaces included (URL-encoded). |
| `GET /api/fields` | Field names per streamer service. |
| `GET /api/status` | Login and streamer state. |

Streamer services: `LEVELONE_EQUITIES`, `LEVELONE_OPTIONS`, `LEVELONE_FUTURES`,
`LEVELONE_FUTURES_OPTIONS`, `LEVELONE_FOREX`, `CHART_EQUITY`, `CHART_FUTURES`,
`NYSE_BOOK`, `NASDAQ_BOOK`, `OPTIONS_BOOK`, `SCREENER_EQUITY`, `SCREENER_OPTION`.

```bash
curl -N 'http://127.0.0.1:8787/api/stream?service=LEVELONE_EQUITIES&keys=AAPL,SPY'
```

```python
import json, requests
with requests.get("http://127.0.0.1:8787/api/stream",
                  params={"service": "LEVELONE_EQUITIES", "keys": "AAPL"}, stream=True) as r:
    for line in r.iter_lines(decode_unicode=True):
        if line.startswith("data: "):
            print(json.loads(line[6:]))
```

## Run it on another machine (always on)

`deploy/schwab-market-proxy.service` is a systemd user unit (restart on failure,
start at boot with `loginctl enable-linger`). To reach it from other devices, set
in that machine's `.env`:

```
BIND_HOST=0.0.0.0
ALLOWED_HOSTS=192.168.1.50,myserver.local,myserver,myserver.example-tailnet.ts.net
```

Log in from any device: the Schwab redirect lands on *that device's*
`https://127.0.0.1:8182`, which won't load. Paste its address into the dashboard
as usual; the code is useless without the client secret, which stays on the server.

## Operating it as a service

Replace `server` below with your SSH host for the machine running the proxy.

```bash
ssh server systemctl --user status schwab-market-proxy             # state
ssh server journalctl --user -u schwab-market-proxy -f            # live log (no secrets)
ssh server systemctl --user restart schwab-market-proxy           # restart
```

Deploy code changes without copying `.env` or `data/` (the server keeps its own):

```bash
rsync -a --exclude .env --exclude data/ --exclude .git/ --exclude .claude/ --exclude '*.local.md' ./ server:schwab-market-proxy/
ssh server systemctl --user restart schwab-market-proxy
```

Changes to `public/` alone are served immediately without a restart. If a host firewall
(e.g. ufw) blocks the port, allow it from your LAN only, for example
`sudo ufw allow from 192.168.1.0/24 to any port 8787 proto tcp`.

Keep notes about your own deployment in a `*.local.md` file; those are git-ignored.

## Security model

- By default listens on `127.0.0.1` only. Every request's `Host` must be
  `127.0.0.1`, `localhost`, `[::1]` or an `ALLOWED_HOSTS` name, on the server's
  port (blocks DNS rebinding, and requests via unlisted interfaces).
- With `BIND_HOST=0.0.0.0`, anything that can reach a listed name can read market
  data and log the proxy in or out. Tokens and the client secret are never returned
  by any endpoint, and trading/account endpoints aren't exposed.
- Login and logout accept requests only from the dashboard's own origin, with JSON bodies.
- Other browser origins can read the proxy only if you list them in `CORS_ORIGINS`.
- Any local process can still read market data through the proxy; that is the point
  of a local proxy, so don't run it on a shared machine.

## Not included

- **News.** Schwab's public Trader API has no news endpoint or streamer service. The
  news inside thinkorswim comes from its private backend.
- Account and trading data. The `ACCT_ACTIVITY` streamer service and the trader
  endpoints exist, but are out of scope here.

Respect Schwab's API terms and market-data agreements. Data is for your own use.

## Tests

`npm test` runs the streamer, OAuth and HTTP tests against fakes. No Schwab account
is used, so real-provider behavior (login, streamer responses) still needs a live check.

## Disclaimer and credits

Not affiliated with or endorsed by Charles Schwab. You need your own Schwab developer app,
and you're responsible for following Schwab's API terms and your market-data agreements.

Streamer service and field numbering was cross-checked against
[schwab-py](https://github.com/alexgolec/schwab-py) (MIT).

## License

[MIT](LICENSE)

# Authentication

The proxy uses Schwab's OAuth 2.0 authorization-code flow. You sign in on Schwab's own page;
the proxy receives only the one-time code and exchanges it for tokens using the client secret.

## Token lifecycle

| Token | Lifetime | Renewed by |
| --- | --- | --- |
| Access token | 30 minutes | The proxy, automatically |
| Refresh token | 7 days from login | You, by logging in again |

The 7-day limit is set by Schwab and cannot be extended. Tokens are stored in `TOKEN_FILE`
(mode `0600`) and are never returned by the API.

## Checking the deadline

- The dashboard header shows `re-login by <date>`.
- `GET /api/status` returns `auth.refreshExpiresAt` in epoch milliseconds:

  ```bash
  curl -s http://127.0.0.1:8787/api/status | jq -r '.auth.refreshExpiresAt / 1000 | todate'
  ```

- The service log prints `auth: logged in; re-login required by <date>` whenever tokens change.

## Renewing

Renew any time before the deadline; each login restarts the 7-day window. Renewing does not
interrupt streams.

1. Open the dashboard and select **Renew login**. If the login has already expired, the login
   panel is shown instead.
2. Select **Open Schwab login**, sign in, and approve access for the app.
3. Schwab redirects to the callback URL (for example `https://127.0.0.1:8182/?code=…`). The
   page does not load; copy the full address from the address bar.
4. Paste it into the dashboard and select **Finish login**. Do this promptly: the code is
   single-use and short-lived.

The dashboard may be opened from any machine that can reach the proxy. The redirect lands on
that machine's own `127.0.0.1`, and the code is useless without the client secret, which
stays on the server.

## When the login lapses

On the next token refresh, Schwab rejects the expired refresh token and the proxy logs out.
REST calls then return `401 not_logged_in`, and streams report `waiting_for_login`. Open SSE
connections stay open; after the next login the proxy reconnects to Schwab and restores their
subscriptions, so clients do not need to reconnect.

## Troubleshooting

| Message | Cause | Resolution |
| --- | --- | --- |
| `This login link is stale or was not started here` | The login was started more than 15 minutes ago, before a restart, or by another proxy instance. | Start the login again and paste the new address. |
| `Schwab token request failed: …` | The code was already used or has expired. | Start the login again and paste promptly. |
| `The URL must start with your callback URL` | The wrong address was pasted, or `SCHWAB_CALLBACK_URL` differs from the portal. | Paste the callback address; make both settings identical. |
| Login succeeds but streaming fails | The app lacks *Accounts and Trading Production*. | Add the API to the app in the developer portal. |

After regenerating the client secret in the developer portal, update `SCHWAB_CLIENT_SECRET`,
restart the proxy, and log in again.

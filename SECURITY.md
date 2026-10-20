# Security policy

## Supported versions

Security fixes are made on the `main` branch only.

## Reporting a vulnerability

Report vulnerabilities privately through
[GitHub private vulnerability reporting](https://github.com/cpatil/schwab-market-proxy/security/advisories/new).
Do not open a public issue.

Include the affected commit, the configuration involved (for example `BIND_HOST` and
`ALLOWED_HOSTS`), and steps to reproduce. Never include access tokens, refresh tokens,
client secrets or account details; redact them from logs and requests.

This is a volunteer-maintained project without a response-time guarantee. Confirmed issues
are fixed on `main` and credited in the advisory unless you prefer otherwise.

## Scope

In scope: token storage and handling, Host and Origin enforcement, request forwarding to
Schwab, and the dashboard.

Out of scope: Schwab's APIs and services, and deployments that expose the proxy to untrusted
networks contrary to the [documentation](README.md#security).

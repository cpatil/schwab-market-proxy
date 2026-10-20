# Contributing

Issues and pull requests are welcome. For larger changes, open an issue first to agree on the
approach.

## Scope

The project is a read-only market-data proxy. Changes that place orders or expose account
data are out of scope.

## Development

Requires Node.js 22.4 or later. There are no dependencies to install.

```bash
npm test     # unit and HTTP tests against fakes; no Schwab account needed
npm start    # run locally with your .env
```

## Guidelines

- Add or update tests for every behavior change.
- Do not add runtime dependencies without prior discussion.
- Never commit `.env`, `data/`, tokens, client secrets or account details.
- State whether a change was verified against a live Schwab account; the tests cannot cover
  Schwab's actual responses.
- Use [Conventional Commits](https://www.conventionalcommits.org/) for commit messages and
  pull request titles, for example `fix(streamer): resubscribe after reconnect`.

## Security issues

Do not report vulnerabilities in public issues. Follow [SECURITY.md](SECURITY.md).

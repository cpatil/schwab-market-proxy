# Deployment

The proxy is a single Node.js process with no dependencies. For continuous availability, run
it as a systemd user service on an always-on Linux host.

Run one instance per Schwab login. Each instance keeps its own token store and streamer
connection.

## Install

```bash
git clone https://github.com/cpatil/schwab-market-proxy.git ~/schwab-market-proxy
cd ~/schwab-market-proxy
cp .env.example .env && chmod 600 .env    # set credentials and network settings

mkdir -p ~/.config/systemd/user
cp deploy/schwab-market-proxy.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now schwab-market-proxy
loginctl enable-linger "$USER"            # start at boot, without an open session
```

The unit expects the repository at `~/schwab-market-proxy` and Node.js at `/usr/bin/node`;
adjust `WorkingDirectory` and `ExecStart` otherwise. It restarts the process on failure.

Then log in from the dashboard as described in [Authentication](authentication.md).

## Network access

By default the proxy listens on loopback only. To serve other machines on a trusted network,
listen on all interfaces and list every name clients will use:

```ini
BIND_HOST=0.0.0.0
ALLOWED_HOSTS=192.168.1.50,myserver.local,myserver,myserver.example-tailnet.ts.net
```

Requests addressed to any other name are rejected with `421`. If a host firewall is active,
allow the port from the local network only, for example:

```bash
sudo ufw allow from 192.168.1.0/24 to any port 8787 proto tcp
```

Tailscale peers can connect through the tailnet IP or MagicDNS name once those are listed in
`ALLOWED_HOSTS`.

## Operations

```bash
systemctl --user status schwab-market-proxy     # state
journalctl --user -u schwab-market-proxy -f     # logs; tokens are never logged
systemctl --user restart schwab-market-proxy    # restart

git pull && systemctl --user restart schwab-market-proxy    # update
```

Changes under `public/` are served without a restart.

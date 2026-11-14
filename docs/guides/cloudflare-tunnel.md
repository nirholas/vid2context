# Run the remote MCP server at home behind a Cloudflare Tunnel

YouTube often refuses datacenter IPs ("Sign in to confirm you're not a bot"), but it rarely refuses a home connection. So the reliable way to give ChatGPT and Claude.ai a vid2context server is to run it on a machine at home and publish it through a Cloudflare Tunnel. The tunnel makes an outbound connection to Cloudflare, so you need no open ports, no public IP and no TLS certificate. Requests to YouTube still leave from your home IP.

```
ChatGPT / Claude.ai ──HTTPS──▶ Cloudflare ──tunnel──▶ cloudflared (home) ──▶ 127.0.0.1:8790 vid2context-mcp-http ──▶ YouTube
```

Written from Cloudflare's docs as checked on 2026-11-14 (create-local-tunnel, updated 2026-10-13; configuration file, 2026-11-10; Linux service, 2026-04-17; Access Managed OAuth, 2026-11-03). `cloudflared` was not installed on the machine this guide was written on, so the commands below were not run there.

## 1. Start the server

Follow [remote-mcp.md](remote-mcp.md) to set credentials. For connectors, `.env` needs at least:

```sh
VID2CONTEXT_OWNER_PASSWORD_HASH=scrypt:14:8:1:...:...    # npx tsx packages/mcp-http/src/bin.ts hash-password
VID2CONTEXT_MCP_PUBLIC_URL=https://mcp.vid2context.com
```

Then start it on loopback only:

```sh
npx tsx packages/mcp-http/src/bin.ts --port 8790 --host 127.0.0.1
```

Keep it on `127.0.0.1`: only `cloudflared` on the same machine needs to reach it. The server trusts Cloudflare's `CF-Connecting-IP` header for its login limits only when the connection comes from loopback, which is how `cloudflared` connects.

## 2. Create the tunnel

The domain must be on Cloudflare (vid2context.com is). Install `cloudflared` from Cloudflare's downloads page or your package manager, then:

```sh
cloudflared tunnel login                     # opens a browser, writes ~/.cloudflared/cert.pem
cloudflared tunnel create vid2context-mcp    # writes ~/.cloudflared/<TUNNEL-UUID>.json
cloudflared tunnel route dns vid2context-mcp mcp.vid2context.com
```

`~/.cloudflared/config.yml`:

```yaml
tunnel: <TUNNEL-UUID>
credentials-file: /home/<you>/.cloudflared/<TUNNEL-UUID>.json

ingress:
  - hostname: mcp.vid2context.com
    service: http://127.0.0.1:8790
  # Required catch-all: anything else gets a 404.
  - service: http_status:404
```

Check it, then run it:

```sh
cloudflared tunnel ingress validate
cloudflared tunnel run vid2context-mcp
```

`cloudflared` keeps the original `Host: mcp.vid2context.com`. That host passes the server's DNS-rebinding check because it matches `VID2CONTEXT_MCP_PUBLIC_URL`.

### A subdomain, not a path on vid2context.com

Use a hostname of its own, such as `mcp.vid2context.com`. The apex `vid2context.com` is served by the Cloudflare Worker (site and HTTP API). A Worker route takes precedence over DNS, so a tunnel cannot take over `/mcp` on the apex without the Worker forwarding those paths to the tunnel hostname.

With a subdomain, the connector URL is `https://mcp.vid2context.com/mcp`. The discovery documents (`/mcp/server-card`, `/.well-known/ai-catalog.json`) and the OAuth endpoints are all on that host.

## 3. Run both as services

`cloudflared` (Linux, with a config in your home directory):

```sh
sudo cloudflared --config /home/<you>/.cloudflared/config.yml service install
sudo systemctl start cloudflared
```

On macOS use `sudo cloudflared service install`. On Windows, `cloudflared.exe service install`. Both read the config from the default location.

The MCP server as a systemd unit, `/etc/systemd/system/vid2context-mcp-http.service`:

```ini
[Unit]
Description=vid2context remote MCP server
After=network-online.target

[Service]
User=<you>
WorkingDirectory=/home/<you>/vid2context
ExecStart=/usr/bin/env npx tsx packages/mcp-http/src/bin.ts --port 8790 --host 127.0.0.1
Restart=on-failure

[Install]
WantedBy=multi-user.target
```

```sh
sudo systemctl daemon-reload && sudo systemctl enable --now vid2context-mcp-http
journalctl -u vid2context-mcp-http -f        # logs go to stderr, so they land here
```

The server reads `.env` from `WorkingDirectory`. To keep OAuth tokens across restarts, enable a storage backend with key-value support (SQLite, see [library-sqlite.md](library-sqlite.md)). Otherwise every restart signs the connectors out.

## 4. Verify from outside

From another network (a phone hotspot works):

```sh
curl -s https://mcp.vid2context.com/.well-known/oauth-protected-resource/mcp
curl -s https://mcp.vid2context.com/.well-known/oauth-authorization-server
curl -si -X POST https://mcp.vid2context.com/mcp -H 'content-type: application/json' -d '{}' | head -5
#   HTTP/2 401 ... www-authenticate: Bearer realm="vid2context", resource_metadata="https://mcp.vid2context.com/.well-known/oauth-protected-resource/mcp", scope="mcp"
npx @modelcontextprotocol/inspector --cli https://mcp.vid2context.com/mcp --transport http \
  --method tools/list --header "Authorization: Bearer <static token>"
```

All of these should answer with JSON from your server. Then add the connector in ChatGPT or Claude.ai as described in [remote-mcp.md](remote-mcp.md).

## Cloudflare Access

Cloudflare Access (Zero Trust) can add a second sign-in in front of the server. Be careful: connectors are programs, not browsers.

- **Do not put Access in front of `/mcp`, `/oauth/token`, `/oauth/register` or `/.well-known/*`.** Without Access "Managed OAuth", a non-browser client gets a 302 to the Access login page instead of a token or metadata, and the ChatGPT and Claude.ai OAuth setup fails. With Managed OAuth turned on, Access becomes the OAuth server and expects the origin to validate Access JWTs. This server runs its own OAuth and does not validate them, and Cloudflare's docs say not to enable Managed OAuth for such servers.
- **What works:** an Access application only on `mcp.vid2context.com/oauth/authorize`, the one page a human opens in a browser, with a policy that allows only you (for example email one-time PIN or GitHub). The connector flow then asks for your Access login first and the owner password second. The machine-to-machine paths stay open and are protected by OAuth tokens. This setup was not tested live.
- **Cloudflare MCP server portals** put Access in front of an MCP server with Managed OAuth by default. They are a different setup from this guide. An open issue (anthropics/claude-ai-mcp#410) reports claude.ai web OAuth failing against a portal.

Optional extras that do not interfere with OAuth: a WAF rate-limiting rule on `/oauth/authorize`, and an IP allowlist for `/mcp` with OpenAI's egress ranges and Claude's `160.79.104.0/21`.

## When something fails

| Symptom | Fix |
|---|---|
| `cloudflared` logs `Unable to reach the origin service` | The MCP server is not running on `127.0.0.1:8790`, or the port in `config.yml` differs |
| 502 from Cloudflare | Same as above, or the server crashed: check `journalctl -u vid2context-mcp-http` |
| 403 `Host "..." is not allowed` | `VID2CONTEXT_MCP_PUBLIC_URL` is unset or names another host |
| OAuth discovery returns an HTML login page | Access is in front of the metadata paths; see above |
| YouTube still answers `blocked` | Requests are not leaving from home: make sure the server, not a cloud copy, is the one behind the tunnel |

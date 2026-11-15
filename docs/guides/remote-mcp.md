# Remote MCP for ChatGPT and Claude.ai

`vid2context-mcp-http` serves the vid2context MCP tools over Streamable HTTP at `/mcp`. They are the same tools the stdio server gives Claude Code. ChatGPT connectors and Claude.ai custom connectors can only reach a remote server over HTTPS, so this is how they use vid2context.

Connector requirements were checked on **2026-11-14** against these sources:

- The MCP authorization spec (2026-07-28 is current; Claude's docs cite 2025-11-25).
- OpenAI's Apps SDK auth page (developers.openai.com/apps-sdk/build/auth) and its plugin submission page.
- Anthropic's connector docs (claude.com/docs/connectors/building/authentication and /custom/remote-mcp).

These change often. If a step below no longer matches what you see, trust the vendor page.

## stdio or remote?

| You use | Pick | Why |
|---|---|---|
| Claude Code, Claude Desktop, Cursor, VS Code on the same machine | stdio (`vid2context-mcp`, see [mcp.md](mcp.md)) | No network, no auth, nothing to expose |
| ChatGPT (web, desktop, mobile) | remote | ChatGPT only connects to HTTPS servers |
| Claude.ai, Claude Desktop or mobile through your account's connectors | remote | Custom connectors are remote MCP servers |
| One server for several machines or people you trust | remote with static tokens | One token per person, revoke by removing it |

YouTube blocks many datacenter IPs. The robust setup runs the remote server at home, so requests come from your home IP, and exposes it with a Cloudflare Tunnel. See [cloudflare-tunnel.md](cloudflare-tunnel.md).

## Run it

```sh
npm install
npx tsx packages/mcp-http/src/bin.ts --port 8790        # the bin is also installed as vid2context-mcp-http
```

It listens on `127.0.0.1:8790` and loads `.env` from the working directory. With `--host 127.0.0.1` (the default), it refuses requests whose Host header is not a loopback name or the public host. That blocks DNS-rebinding attacks from web pages. Use `--host 0.0.0.0` only behind TLS.

Until you configure credentials, `/mcp` refuses every request.

Other settings, all optional (full list in [docs/providers.md](../providers.md)):

| Variable | Default | What it does |
|---|---|---|
| `VID2CONTEXT_MCP_PUBLIC_URL` | none | Public URL of the server, for example `https://mcp.vid2context.com`. Sets the OAuth resource and issuer and the allowed Host |
| `VID2CONTEXT_MCP_MODE` | `session` on Node, `stateless` elsewhere | `session` keeps an `Mcp-Session-Id` per client in memory; `stateless` builds a server per request (GET and DELETE answer 405) |
| `VID2CONTEXT_MCP_SESSION_IDLE_SEC` | `1800` | Session mode: close a session after this many idle seconds |
| `VID2CONTEXT_MCP_RATE_LIMIT` | `120` | Requests per minute per token; `0` turns the limit off |
| `VID2CONTEXT_MCP_MAX_BODY_KB` | `1024` | Largest request body on `/mcp` and `/oauth/*`; larger bodies get 413 |
| `VID2CONTEXT_MCP_ALLOWED_HOSTS` | none | Extra Host header values the DNS-rebinding check accepts |
| `VID2CONTEXT_CORS_ORIGINS` | none | Browser origins allowed to call `/mcp` |

## Option 1: static tokens

This is the simplest option. Use it for Claude Code, the MCP Inspector, scripts and Claude.ai's request-header option.

```sh
# .env
VID2CONTEXT_MCP_TOKENS=<openssl rand -base64 32>      # comma-separate several tokens
```

Clients send `Authorization: Bearer <token>`. Tokens are compared by SHA-256 hash in constant time, and the server never logs them.

```sh
claude mcp add --transport http vid2context https://mcp.vid2context.com/mcp \
  --header "Authorization: Bearer <token>"

npx @modelcontextprotocol/inspector --cli http://127.0.0.1:8790/mcp --transport http \
  --method tools/list --header "Authorization: Bearer <token>"
```

## Option 2: OAuth for connectors

ChatGPT and Claude.ai sign in with OAuth. The server includes a small OAuth 2.1 authorization server built for exactly one person: you.

1. Make a password hash. Use a long passphrase; it is the only thing between the internet and your tools.

   ```sh
   npx tsx packages/mcp-http/src/bin.ts hash-password     # prompts; or pipe the password on stdin
   ```

2. Put it and your public URL in `.env`:

   ```sh
   VID2CONTEXT_OWNER_PASSWORD_HASH=scrypt:14:8:1:...:...
   VID2CONTEXT_MCP_PUBLIC_URL=https://mcp.vid2context.com
   ```

   `VID2CONTEXT_MCP_PUBLIC_URL` matters behind a tunnel or proxy. Tokens are bound to `<public URL>/mcp`, and the metadata tells clients where to sign in.

3. Restart. These now answer:
   - `/.well-known/oauth-protected-resource/mcp` (RFC 9728)
   - `/.well-known/oauth-authorization-server` (RFC 8414)
   - `/oauth/register`, `/oauth/authorize`, `/oauth/token` and `/oauth/revoke`

### What the server implements

| Requirement (ChatGPT, Claude, MCP spec) | Here |
|---|---|
| 401 with `WWW-Authenticate: Bearer resource_metadata="..."` | Yes, with `scope="mcp"` |
| Protected resource metadata, `authorization_servers` | Yes, at the root and path-inserted (`/mcp`) |
| Authorization server metadata with `code_challenge_methods_supported: ["S256"]` | Yes. ChatGPT refuses servers without it |
| Client ID Metadata Documents (preferred by both) | Yes: `client_id_metadata_document_supported: true` and `none` in `token_endpoint_auth_methods_supported`, which Claude checks for |
| Dynamic client registration (RFC 7591, deprecated but still used) | Yes, with redirect URI checks: https, or http on localhost with any port |
| PKCE S256 only | Yes. `plain` and missing challenges are refused |
| `resource` (RFC 8707) on authorize and token, audience-bound tokens | Yes. Tokens for another resource are refused |
| `iss` in the authorization response (RFC 9207) | Yes, so ChatGPT uses `https://chatgpt.com/connector_platform_oauth_redirect` |
| Rotating refresh tokens for public clients, `invalid_grant` when stale | Yes. Reusing a rotated-out refresh token revokes every token from that sign-in |
| Form-encoded `/token` | Yes (JSON is accepted too) |

Access tokens last 1 hour and refresh tokens 30 days (`VID2CONTEXT_OAUTH_ACCESS_TTL_SEC`, `VID2CONTEXT_OAUTH_REFRESH_TTL_SEC`). Both are opaque random values, stored only as SHA-256 hashes.

### The sign-in page

When a connector starts OAuth, your browser opens `/oauth/authorize` on your server. The page shows:

- which app is asking (from its registration or metadata document)
- where it will send you back
- the access it gets

Enter the owner password and choose Allow. The page is plain HTML with no scripts or outside assets, served with a strict Content-Security-Policy and a CSRF token. Wrong passwords are limited to 5 per address per 15 minutes and 30 in total per hour, then sign-in pauses.

To restrict which apps can even reach the page, set `VID2CONTEXT_OAUTH_ALLOWED_REDIRECTS`:

```sh
VID2CONTEXT_OAUTH_ALLOWED_REDIRECTS=https://claude.ai/api/mcp/auth_callback,https://chatgpt.com/connector,http://localhost,http://127.0.0.1
```

### Keep tokens across restarts

OAuth clients and tokens are stored in the library storage when it supports key-value state (SQLite, Cloudflare D1 or KV), under `auth:oauth:` keys. Without that they live in memory: the server logs a warning, and every restart signs your connectors out. See [library-sqlite.md](library-sqlite.md).

## Add the connector in ChatGPT

Not verified live: this needs your ChatGPT account. Steps follow OpenAI's docs as of 2026-11-14.

1. Settings, Apps (or Apps & Connectors), Advanced settings: turn on **Developer mode** (Plus, Pro, Business, Enterprise or Edu).
2. Choose **Create** (Create app or Add connector).
3. Fill in:
   - **Name**: `vid2context`
   - **Description**: `Transcripts, metadata, chapters and cited briefs from any video`
   - **MCP Server URL**: `https://mcp.vid2context.com/mcp` (with `/mcp`)
   - **Authentication**: `OAuth`
4. Leave the client registration on its default. ChatGPT uses its metadata document `https://chatgpt.com/oauth/client.json`, or dynamic registration if that fails. For a pre-registered client, register one with `POST /oauth/register` and paste its client id and secret under the advanced settings. Its redirect URI is `https://chatgpt.com/connector_platform_oauth_redirect`.
5. Create. The sign-in page opens: enter the owner password and choose Allow.
6. In a chat, pick the connector from the tools menu and ask, for example, "Get the transcript of https://youtu.be/jNQXAC9IVRw".

ChatGPT calls from OpenAI's egress IPs, listed at developers.openai.com/api/docs/guides/ip-addresses.

### Publishing in the ChatGPT app directory

OpenAI's directory (platform.openai.com, "plugins") needs a public HTTPS endpoint and proof that you control the domain:

1. Open platform.openai.com/plugins, choose to upload a new plugin, then MCPs, and enter `https://mcp.vid2context.com/mcp`. The form shows a **challenge token**. Owners can submit; other members need the "Apps Management Write" role.
2. Set it on the server and restart: `VID2CONTEXT_OPENAI_APPS_CHALLENGE=<token>`. It is served as plain text at `https://mcp.vid2context.com/.well-known/openai-apps-challenge`. The challenge must be on the MCP hostname or a parent domain such as `vid2context.com`.
3. Click verify, then finish the submission. Review asks for 5 positive and 3 negative test prompts and a demo recording.

## Add the connector in Claude.ai

Not verified live: this needs your Claude account. Steps follow Anthropic's docs as of 2026-11-14.

1. Settings (or Customize), **Connectors**, **Add custom connector**. Free plans get one custom connector; Pro, Max, Team and Enterprise get more. On Team and Enterprise an owner adds it for the organization.
2. Fill in:
   - **Name**: `vid2context`
   - **Remote MCP server URL**: `https://mcp.vid2context.com/mcp`. Claude sends this exact URL as `resource`, so it must match `VID2CONTEXT_MCP_PUBLIC_URL` plus `/mcp`.
   - **Authentication**: "Sign in now" or "Sign in when needed" for OAuth. Or choose "No sign-in" and add a request header `Authorization: Bearer <static token>` (request headers are in beta).
   - **OAuth client**: "Use Claude's published identity" (recommended; this is the metadata document `https://claude.ai/oauth/mcp-oauth-client-metadata`), "Register automatically" (dynamic registration), or "Use your own OAuth client" with a client id from `/oauth/register`. The callback is `https://claude.ai/api/mcp/auth_callback`.
   - **Advanced, Transport**: Streamable HTTP (the default for URLs that do not end in `/sse`).
3. Add, then sign in on the page that opens.
4. Auth settings cannot be edited later: to change them, remove the connector and add it again.

Claude connects from `160.79.104.0/21`. If you filter by IP, allow that range for `/mcp`, `/oauth/*` and `/.well-known/*`.

## Discovery

- `GET /mcp/server-card` is the MCP Server Card (SEP-2127, `application/mcp-server-card+json`). It is built from `serverJson()` in `@vid2context/discovery`, so its name, version and description match the MCP Registry.
- `GET /.well-known/ai-catalog.json` is an AI Catalog entry that points to the card.
- `server.json` (the MCP Registry entry, from `serverJson()` in `packages/discovery/src/manifests.ts`) lists `https://vid2context.com/mcp` under `remotes` as `streamable-http`. It was added on 2026-11-15, once the endpoint answered from outside (server card 200, `/mcp` 401 with `WWW-Authenticate`).

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| 401 `This MCP server has no credentials configured` | Set `VID2CONTEXT_MCP_TOKENS` or `VID2CONTEXT_OWNER_PASSWORD_HASH` and restart |
| 401 `invalid_token` after it worked | The access token expired and the refresh failed, or the server restarted with memory storage. Reconnect the connector, and configure persistent storage |
| Connector says the server does not support OAuth or PKCE | Check that `curl https://<host>/.well-known/oauth-authorization-server` returns JSON from the outside. Cloudflare Access in front of these paths breaks this (see [cloudflare-tunnel.md](cloudflare-tunnel.md#cloudflare-access)) |
| `invalid_target` or the token is refused right after sign-in | `VID2CONTEXT_MCP_PUBLIC_URL` does not match the URL entered in the connector (scheme, host and `/mcp` must match) |
| "Unknown client" page | The client's metadata document could not be fetched or failed validation, or its registration expired (180 days unused). Retry; check the server log |
| "Invalid redirect" page | The redirect URI is not registered for that client, or is not in `VID2CONTEXT_OAUTH_ALLOWED_REDIRECTS` |
| 403 `Host ... is not allowed` | Behind a tunnel, set `VID2CONTEXT_MCP_PUBLIC_URL`, or add the host to `VID2CONTEXT_MCP_ALLOWED_HOSTS` |
| 403 `Origin ... is not allowed` | A browser client (for example the Inspector UI at `http://localhost:6274`) must be listed in `VID2CONTEXT_CORS_ORIGINS` |
| 429 | Per-token limit (`VID2CONTEXT_MCP_RATE_LIMIT`, default 120 per minute). Wait `Retry-After` seconds |
| "Too many attempts" on the sign-in page | Five wrong passwords from one address. Wait 15 minutes |
| `blocked` errors from YouTube | The server runs on a datacenter IP. Run it at home behind a tunnel |

`export_obsidian` is listed but refused over HTTP, because it would write to the server's disk, not yours. Use it over stdio.

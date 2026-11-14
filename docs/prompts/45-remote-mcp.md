# 45. Remote MCP over HTTPS with OAuth, for ChatGPT and Claude

| | |
|---|---|
| Track | H. Surfaces |
| You own | `packages/mcp-http/` (new), `docs/guides/remote-mcp.md`, `docs/guides/cloudflare-tunnel.md` |
| Shared edits allowed | `docs/contracts/mcp-tools.md` (the transport section only); `packages/core/src/storage-ext.ts` (create from SHARED-CONTRACTS 1.1 if missing) and its `export *` line; `docs/providers.md` and `.env.example` (your env vars only) |
| Commit scope | `mcp-http` |
| Runs alongside | 49 other prompts in the same folder; depends only on the foundation |

vid2context turns any video into context for AI agents: transcripts, metadata, chapters and cited briefs, free-first, as a CLI, MCP server, HTTP API and web app. Claude Code reaches the MCP server over stdio, but ChatGPT connectors and Claude.ai custom connectors need a remote MCP server over HTTPS with OAuth. The owner also wants YouTube requests to keep coming from their home IP (YouTube blocks datacenter IPs), so the recommended setup is the server running at home behind a Cloudflare Tunnel on a vid2context.com hostname. This prompt builds that transport as its own package, serving exactly the tools of `createServer()` from `@vid2context/mcp`, with a small single-owner OAuth 2.1 authorization server, and writes the guides.

## Read first

1. `CLAUDE.md` and `AGENTS.md` (operating rules and commands), then `docs/ARCHITECTURE.md`.
2. `packages/core/src/types.ts`, `packages/core/src/provider.ts` and `packages/core/src/testing.ts`.
3. `docs/contracts/mcp-tools.md` (one tool set, two transports; prompt 45 defines no tools) and `docs/contracts/http-api.md` (the `/mcp` row, the auth and limits section, the `RouteDeps` sub-app pattern).
4. `packages/mcp/src/server.ts` (`createServer(registry, ctx, version)`) and `packages/server/src/app.ts`, `node.ts`, `workers.ts` (how the server builds a `Ctx` per request).
5. `docs/prompts/SHARED-CONTRACTS.md`, sections 1.1 (KvStore), 6 (URL layout: `/mcp`, `/.well-known/oauth-*`) and 8.

## Goal

`@vid2context/mcp-http` exports a fetch handler and a Hono sub-app that serve the MCP tools over Streamable HTTP at `/mcp` on Node and Workers, protected by static bearer tokens or OAuth 2.1 (dynamic client registration, PKCE, refresh tokens) good enough for ChatGPT and Claude.ai connectors, plus a `vid2context-mcp-http` bin and two guides. It never edits `packages/mcp` or `packages/server`.

## Requirements

### Transport

- The official SDK's Streamable HTTP server transport, wrapping `createServer(registry, ctx)` from `@vid2context/mcp` with a fresh `Ctx` per request (the request's abort signal).
- Stateless mode (a new server and transport per request, JSON responses or SSE as the client asks) for Workers and serverless; session mode with `Mcp-Session-Id` on Node, with idle expiry.
- Exports: `createMcpHttpHandler(deps): (req: Request) => Promise<Response>` and `mcpHttpRoutes(deps): Hono` that mounts `/mcp` and the `/.well-known/oauth-*` and `/oauth/*` routes at the root (not under `/api/v1`, per SHARED-CONTRACTS section 6). Document exactly how prompt 46 mounts it.
- Bin `vid2context-mcp-http` (`src/bin.ts`): `--port`, `--host` (default 127.0.0.1), loads `.env` via `loadEnvFiles()`.

### Auth

- Static tokens: `VID2CONTEXT_MCP_TOKENS` (comma-separated), compared by SHA-256 hash in constant time. Simplest path for personal use and the tunnel.
- OAuth 2.1 authorization server for connectors. Before building, read the current requirements from OpenAI's and Anthropic's connector documentation (WebFetch) and the MCP authorization spec, and record the date you checked in the guide. Implement what they require, typically:
  - Protected resource metadata (RFC 9728) at `/.well-known/oauth-protected-resource`, and `WWW-Authenticate` with `resource_metadata` on 401.
  - Authorization server metadata (RFC 8414) at `/.well-known/oauth-authorization-server`.
  - Dynamic client registration (RFC 7591) at `/oauth/register`, with redirect URI validation (https, or localhost for development).
  - Authorization code flow with PKCE (S256 only) at `/oauth/authorize` and `/oauth/token`; short-lived access tokens (opaque, hashed at rest) and rotating refresh tokens; token audience bound to the resource URL.
  - A single-owner login and consent page (plain HTML, CSP-clean, no third-party assets): password checked against `VID2CONTEXT_OWNER_PASSWORD_HASH` (scrypt via Web Crypto compatible code or `node:crypto` on Node only, documented), CSRF token, rate-limited attempts.
  - Clients, codes and tokens stored in a KvStore (`auth:oauth:` keys) with TTLs: `hasKv(storage) ? storage : new MemoryKv()`, with a clear warning that MemoryKv loses tokens on restart.
- Origin header validation and DNS-rebinding protection when bound to localhost; CORS only for configured origins; per-token rate limits (token bucket in the KvStore) answering `429` with `Retry-After`.

### Guides

- `docs/guides/remote-mcp.md`: when to use stdio versus remote, running `vid2context-mcp-http`, static token setup, OAuth setup, adding the connector in ChatGPT (developer mode connectors) and in Claude.ai (custom connectors), with the exact fields, and troubleshooting.
- `docs/guides/cloudflare-tunnel.md`: run the server at home so YouTube sees a residential IP; `cloudflared tunnel login`, `tunnel create`, a config file routing `mcp.vid2context.com` (or a path on vid2context.com) to the local port, `cloudflared service install`; optional Cloudflare Access policy and how it interacts with OAuth; verifying from outside.

## Out of scope

- Tool definitions: prompt 44 (MCP tools). If a tool is missing, report it.
- Mounting into the HTTP API: prompt 46 (HTTP API). Export the factory and say how.
- HTTP API keys for REST routes: prompt 46. Share no code with it beyond core.

## Tests

- Start the handler with `@hono/node-server` on a random port and connect a real SDK `Client` with the Streamable HTTP client transport: `tools/list`, then `tools/call get_metadata` against a `testContext` that replays `providers/youtube/test/fixtures/`.
- Static token: missing token gives 401 with `WWW-Authenticate`; wrong token 401; right token works.
- Full OAuth flow over real HTTP: register a client, request `/oauth/authorize` with a PKCE challenge, submit the login form with a test password whose hash you generate in the test, follow the redirect, exchange the code, call a tool with the access token, refresh, and confirm the old refresh token is rejected. Also assert PKCE `plain` is refused and a wrong `code_verifier` fails.
- Origin validation and rate limiting.
- `LIVE=1`: the same flow against real YouTube.

## Acceptance criteria

- [ ] `npx tsc -p tsconfig.json --noEmit 2>&1 | grep packages/mcp-http` prints nothing.
- [ ] `npx vitest run packages/mcp-http` passes.
- [ ] `npx biome check packages/mcp-http` is clean.
- [ ] `npx @modelcontextprotocol/inspector --cli http://127.0.0.1:<port>/mcp --method tools/list` with a bearer token lists the tools (record it in your report).
- [ ] Both guides exist, with the date the connector requirements were checked.

## Docs

- The two guides above, `packages/mcp-http/README.md`, the transport section of `docs/contracts/mcp-tools.md`, and new env vars in `.env.example` and `docs/providers.md`.

## If credentials, tools or network are missing

No provider key is needed. You cannot add a real ChatGPT or Claude.ai connector from this machine without the owner's accounts: verify everything with the SDK client and Inspector, and list the connector steps as not verified live. If `cloudflared` is not installed, write the guide from Cloudflare's current docs and say it was not run.

<!-- COMMON -->

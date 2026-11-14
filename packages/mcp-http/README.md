# @vid2context/mcp-http

The vid2context MCP server over Streamable HTTP, so ChatGPT and Claude.ai connectors can use it. It serves exactly the tools of `createServer()` from `@vid2context/mcp` (the same set as stdio) and defines none of its own. It accepts static bearer tokens or tokens from a small single-owner OAuth 2.1 server. Setup guide: [docs/guides/remote-mcp.md](../../docs/guides/remote-mcp.md).

## Run it

```sh
npx tsx packages/mcp-http/src/bin.ts --port 8790          # or: vid2context-mcp-http
printf '%s' 'a long pass phrase' | npx tsx packages/mcp-http/src/bin.ts hash-password
```

`--host` defaults to `127.0.0.1`. On a loopback address the Host header is checked, which stops DNS rebinding. `.env` is loaded through `loadEnvFiles()`.

## Routes

These are served at the root, not under `/api/v1`:

| Path | What |
|---|---|
| `POST/GET/DELETE /mcp` | MCP Streamable HTTP. Needs `Authorization: Bearer <token>`. |
| `GET /mcp/server-card` | MCP Server Card (SEP-2127), built from `serverJson()` in `@vid2context/discovery` |
| `GET /.well-known/oauth-protected-resource[/mcp]` | RFC 9728 protected resource metadata |
| `GET /.well-known/oauth-authorization-server` | RFC 8414 authorization server metadata |
| `GET /.well-known/ai-catalog.json` | AI Catalog entry for the server card |
| `GET /.well-known/openai-apps-challenge` | OpenAI domain verification token, when `VID2CONTEXT_OPENAI_APPS_CHALLENGE` is set |
| `POST /oauth/register` | RFC 7591 dynamic client registration |
| `GET/POST /oauth/authorize` | Code flow with PKCE (S256 only), plus the owner sign-in and consent page |
| `POST /oauth/token` | `authorization_code` and `refresh_token`. Refresh tokens rotate and reuse is detected. |
| `POST /oauth/revoke` | RFC 7009 revocation |

Clients may also skip registration by using a Client ID Metadata Document, where the `client_id` is an https URL. ChatGPT and Claude prefer this. The document is fetched through the core SSRF guard.

## Mount it in the HTTP API (item 46)

```ts
import { mcpHttpRoutes, MCP_HTTP_PATHS } from '@vid2context/mcp-http';

// in createApp(), after the /api/v1 routes:
app.route('/', mcpHttpRoutes({ registry, makeCtx, storage, version }));
```

- These paths carry their own auth. Keep `VID2CONTEXT_API_KEYS` middleware off them: skip every path in `MCP_HTTP_PATHS`.
- The sub-app answers its own 401, 403 and 429 responses instead of throwing, so the main `onError` never turns a 401 into a 502.
- Middleware here is scoped to the paths in `MCP_HTTP_PATHS`, so it never touches the parent's routes.
- On Workers, `packages/server/src/workers.ts` sends only `/api/*` to the app today. It must also route `/mcp`, `/mcp/*`, `/.well-known/oauth-*`, `/.well-known/ai-catalog.json`, `/.well-known/openai-apps-challenge` and `/oauth/*`. On Workers the default mode is stateless.
- Pass `storage` (the RouteDeps function). When it returns a backend that implements `KvStore`, OAuth clients and tokens survive restarts. Otherwise they live in `MemoryKv`, a warning is logged, and every restart signs connectors out.

`createMcpHttpHandler(deps)` returns a plain `(req: Request) => Promise<Response>` for runtimes without Hono.

## Exports

`mcpHttpRoutes`, `createMcpHttpHandler`, `MCP_HTTP_PATHS`, `McpHttpDeps`, `readConfig`, `authenticate`, `serverCard`, `aiCatalog`, `authorizationServerMetadata`, `protectedResourceMetadata`, `hashPassword`, `verifyPassword`, `scrypt`.

## Design notes

- **Modes.** In `session` mode (the default on Node), each `Mcp-Session-Id` keeps one `McpServer`, which closes after `VID2CONTEXT_MCP_SESSION_IDLE_SEC`. A session is bound to the credential that opened it. In `stateless` mode (the default elsewhere), every request gets a new server and transport, and GET and DELETE answer 405. Responses are JSON or SSE, following the order of the Accept header.
- **Per-request Ctx.** Every request builds its own `Ctx` with `makeCtx(req)`. In stateless mode an aborted request closes its server, which aborts any running tool call. The library storage is opened once and shared, so stateless requests do not each open their own.
- **Passwords.** The scrypt code is plain TypeScript on top of Web Crypto PBKDF2, so it runs on Workers too. Its output is byte-identical to `node:crypto`, which the tests check. The format is `scrypt:<log2 N>:<r>:<p>:<salt>:<hash>` (base64url). The default N=2^14 takes about 140 ms on Node. That is too slow for the Workers free plan (10 ms CPU), so use the paid plan or run on Node.
- **Tokens.** Access and refresh tokens are opaque, 256-bit, and stored as SHA-256 hashes under `auth:oauth:` keys with TTLs. Each one is bound to the `/mcp` resource URL. Static tokens are compared by SHA-256 in constant time.
- **Protocol version.** Built on `@modelcontextprotocol/sdk` 1.32.2, the latest release on 2026-11-14, which speaks MCP 2025-11-25 and older. The 2026-07-28 spec drops sessions and GET streams. This package will follow once the SDK supports it.

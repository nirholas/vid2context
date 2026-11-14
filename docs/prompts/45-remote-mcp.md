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

### Discovery for the remote server (added by item 51)

- MCP Server Card at `<streamable-http-url>/server-card` and an entry for it in `/.well-known/ai-catalog.json` (`{"specVersion":"1.0","entries":[{"identifier":"urn:air:vid2context.com:mcp:vid2context","type":"application/mcp-server-card+json","url":"https://vid2context.com/mcp/server-card"}]}`). Server Cards are experimental as of 2026-11 (SEP-2127, `modelcontextprotocol/ext-server-card`): re-check the status and shape before building, and build from `serverJson()` in `@vid2context/discovery` so names, version and description stay identical.
- Once the endpoint is public, add a `remotes` entry (`{"type": "streamable-http", "url": "https://vid2context.com/mcp"}`) to `serverJson()` in `packages/discovery/src/manifests.ts` and rerun `npm run discovery:gen`. That edit is the one shared touch allowed in `packages/discovery`.
- ChatGPT's app directory (platform.openai.com, "plugins") needs this public HTTPS endpoint plus domain verification at `/.well-known/openai-apps-challenge`; document the steps for the owner in the guide.

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

## Repo rules (binding, same as AGENTS.md)

- Never use the em-dash or en-dash characters: not in code, comments, docs, UI copy or commit messages. Use commas, colons, periods or parentheses. No emojis.
- No mocks, fake data, placeholders, TODOs, stub functions or "coming soon" text. If a piece cannot be built for real now, leave it out and say so in your final report.
- Tests use real data only: fixtures recorded from the real service, replayed through `replayFetch` and `testContext` from `@vid2context/core/testing`, or live calls gated by `LIVE=1` (`describe.skipIf(!process.env.LIVE)`). A unit test must never reach the network. Every fixture gets a line in its folder's `README.md` saying where and when it was recorded.
- Core code and providers never read `process.env` or the global `fetch`: use the `ctx` passed to every call. Log through `ctx.log` (stderr). stdout is program output and the MCP stdio channel.
- Prefer plain `fetch` over vendor SDKs. `packages/core` and every provider that declares the `workers` or `browser` runtime must not import Node built-ins.
- Every error a user can see is a `Vid2ContextError` with a stable `code` and a `hint` that says how to recover.
- Free first: local, then free tiers with the user's own key, then keyless hosts, and paid services last, only when their key is set. Every model id is overridable by env. New env vars go into `.env.example` and `docs/providers.md` in the same commit.
- Keep raw transcripts. Cleaned text, summaries, translations and briefs are added layers, never replacements.
- TypeScript, ESM, explicit `.ts` import extensions, Biome formatting (`npx biome check --write <your paths>`).

## Working in a shared folder

You are one of 50 agents working at the same time in this folder, each owning different directories.

- Create and edit files only inside the directories this prompt says you own, plus the shared edits listed in its header. Keep shared edits small and additive, and re-read a shared file immediately before every edit: another agent may have changed it a minute ago. `docs/prompts/SHARED-CONTRACTS.md` section 8 lists who may edit which shared file.
- If the foundation code differs from what this prompt describes, the code wins: read it and adapt. If something you need from another prompt has not landed yet, build everything else first and check again before you finish. If it is still missing, leave that piece out and list it in your report. Never stub it.
- Dependencies go only into your own package's `package.json`. Install through the shared lock so parallel installs cannot corrupt `node_modules`: `mkdir -p .vid2context/locks && flock .vid2context/locks/npm npm install -w <your package dir> <name>@<version>`. Never hand-edit `package-lock.json`; if it conflicts, rerun the install through the lock. Never edit `packages/registry/src/generated/`; run `npm run gen` instead.
- Other agents' unfinished work can break the repo-wide `npm run typecheck` and `npm test`. Judge your own paths: `npx tsc -p tsconfig.json --noEmit 2>&1 | grep -E '<your dirs>'` prints nothing, `npx vitest run <your dirs>` passes, `npx biome check <your dirs>` is clean. Do not fix other agents' files; mention breakage you saw in your report.
- Never run commands that touch other agents' work: `git add -A`, `git add .`, `git commit -a`, `git stash`, `git reset`, `git checkout -- <path>`, `git restore`, `git clean`, `git rebase`, `git push`.
- Servers you start for testing: pick a random port between 20000 and 29999, and stop them when you are done.

## Committing

The owner asks you to commit your own work as described here. Commit each coherent piece as soon as it works, not only at the end.

1. `git status --short` and check that every path you will commit is yours.
2. `flock .vid2context/locks/git git add <explicit paths>` (needed for new files).
3. Commit only your paths, which leaves anything other agents staged untouched:
   `flock .vid2context/locks/git git commit -m "<type>(<scope>): <what changed and why it matters>" -m "<body: what and why, in plain language>" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" -- <explicit paths>`
   (use the Co-Authored-By trailer your harness specifies if it names a different model).
4. `git show --stat HEAD` and confirm only your files are in the commit.

Types: feat, fix, refactor, perf, test, docs, chore. Never use subjects like "update" or "wip". Do not push. Never amend or rewrite a commit you did not make.

## Final report

Finish with a short report to the owner: what you built (paths), what you verified live and how, what you could not verify and why (missing key, tool or network), every shared-file edit you made, what the integration pass needs to wire up, and any breakage you noticed outside your directories.

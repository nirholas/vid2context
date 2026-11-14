# @vid2context/accounts

Hosted mode for a public vid2context instance (for example vid2context.com): GitHub sign-in, sessions, personal API keys, daily quotas per account, a shared transcript cache for public videos, per-IP limits and Cloudflare Turnstile for anonymous use.

Everything here is off unless `VID2CONTEXT_HOSTED=1`. A personal server needs none of it.

## What hosted mode does

- **Sign-in.** Visitors sign in with GitHub (OAuth web flow with `state` and PKCE S256). The scope is empty, so the app can read only public profile data, and keeps three fields of it: the numeric GitHub id, the login and the avatar URL. The GitHub token is used once to read `/user` and is never stored.
- **Sessions.** An opaque random id in a `__Host-v2c_session` cookie (`HttpOnly; Secure; SameSite=Lax; Path=/`), signed with HMAC-SHA256 using `VID2CONTEXT_SESSION_SECRET`. The session record lives in the KV store under the SHA-256 of the id and expires with the session. Logout deletes it.
- **API keys.** `v2c_` plus 32 random bytes (base64url). Shown once on creation, stored as a SHA-256 hash with a name, a short prefix, and the created and last-used times. Keys can be listed with a key, but created or deleted only from a signed-in browser session.
- **Plans and quotas.** Each account has a plan with daily limits: API requests, speech-to-text audio minutes, LLM calls, and the largest collection. Counters are per UTC day. Going over answers `429` with `code: rate-limited`, `Retry-After` until 00:00 UTC, and a hint that names the limit.
- **Shared cache.** A public YouTube video transcribed for one user is served from the shared cache to everyone else for 30 days. Local files, uploads, other private inputs and anything fetched with a user's own cookies or keys are never shared.
- **Anonymous use** (optional, `VID2CONTEXT_ANONYMOUS=1`). Callers without a session or key get the `anonymous` plan, counted per IP (a keyed hash of it, never the address itself). Routes that can start speech-to-text need a Turnstile token, checked with Cloudflare's siteverify endpoint.
- **Per-IP token bucket** in front of every guarded route, signed in or not.

## Setup

1. **Session secret.** At least 32 random characters: `openssl rand -base64 48`. Set it as `VID2CONTEXT_SESSION_SECRET`. Changing it signs everyone out.
2. **GitHub OAuth app.** On GitHub: Settings, Developer settings, OAuth Apps, New OAuth App.
   - Homepage URL: your site, for example `https://vid2context.com`.
   - Authorization callback URL: `https://vid2context.com/api/v1/auth/github/callback` (for local testing, `http://127.0.0.1:8787/api/v1/auth/github/callback`).
   - Copy the client id to `GITHUB_OAUTH_CLIENT_ID`, generate a client secret and put it in `GITHUB_OAUTH_CLIENT_SECRET`.
   - Behind a proxy that changes the host or scheme, set `GITHUB_OAUTH_REDIRECT_URI` to the exact callback URL you registered.
3. **Turnstile** (only with `VID2CONTEXT_ANONYMOUS=1`). In the Cloudflare dashboard: Turnstile, Add widget, your hostname. Put the widget on the page with the site key; send the token it produces in the `X-Turnstile-Token` header (or `CF-Turnstile-Response`). Put the secret key in `TURNSTILE_SECRET`. Without a secret, anonymous requests that could transcribe are refused (captions-only requests with `mode=captions` still work). Cloudflare's test keys (secret `1x0000000000000000000000000000000AA` always passes, `2x...AA` always fails) work for development.
4. **Storage with KV.** Accounts, sessions, keys, usage and the shared cache live in the configured storage backend's KV (SQLite on Node, Cloudflare KV on Workers, Postgres). Without one, a process-memory store is used and a warning is logged: everything is lost on restart, which is fine only for trying it out.
5. **Client IPs.** On Cloudflare Workers the `CF-Connecting-IP` header is used. On Node, pass `clientIp` in the deps (see below) or, behind a trusted proxy, set `VID2CONTEXT_IP_HEADER=x-forwarded-for` (the last address in it, the one your proxy added, is used). Without either, all callers share one bucket and a warning is logged.
6. Also set `VID2CONTEXT_PUBLIC=1` (item 10) so local file paths and private URLs are refused on a public server.

All settings are listed in `docs/providers.md` under "Hosted mode" and in `.env.example`.

## Plans

`VID2CONTEXT_PLANS` is JSON mapping plan names to limits. Any field left out comes from the default plan of the same name, or from `free`. Defaults:

```json
{
  "free": { "requestsPerDay": 500, "sttMinutesPerDay": 60, "llmCallsPerDay": 100, "maxCollectionSize": 200 },
  "anonymous": { "requestsPerDay": 50, "sttMinutesPerDay": 10, "llmCallsPerDay": 10, "maxCollectionSize": 25 }
}
```

- `requestsPerDay`: API requests per UTC day. Account routes under `/me` are not counted.
- `sttMinutesPerDay`: minutes of audio sent to speech-to-text (and video-model) rungs. Counted from the audio duration the pipeline reports, or the transcript's last segment end. Results served from storage or the shared cache cost nothing.
- `llmCallsPerDay`: successful LLM calls.
- `maxCollectionSize`: most videos in one collection.

New accounts get `VID2CONTEXT_DEFAULT_PLAN` (default `free`). There are no paid plans and no payments; an operator can define more plans and move an account with `setAccountPlan(kv, accountId, plan)`.

## Wiring it into the server

Item 46 or the integration pass mounts it. The middleware must run before every route; it ignores paths outside `/api/v1` and leaves `/health`, `/auth/*` and `/bots/*` alone.

```ts
import { accountsRoutes, hostedMiddleware } from '@vid2context/accounts';
import { getConnInfo } from '@hono/node-server/conninfo'; // Node only

const deps = {
  makeCtx,                                   // the same Ctx factory the other routes use
  storage: (ctx) => openStorage(ctx),        // its KV holds accounts, sessions, keys, usage, shared cache
  clientIp: (c) => getConnInfo(c).remote.address, // Node; omit on Workers
};
app.use('*', hostedMiddleware(deps));
app.route('/api/v1', accountsRoutes(deps));
```

Routes that run the pipeline should use the per-request views the middleware puts on the context, so usage is counted and public videos come from the shared cache:

```ts
const hosted = c.get('hosted');                 // undefined when hosted mode is off
const reg = hosted ? hosted.registry(registry) : registry;
const store = hosted ? hosted.storage(storage, { mode, language, refresh }) : storage;
const context = await getVideoContext(reg, url, { mode, language, refresh, storage: store }, ctx);
```

Pass `userCredentials: true` to `hosted.storage` when a request used the caller's own provider keys or cookies. `c.get('account')` (or `accountOf(c)`) is the signed-in `Account`, or null for anonymous callers. Ingest jobs can call `assertCollectionSize(hosted, total)` once they know how many videos a playlist expands to; the middleware itself checks `POST /collections/:id/items` against the current size plus the number of inputs.

When a metered rung refuses because a limit ran out mid-request, the middleware replaces the route's error response with the `429` that names the limit.

## Routes

All under `/api/v1`. Errors use the standard body of `docs/contracts/http-api.md`; `401` (with `WWW-Authenticate: Bearer`) and `403` use `code: auth`.

| Method and path | What |
|---|---|
| `GET /auth/github/login?return_to=/app/` | Redirects to GitHub. `return_to` must be a path on this site. |
| `GET /auth/github/callback` | Finishes sign-in, sets the session cookie, redirects to `return_to` (with `?login=cancelled` if the user cancelled). |
| `POST /auth/logout` | Deletes the session. `204`. |
| `GET /me` | `{ id, login, plan, avatarUrl? }` |
| `GET /me/usage` | `{ period, resetsAt, plan, used: { requests, sttMinutes, llmCalls }, limits }` |
| `GET /me/keys` | `{ keys: { id, name, prefix, createdAt, lastUsedAt? }[] }` |
| `POST /me/keys` | `{ name }` gives `201 { id, name, prefix, createdAt, key }`. The key is shown only here. Session only. |
| `DELETE /me/keys/:id` | `204`. Session only. |

## Limits of the per-IP limiter on Workers

On Node the token bucket is exact within one process. On Cloudflare Workers each isolate keeps its own bucket, and a second limiter counts requests per IP in 60-second windows in Cloudflare KV. KV is eventually consistent (writes can take up to about 60 seconds to reach other locations) and has no atomic increment, so concurrent requests can read the same count: treat it as a soft cap against sustained floods, not an exact limit. Each counted request is a KV write, which counts against the KV plan's daily write allowance. Daily usage counters have the same property and may undercount slightly under heavy concurrency.

## Privacy

- No email address is requested (empty OAuth scope), read or stored. A test asserts the scope and the exact shape of the stored account record.
- Stored per account: GitHub numeric id, login, avatar URL, plan and timestamps. Per key: name, prefix, hash, timestamps. Per session: account id and timestamps. Per day: three counters.
- IP addresses are never stored or logged; per-IP state uses an HMAC of the address keyed with the session secret.
- Logs carry the account id (`acc_...`), never the GitHub login, and never together with request content.
- No third-party analytics. The only outside services contacted are GitHub (during sign-in) and Cloudflare Turnstile (for anonymous requests that can transcribe).

## Not included

- Payments and paid plans.
- OAuth for MCP clients: item 45 (`packages/mcp-http`) handles `/mcp` with its own tokens; it is outside `/api/v1`, so this middleware does not guard it.
- SSRF and input policy: item 10 (`VID2CONTEXT_PUBLIC=1`).
- Per-account separation of the library and collections: the storage backends are shared by the whole instance.

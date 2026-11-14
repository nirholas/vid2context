# 58. Hosted mode: accounts, quotas, a shared transcript cache and abuse protection

| | |
|---|---|
| Track | M. Hosting (wave 2) |
| You own | `packages/accounts/` (new package `@vid2context/accounts`) |
| Shared edits allowed | your rows in `docs/providers.md` and `.env.example`; `packages/core/src/storage-ext.ts` only as `docs/prompts/SHARED-CONTRACTS.md` section 1 allows (create if missing, additive only); your entry in `THIRD_PARTY_NOTICES.md` if you copy code |
| Commit scope | `accounts` |
| Runs alongside | wave 1 (01 to 50) and the other wave 2 prompts; depends only on the foundation |

vid2context turns any video into context for AI agents. Wave 1 builds a server for one owner (API keys, rate limits, OAuth for remote MCP). If vid2context.com runs a public instance, it also needs what any public service needs: sign-in, per-account quotas so one user cannot spend the free speech-to-text quota of everyone, a shared cache so the same public video is transcribed once for all users, and protection against abuse. This prompt builds that as middleware and routes that are off unless `VID2CONTEXT_HOSTED=1`.

## Read first

1. `CLAUDE.md` and `AGENTS.md` (note the rule: never publish or store email addresses or personal details), then `docs/ARCHITECTURE.md`.
2. `packages/core/src/types.ts`, `storage.ts`, `pipeline.ts` (where caching happens), `errors.ts`, `testing.ts`; `packages/server/src/app.ts`.
3. `docs/contracts/http-api.md`: conventions, "Auth and limits", and "Wave 2 routes" (`/auth/*`, `/me*`, hosted mode).
4. `docs/prompts/SHARED-CONTRACTS.md` sections 1 (`storage-ext.ts`: `KvStore`, `hasKv`), 3 and 8; `docs/prompts/10-security.md` and `45-remote-mcp.md` to align with their auth and SSRF work instead of duplicating it.
5. GitHub OAuth web flow docs; Cloudflare Turnstile server-side validation docs. Verify current endpoints.

## Goal

With `VID2CONTEXT_HOSTED=1` and GitHub OAuth configured, a visitor signs in with GitHub, gets a session and can create API keys; every API call is counted against their plan; a public YouTube video transcribed for one user is served from the shared cache to the next; anonymous use is limited and protected by Turnstile.

## Requirements

### Identity and sessions

- GitHub OAuth (web flow with `state` and PKCE): store only the GitHub numeric id, login and avatar URL. Never request or store email (`scope` empty).
- Sessions: an opaque random id in a `HttpOnly; Secure; SameSite=Lax` cookie, the session record in a `KvStore` with expiry. `VID2CONTEXT_SESSION_SECRET` signs the cookie (HMAC through WebCrypto). Logout deletes the record.
- API keys: `v2c_` prefix plus 32 random bytes base64url; shown once; stored as SHA-256 hashes with a name, created and last-used times. Keys and sessions both resolve to an account.

### Plans, quotas and limits

- Plans in config (env `VID2CONTEXT_PLANS` as JSON, with a documented default `free` plan): requests per day, speech-to-text audio minutes per day, LLM calls per day, max collection size. Usage counters in KV keyed by account and UTC day; enforcement returns `429` with `code: rate-limited`, `Retry-After` until reset, and a hint naming the limit.
- Speech-to-text minutes are counted from the audio duration the pipeline reports (`AudioInput.durationSec` or the transcript's last segment end); cached results cost nothing.
- Anonymous access (if `VID2CONTEXT_ANONYMOUS=1`): per-IP limits, Turnstile token required on the routes that can trigger speech-to-text (`TURNSTILE_SECRET`), validated server-side.
- Per-IP token bucket in front of everything (works per instance on Node; on Workers use KV with coarse windows and document the limits of eventual consistency).

### Shared cache

- A `Storage` wrapper `sharedCache(storage, opts)` keyed by ref id plus mode plus language for public platforms only (`youtube`, and other platforms the registry marks public). Never share `file` refs, uploads, or anything fetched with user cookies or user keys. Respect a TTL (default 30 days) and a refresh flag.

### Surfaces

- `src/http.ts`: `accountsRoutes(deps)` (auth, `/me`, `/me/usage`, `/me/keys`) and `hostedMiddleware(deps)` that item 46 or the integration pass installs in front of every route except `/health`, `/auth/*` and `/bots/*` when `VID2CONTEXT_HOSTED=1`. Export the account on the Hono context for other routes.
- Privacy: log account ids, never logins with request content; no third-party analytics.

## Prefer free and local

GitHub OAuth and Cloudflare Turnstile are free. KV comes from the configured storage (Cloudflare KV on Workers, SQLite or memory on Node through `storage-ext.ts`).

## Out of scope

- Payments and paid plans (no Stripe). OAuth for MCP clients: item 45 (reuse its token validation if it exports one, and note it). SSRF guards: item 10.

## Tests

- Unit tests on a `MemoryKv`: session lifecycle, cookie signing and tampering, key creation and hashing, quota counting and reset, 429 bodies, anonymous limits, shared cache rules (file refs never shared).
- OAuth: if `GITHUB_OAUTH_CLIENT_ID` and secret are available, run the flow LIVE once and record the token and `/user` responses with secrets removed; otherwise test the authorize URL, state and PKCE handling, and report the callback as unverified. Never hand-write GitHub responses.
- Turnstile: Cloudflare publishes dummy site and secret keys for testing that always pass or always fail; use them against the real siteverify endpoint in a LIVE test, and record those real responses for replay.
- Middleware tests through `app.request` on a minimal Hono app that mounts your routes and middleware.

## Acceptance criteria

- [ ] `npx tsc -p tsconfig.json --noEmit 2>&1 | grep packages/accounts` prints nothing; `npx vitest run packages/accounts` passes; `npx biome check packages/accounts` is clean.
- [ ] No email address or personal detail is requested, stored or logged (a test asserts the OAuth scope and the stored record shape).

## Docs

- `packages/accounts/README.md`: what hosted mode does, setup (GitHub OAuth app, Turnstile, secrets), plans config, privacy statement.
- Env vars in `.env.example` and `docs/providers.md` (a "Hosted mode" table; your rows only).

## If credentials, tools or network are missing

Build and test everything that needs no account; report the OAuth callback as unverified live if no OAuth app is available.

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

You are one of many agents working at the same time in this folder (wave 1 prompts 01 to 50 and wave 2 prompts 51 to 62), each owning different directories.

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

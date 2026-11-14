# 46. The full HTTP API

| | |
|---|---|
| Track | H. Surfaces |
| You own | `packages/server/` (including `src/app.ts`, `src/node.ts`, `src/workers.ts`; you are its only editor during the wave) |
| Shared edits allowed | `docs/contracts/http-api.md` (implemented routes, plus the SHARED-CONTRACTS section 3 additions you build); `packages/core/src/storage-ext.ts`, `llm-stream.ts`, `tokens.ts` (create from SHARED-CONTRACTS section 1 if missing) and their `export *` lines; `docs/providers.md` and `.env.example` (your env vars only) |
| Commit scope | `server` |
| Runs alongside | 49 other prompts in the same folder; depends only on the foundation |

vid2context turns any video into context for AI agents: transcripts, metadata, chapters and cited briefs, free-first, as a CLI, MCP server, HTTP API and web app. The HTTP API is what the web app, the chat page, the browser extension, custom GPT actions and the Cloudflare deployment all talk to. Today it serves `/health`, `/context` and `/transcript`. This prompt builds every route the contract assigns to item 46, the additions the web and chat pages need (`/models`, `/uploads`, `/bundle`), the enterprise basics (API keys, rate limits, request ids, CORS, OpenAPI), and at the end mounts the sub-apps that parallel prompts export.

## Read first

1. `CLAUDE.md` and `AGENTS.md` (operating rules and commands), then `docs/ARCHITECTURE.md`.
2. `packages/core/src/types.ts`, `provider.ts`, `pipeline.ts`, `storage.ts`, `registry.ts`, `segments.ts`, `format/index.ts` and `testing.ts`.
3. `docs/contracts/http-api.md` in full: conventions, error body and status map, implemented and planned routes with owners, the sub-app factory pattern (`RouteDeps`), auth and limits.
4. `packages/server/src/app.ts`, `node.ts`, `workers.ts`, `packages/server/test/server.test.ts`, and the root `wrangler.jsonc` (the Worker serves `site/` and `/api/*`).
5. `docs/prompts/SHARED-CONTRACTS.md`, sections 1, 2 (bundle), 3 (the route additions, `ModelInfo`, chat SSE), 6 (URL layout) and 8.

## Goal

One Hono app, unchanged across Node and Workers, implements every route owned by item 46 in the contract plus `/models`, `/uploads`, `/bundle` and `/openapi.json`, enforces API keys, rate limits and body limits, and mounts every parallel sub-app that exists when you finish (search, library, insights, ask with `/chat`, chapters, jobs, mcp-http), reporting the ones that are missing.

## Requirements

### Routes owned by 46 (exact paths and shapes from the contract)

- Videos: `GET /metadata`, `GET /formats`, `GET /items`, `GET /section` (`from`/`to` in seconds or `m:ss`, or `chapter`), `GET /outline`, `GET /comments`, `GET /pack` and `POST /pack`. Use prompt 03's chunk helpers and prompt 01's `pack` formatter when they exist; otherwise build `section`, `outline` and `pack` from `sliceSegments`, `estimateTokens` and the `text` formatter, and report it.
- Library: `GET /library`, `GET /library/:id` (URL-encoded ids), `DELETE /library/:id`, over `registry.openStorage(ctx)` (falls back to a process-wide `MemoryStorage`).
- `GET /transcript?...&translate=1`: call `translateContext` from `@vid2context/translate` (prompt 35) when it exists; otherwise answer `bad-request` with a hint, and report.
- Additions from SHARED-CONTRACTS section 3:
  - `GET /models?kind=`: `ModelInfo[]` built from the registry's rungs (`listModels` from prompt 25 if exported), `stream` added when `canStream`, `defaultPolicy` from env. Names of required env vars only.
  - `POST /uploads`: multipart field `file`, size cap `VID2CONTEXT_MAX_UPLOAD_MB` (default 100, the Workers request limit on the free plan), sha256 id, held in memory with a TTL (`VID2CONTEXT_UPLOAD_TTL_MIN`, default 60) or in R2 when a storage backend exposes it. Inputs `upload:<sha256>` are resolved by the server itself (not the registry) and transcribed with core `transcribe()` from an `AudioInput` of kind `bytes`; minimal metadata from the filename. Document that large video files should be reduced to audio in the browser first (the web app does this).
  - `GET /bundle` and `POST /bundle`: `application/zip` from `buildBundle` (prompt 15) when exported from `@vid2context/core`; otherwise leave them out and report.
- `GET /openapi.json`: OpenAPI 3.1 for every route the app serves, generated from route definitions kept next to the handlers (hand-written schema objects or a small helper; no heavy framework required), including the mounted sub-apps' routes when they export a description.

### Mounting parallel sub-apps (at the end)

Check for each export and mount it with `app.route('/api/v1', ...)` when present: `searchRoutes` (prompt 40), `libraryRoutes` (41, collections), `insightsRoutes` (32, `/briefs` and `/extract`), `askRoutes` (34, `/ask` and `/chat`), `chaptersRoutes` (35), `jobsRoutes` (42). Mount `mcpHttpRoutes` from `@vid2context/mcp-http` (45) at the root for `/mcp` and `/.well-known/oauth-*`. Read each package's `src/http.ts` for the exact export name and deps. Add each as a dependency in `packages/server/package.json`. List every one that was absent in your report so the integration pass can add it with one line.

### Enterprise basics

- API keys: when `VID2CONTEXT_API_KEYS` is set, every route except `/health` requires `Authorization: Bearer <key>`. Accept plain keys as the contract says, and also hashed entries `name:scope:sha256hex` with scopes `read`, `write`, `admin` (writes and deletes need `write`); constant-time comparison. Open mode only when no keys are set; the Node entry already binds to 127.0.0.1 by default.
- Rate limiting per key, or per IP in open mode: token bucket in a KvStore (`ratelimit:` keys, `hasKv(storage) ? storage : new MemoryKv()`), `429` with `Retry-After` and the standard error body.
- Request ids (`X-Request-Id` in and out), JSON access logs on stderr (method, path, status, ms, request id, key name; never the key), CORS from `VID2CONTEXT_CORS_ORIGINS`, body size limits, a request timeout, `ETag` and `If-None-Match` on `/context` and `/library/:id`.
- Single-flight: identical concurrent `/context` requests share one pipeline run.
- Public mode: when `VID2CONTEXT_PUBLIC=1` (set by public deployments), refuse local file paths and `file://` inputs with `unsupported-input` and a hint (prompt 10 may later enforce this in the pipeline too; keep your check).
- Graceful shutdown on Node (stop accepting, finish in-flight requests, then exit).

## Out of scope

- `/chat` and `/ask` logic: prompt 34 (ask). `/collections` and `/search`: prompts 41 and 40. `/briefs` and `/extract`: prompt 32. `/jobs`: prompt 42. `/mcp`: prompt 45. You mount them.
- The Worker deployment config (`wrangler.jsonc`, bindings, assets assembly): prompt 50. Keep `src/workers.ts` working and tell 50 in your report if its interface changes.
- Container images: prompt 49.

## Tests

- `app.request()` on the real app with `makeCtx` returning a `testContext` whose `replayFetch` serves recorded fixtures (`providers/youtube/test/fixtures/`, `providers/stt-openai-compatible/test/fixtures/`, plus your own in `packages/server/test/fixtures/`).
- Every owned route: status codes, bodies, content types, the error body for each failure class, URL-encoded library ids.
- Uploads: post `tests/fixtures/media/apollo11-small-step.mp3` as multipart, then `GET /context?url=upload:<sha>` transcribed through a recorded OVH Whisper response; oversize upload gives 413.
- Auth: open mode, plain keys, hashed keys with scopes, missing and wrong keys. Rate limit returns 429 with `Retry-After`. CORS preflight. Single-flight (two concurrent requests, one upstream call in `replayFetch.calls`). ETag 304.
- OpenAPI document parses and lists every served route.
- `LIVE=1`: start `src/node.ts` on a random port and request a real YouTube transcript.

## Acceptance criteria

- [ ] `npx tsc -p tsconfig.json --noEmit 2>&1 | grep packages/server` prints nothing.
- [ ] `npx vitest run packages/server` passes.
- [ ] `npx biome check packages/server` is clean.
- [ ] `npm run start:server` then `curl 'http://127.0.0.1:8787/api/v1/transcript?url=https://youtu.be/jNQXAC9IVRw'` works, and `/api/v1/openapi.json` validates.
- [ ] `npm run dev:worker` still serves `/api/v1/health` (if wrangler can run here; otherwise say so).
- [ ] `docs/contracts/http-api.md` marks what is implemented and includes the section 3 additions.

## Docs

- Update `docs/contracts/http-api.md`.
- `docs/guides/http-api.md`: curl examples for every route, auth and keys, rate limits, CORS for the web app and extension, uploads.

## If credentials, tools or network are missing

No key is needed: keyless OVH Whisper and the YouTube provider cover the live checks. Without network, rely on replayed fixtures, skip LIVE tests with a clear message, and report what was not verified.

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

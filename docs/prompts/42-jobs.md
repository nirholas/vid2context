# 42. Jobs, queues and live progress

| | |
|---|---|
| Track | G. Library and search |
| You own | `packages/jobs/` |
| Shared edits allowed | `packages/core/src/pipeline.ts` (additive `onProgress?` option, called at stage boundaries); `packages/core/src/storage-ext.ts` (create from SHARED-CONTRACTS 1.1 if missing) and its `export *` line in `packages/core/src/index.ts`; `docs/contracts/http-api.md` (only the Jobs section, if your implementation clarifies it) |
| Commit scope | `jobs` |
| Runs alongside | 49 other prompts in the same folder; depends only on the foundation |

vid2context turns any video into context for AI agents: transcripts, metadata, chapters and cited briefs, free-first, as a CLI, MCP server, HTTP API and web app. Some work takes minutes, not seconds: ingesting a 40-video playlist into a collection, transcribing a three-hour podcast, building a brief over a series. That work must run in the background, survive a restart, report progress the web app can show live, and be cancellable. This package is the job engine. It runs in-process on Node, and has adapters for Cloudflare Queues and Google Cloud Tasks so the same jobs run on the serverless targets. Other packages (library ingest, briefs, long audio) register job kinds; the HTTP server mounts your routes.

## Read first

1. `CLAUDE.md` and `AGENTS.md` (operating rules and commands), then `docs/ARCHITECTURE.md`.
2. `packages/core/src/types.ts`, `packages/core/src/provider.ts`, `packages/core/src/pipeline.ts` and `packages/core/src/testing.ts` (replayFetch, testContext).
3. `docs/contracts/http-api.md`: the Jobs section (routes, the `Job` shape, the SSE events) and the "Ownership rule for parallel work" with the `RouteDeps` sub-app factory signature. Build exactly those paths and shapes.
4. `packages/server/src/app.ts` (how the main app handles errors, so your sub-app's thrown `Vid2ContextError`s get the standard body).
5. `docs/prompts/SHARED-CONTRACTS.md`, sections 1.1 (`storage-ext.ts`: KvStore, MemoryKv) and 8 (shared files).

## Goal

`@vid2context/jobs` provides a job queue with a stable interface, an in-process runner that persists jobs in a KvStore and resumes them after a restart, built-in `context` and `items` job kinds, a live progress stream, a Hono sub-app factory implementing the `/jobs` routes from the contract, and adapters for Cloudflare Queues and Google Cloud Tasks.

## Requirements

### Job model and queue interface

- `Job` exactly as in `docs/contracts/http-api.md`: `id`, `kind`, `status` (`queued`, `running`, `succeeded`, `failed`, `canceled`), `progress?: { done, total?, message? }`, `result?`, `error?: { code, message, hint? }`, `createdAt`, `updatedAt`. Store the job's `input` and `options` alongside it (not in the public shape unless the contract lists them).
- `JobQueue` interface: `enqueue(kind, input, options?)`, `get(id)`, `list({ status?, kind?, limit?, cursor? })`, `cancel(id)`, `subscribe(id, listener)` returning an unsubscribe function, and `close()`.
- Job kinds are registered by name: `registerKind(kind, handler)` where the handler receives `{ input, options, signal, progress(update), item(event), registry, storage, ctx }` and returns the result. Unknown kinds fail fast with `bad-request` and a hint listing registered kinds.
- Ids are random and URL-safe (`crypto.getRandomValues`), never sequential.

### In-process runner

- Concurrency limit (`VID2CONTEXT_JOB_CONCURRENCY`, default 2) and FIFO order.
- Retries with exponential backoff and jitter for retryable codes only (`rate-limited`, `timeout`, `upstream`, `blocked` with a long delay); input errors (`bad-request`, `unsupported-input`, `not-found`) fail immediately. Max attempts configurable per kind.
- Cancellation: `cancel(id)` aborts the handler's `AbortSignal`; a queued job becomes `canceled` without running.
- Persistence: every state change is written to a KvStore (`hasKv(storage) ? storage : new MemoryKv()`) under `jobs:` keys. On start, jobs left `running` by a crash go back to `queued` and run again; handlers must be idempotent, and the built-in ones are.
- Retention: finished jobs expire after `VID2CONTEXT_JOB_TTL_HOURS` (default 72) through KvStore TTL.

### Progress and the pipeline hook

- Add an optional `onProgress?: (event: { stage: Attempt['stage'] | 'done'; detail?: string }) => void` to `GetContextOptions` in `packages/core/src/pipeline.ts`, called at stage boundaries (resolve, metadata, captions, audio, stt, video, saving). Additive only: re-read the file first (prompts 02, 04, 10, 21 and 22 also make small edits there), never reorder or rewrite existing logic, and make a call site a single line.
- Job events: `progress` `{ done, total?, message? }`, `item` `{ id, outcome }`, `done` `{ result }`, `error` `{ code, message, hint? }`, exactly as the contract names them.

### Built-in kinds

- `context`: one input to a `VideoContext` saved to storage; progress messages from `onProgress`.
- `items`: expand a playlist, channel or feed with `expandInput`, then fetch each video with bounded concurrency, emitting `item` events and per-item outcomes; the job succeeds when at least one item succeeded and records the failures in `result`.
- `bundle`: only if `buildBundle` is exported from `@vid2context/core` (prompt 15) when you finish. Otherwise leave it out and report it.

### HTTP: `packages/jobs/src/http.ts`

- Export `jobsRoutes(deps: RouteDeps & { queue: JobQueue }): Hono` implementing `POST /jobs`, `GET /jobs/:id`, `GET /jobs/:id/events`, `DELETE /jobs/:id` relative to `/api/v1`, with the status codes in the contract.
- SSE helper `toSSE(queue, id)`: replays the current state first, then live events, sends a heartbeat comment every 15 s, honours `Last-Event-ID` (event ids are monotonic per job), and closes after `done` or `error`.
- Do not edit `packages/server`. Prompt 46 mounts your factory when it exists. Throw `Vid2ContextError` so the main app's error handler renders the standard body.

### Serverless adapters

- Cloudflare Queues: a producer (`queue.send({ jobId })`) and a consumer handler body (`handleQueueBatch(batch, env)`) that loads the job from KV or D1 and runs it, acking or retrying per message. Typed against the Workers runtime types without importing Node built-ins.
- Google Cloud Tasks: an enqueuer that creates an HTTP task targeting a run endpoint (`POST /api/v1/jobs/:id/run`, exported as a separate route in your factory, disabled unless configured) with an OIDC token, and verification of that token's issuer, audience and signature (Google JWKS fetched through `ctx.fetch`) on the run endpoint.
- Both adapters are documented with the exact `wrangler.jsonc` and `gcloud tasks queues create` snippets, but you do not edit `wrangler.jsonc`.

## Out of scope

- Collections, watch lists and scheduled refresh: prompt 41 (library). It registers its own `ingest` and `refresh` kinds against your interface.
- Briefs and extraction kinds: prompt 32 (briefs and extraction).
- Long-audio splitting: prompt 04 (long audio). It may later run as a job kind.
- Mounting the routes into the server: prompt 46 (HTTP API).

## Tests

- Real pipeline runs over recorded fixtures: a `context` job on `jNQXAC9IVRw` using a `testContext` with `replayFetch` serving `providers/youtube/test/fixtures/`, asserting the job reaches `succeeded`, progress messages arrive in stage order, and the context is in storage.
- `items` job over a real recorded playlist response (record one with `LIVE=1` from a small public playlist into `packages/jobs/test/fixtures/`), asserting `item` events and the final summary.
- Retry: a recorded real 429 response followed by a success; assert the backoff and the attempt count. Input error: an unsupported input fails once without retry.
- Restart resume: run a queue on a shared `MemoryKv`, stop it mid-job, start a new queue on the same KV, assert the job completes once.
- Cancellation of queued and running jobs.
- SSE: start the sub-app with `@hono/node-server` on a random port, connect with a real `fetch` stream reader, parse events, reconnect with `Last-Event-ID` and assert no duplicates.
- Adapters: run the Queues consumer under Miniflare if it is installed, and Cloud Tasks token verification against a real Google-issued token only in a `LIVE=1` test on GCP; otherwise report.

## Acceptance criteria

- [ ] `npx tsc -p tsconfig.json --noEmit 2>&1 | grep -E 'packages/jobs|packages/core/src/(pipeline|storage-ext)'` prints nothing.
- [ ] `npx vitest run packages/jobs` passes.
- [ ] `npx biome check packages/jobs` is clean.
- [ ] Existing core tests still pass: `npx vitest run packages/core`.
- [ ] A `LIVE=1` test runs an `items` job over a real 3-video public playlist and streams progress over SSE end to end.

## Docs

- `docs/guides/jobs.md`: the job model, how to register a kind, the SSE stream (with a `curl -N` example), persistence and resume, and the two serverless adapters.
- `packages/jobs/README.md`: API summary.

## If credentials, tools or network are missing

The in-process runner needs nothing. Without network, test on recorded fixtures and skip the LIVE playlist test. Without Miniflare or a GCP environment, test the adapters' pure parts (message building, token claim checks against recorded real JWKS) and list what was not verified live.

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

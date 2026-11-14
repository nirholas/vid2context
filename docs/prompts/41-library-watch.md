# 41. Collections and watch lists

| | |
|---|---|
| Track | G. Library and search |
| You own | `packages/library/` |
| Shared edits allowed | `packages/core/src/storage-ext.ts` (create from SHARED-CONTRACTS 1.1 if missing) and its `export *` line in `packages/core/src/index.ts`; the collection rows in `docs/contracts/http-api.md` and the collection tool rows in `docs/contracts/mcp-tools.md`; your variables in `.env.example` and `docs/providers.md` |
| Commit scope | `library` |
| Runs alongside | 49 other prompts in the same folder; depends only on the foundation |

vid2context turns any video into context for AI agents: transcripts, metadata, chapters and cited briefs, free-first, as a CLI, MCP server, HTTP API and web app. The owner researches by topic: a "G-Wagon" collection fed from a YouTube playlist series, where every new episode should be ingested automatically and become searchable and citable. Collections exist in the `Storage` contract (`sources`, `videoIds`) but nothing follows the sources yet. This package turns collections into living research libraries: add a playlist, channel or podcast feed as a source, refresh to ingest new items, schedule refreshes as watch lists, and notify a webhook when something new arrives. It backs the collection routes in the HTTP contract and the collection MCP tools.

## Read first

1. `CLAUDE.md` and `AGENTS.md`, then `docs/ARCHITECTURE.md`.
2. `packages/core/src/storage.ts` (`Collection`, collection methods), `packages/core/src/pipeline.ts` (`expandInput`, `getVideoContext` with `storage`), `packages/core/src/registry.ts` (`resolve`, `openStorage`), `packages/core/src/errors.ts`, `packages/core/src/testing.ts`.
3. `providers/youtube/` (how playlists resolve today; prompt 08 adds `listItems` for playlists, channels and search in parallel) and `providers/youtube/test/fixtures/`.
4. `docs/contracts/http-api.md` (the collection routes, `RouteDeps`, the Job shape: ingest and refresh return `202 Job`) and `docs/contracts/mcp-tools.md` (`list_collections`, `create_collection`, `add_to_collection`, `get_collection`).
5. `docs/prompts/SHARED-CONTRACTS.md`, sections 1.1 (`KvStore`, key namespace `library:`) and 8.

## Goal

`@vid2context/library` adds sources to collections, refreshes them idempotently with bounded concurrency and per-item error capture, runs scheduled watch lists on Node and on Workers cron, sends signed webhooks for new items, imports and exports collection definitions, and exports a Hono sub-app and an MCP registration function for the collection surfaces.

## Requirements

### Collections and sources

- `createLibrary({ registry, storage, ctx, kv? })` where `kv` defaults to `hasKv(storage) ? storage : new MemoryKv()`.
- `addSource(collectionId, input)`: validate that `registry.resolve(input)` returns a list ref (playlist, channel, feed or page); store it in `Collection.sources`. `removeSource`.
- `addVideos(collectionId, inputs)`: inputs can be videos or lists; lists are expanded with `expandInput`.
- `refresh(collectionId, { limit?, concurrency? })`: expand every source, compute new items (not in `videoIds` and not in the seen set), fetch each with `getVideoContext(registry, input, { storage }, ctx)` with bounded concurrency (default 3) and a polite delay, add successes to the collection, and record failures (code, hint) without stopping the run. Idempotent: running twice adds nothing new. Returns a summary `{ added, skipped, failed: { input, code, hint }[], checkedAt }` and emits progress callbacks `{ done, total, message }` matching the contract's Job progress shape.
- Respect a max items per refresh (`VID2CONTEXT_MAX_PLAYLIST_ITEMS`, default 200).

### Watch lists

- Per-collection schedule stored in KV under `library:watch:<collectionId>`: `{ every: 'hourly'|'daily'|'weekly' | { minutes: number }, at?: 'HH:MM' (UTC), enabled }`, plus state `{ seenIds, lastCheckedAt, lastError, nextDueAt }`.
- `runDue(now)`: refresh every collection whose `nextDueAt` has passed, one at a time, updating state; safe to call from any scheduler, and safe if two processes call it (use a KV lease key `library:lease:<collectionId>` with a TTL).
- Helpers: `startScheduler({ intervalMs })` for Node (an unref'd timer loop with graceful stop) and `scheduledHandler(deps)` returning a function suitable for a Workers `scheduled()` export (prompt 50 wires the cron trigger).

### Notifications

- When `VID2CONTEXT_WEBHOOK_URL` is set, POST new items after each refresh as JSON (`{ collection: { id, name }, added: VideoSummary[], checkedAt }`), with header `X-Vid2context-Signature: sha256=<hex HMAC of the body with VID2CONTEXT_WEBHOOK_SECRET>` and a timestamp header; retry with backoff on 5xx; never block the refresh on webhook failure (log it).

### Import and export

- `exportCollection(id)` returns a portable JSON definition (name, description, sources, video inputs, schedule) without transcripts; `importCollection(json)` recreates it and optionally refreshes. Validate input and fail with `bad-request` and a hint.

### HTTP and MCP factories

- `src/http.ts`: `libraryRoutes(deps: RouteDeps): Hono` with the collection routes exactly as `docs/contracts/http-api.md` lists (`GET/POST /collections`, `GET/PATCH/DELETE /collections/:id`, `POST/DELETE /collections/:id/items`, `POST /collections/:id/refresh`). Ingest and refresh return `202 Job` through `@vid2context/jobs` (prompt 42) when that package exists when you finish; otherwise run inline and return the updated collection with the refresh summary, document that difference in the contract rows, and report it. Do not edit `packages/server`: prompt 46 mounts your factory.
- `src/mcp.ts`: `registerLibraryTools(server, deps)` registering `list_collections`, `create_collection`, `add_to_collection`, `get_collection` exactly as `docs/contracts/mcp-tools.md` defines. Prompt 44 calls it; do not edit `packages/mcp`.

## Prefer free and local

Ingest uses the normal free-first pipeline: captions first (no model, no cost), speech-to-text only when needed. Scheduling is local (a timer) or the deployment's own cron; no paid queue is required.

## Out of scope

- Playlist, channel and feed expansion inside providers: prompts 08 (YouTube), 11 (yt-dlp), 13 (podcasts), 14 (web pages).
- The jobs engine: prompt 42.
- Search across a collection: prompt 40. Briefs: prompt 32.

## Tests

- Real recorded responses: the YouTube player and caption fixtures in `providers/youtube/test/fixtures/`, plus a real playlist expansion you record (if the YouTube provider cannot list playlists yet, record a real yt-dlp `--flat-playlist -J` output or use a real podcast feed with a provider that can list it; otherwise test refresh with explicit video inputs and report that list sources were not exercised). Run the real pipeline with `replayFetch` into `MemoryStorage`.
- Assert idempotency (second refresh adds nothing), per-item failure capture (a recorded unavailable-video response), concurrency bound (count in-flight calls), progress events, max items.
- Watch list: `runDue` with injected `now` values, lease behaviour with two concurrent callers, state persistence through `MemoryKv`.
- Webhook: a real local HTTP server in the test receives the POST; verify the HMAC signature and the retry on a 503.
- Routes on a bare Hono app; MCP tools through the SDK in-memory transport.
- Live test (`LIVE=1`): create a collection from a real small public playlist and refresh it.

## Acceptance criteria

- [ ] `npx tsc -p tsconfig.json --noEmit 2>&1 | grep -E 'packages/library'` prints nothing.
- [ ] `npx vitest run packages/library` passes; `npx biome check packages/library` is clean.
- [ ] A live walkthrough: create "G-Wagon", add the real playlist that contains `cCPsdFdlshc` (find it from the video's page) as a source, refresh, and list the ingested videos. Paste the summary in your report.

## Docs

- `docs/guides/collections.md`: the G-Wagon walkthrough, sources, refresh, watch lists, webhooks (with signature verification example), import and export.
- Collection rows in `docs/contracts/http-api.md` and tool rows in `docs/contracts/mcp-tools.md` kept accurate; `VID2CONTEXT_WEBHOOK_URL`, `VID2CONTEXT_WEBHOOK_SECRET`, `VID2CONTEXT_MAX_PLAYLIST_ITEMS` in `.env.example` (check names first).

## If credentials, tools or network are missing

No keys are needed. Without network, use only recorded fixtures, skip live tests with a message, and report that a real playlist refresh was not run.

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

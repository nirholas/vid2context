# 40. Hybrid search engine

| | |
|---|---|
| Track | G. Library and search |
| You own | `packages/search/` |
| Shared edits allowed | `packages/core/src/storage-ext.ts` (create from SHARED-CONTRACTS 1.1 if missing) and its `export *` line in `packages/core/src/index.ts`; the `/search` row in `docs/contracts/http-api.md` and the `search_transcript` row in `docs/contracts/mcp-tools.md` |
| Commit scope | `search` |
| Runs alongside | 49 other prompts in the same folder; depends only on the foundation |

vid2context turns any video into context for AI agents: transcripts, metadata, chapters and cited briefs, free-first, as a CLI, MCP server, HTTP API and web app. A 15-episode series is about 90k tokens, so agents should search rather than read everything: "where do they talk about the timing chain?" must return the right minute of the right episode, even when the speaker said "cam chain". Keyword search alone misses paraphrases; vectors alone miss exact model names like "G550" or "W463A". This package combines both with reciprocal rank fusion and an optional rerank, works over any storage backend (falling back to in-memory indexes), and returns hits with timestamp links. It backs `GET /search` and the MCP `search_transcript` tool.

## Read first

1. `CLAUDE.md` and `AGENTS.md`, then `docs/ARCHITECTURE.md`.
2. `packages/core/src/storage.ts` (`Storage.search`, `SearchQuery`, `SearchHit`), `packages/core/src/provider.ts` (`EmbedRung`, `LlmRung`), `packages/core/src/registry.ts` (`embedRungs(env)`, `llmRungs(env)`), `packages/core/src/pipeline.ts` (`chat`), `packages/core/src/segments.ts` (`timestampUrl`), `packages/core/src/testing.ts`.
3. `docs/contracts/http-api.md` (`GET /search`, `RouteDeps`) and `docs/contracts/mcp-tools.md` (`search_transcript`, singular, and `register<Name>Tools`).
4. `docs/prompts/SHARED-CONTRACTS.md`, sections 1.1 (`VectorStore`, `hasVectors`, `MemoryVectors`) and 8. `tests/fixtures/README.md`.

## Goal

`createSearchEngine({ registry, storage, ctx, embedModel? })` returns an engine with `index(context)`, `remove(videoId)` and `search(query)` that fuses keyword and vector retrieval, merges adjacent hits into time ranges, highlights snippets and returns timestamp URLs, with an evaluation over real transcripts showing hybrid beats either method alone. It exports a Hono sub-app (`GET /search`) and an MCP registration function (`search_transcript`).

## Requirements

### Indexing

- Chunk transcripts into windows of about 30 to 60 seconds on sentence or pause boundaries, with a small overlap; use `chunkTranscript` from prompt 03 if `packages/core/src/chunk` has landed when you finish, else a local chunker.
- Keyword side: use `storage.search` when the backend has real full-text search (SQLite FTS5, Postgres tsvector, D1 FTS5); otherwise (MemoryStorage, browser) build an in-memory BM25 index over chunks with a simple tokenizer (lowercase, Unicode letters and digits, light stemming for English, stopwords).
- Vector side: embed chunks with one pinned embedding model per index (store the model id; never mix models). Store vectors in `storage` when `hasVectors(storage)`, else in `MemoryVectors`. Choose the model from `embedModel` or the first enabled embed rung by the free-first order; if the model changes, re-index and say so in the result. When no embed rung is enabled, run keyword-only and report `vector: 'disabled'` in results metadata.
- Incremental: `index` is idempotent per video (replace that video's chunks and vectors).

### Query

- Parse the query: `"exact phrases"`, `-excluded` terms, and filters (`collectionId`, `videoIds`, `channel`, published date range, transcript `origin`).
- Retrieve top N from each side, fuse with reciprocal rank fusion (k = 60 by default, configurable weights), then optionally rerank the top M with an LLM rung (JSON scores 0 to 10 per candidate through `chat` with `json`, cheapest free rung; off by default, on with `rerank: true`). A local cross-encoder through Transformers.js is allowed only if practical in all runtimes you declare; otherwise leave it out and say why.
- Post-process: merge hits from the same video that are adjacent or overlapping into one time range, de-duplicate, highlight matched terms in the snippet, attach `url` from `timestampUrl(ref, startSec)`.
- Result: `SearchHit & { url?, chapterTitle?, sources: ('keyword'|'vector')[] }` plus metadata (model, timings, which sides ran).

### HTTP and MCP factories

- `src/http.ts`: `searchRoutes(deps: RouteDeps): Hono` with `GET /search?q=&collectionId=&videoIds=&limit=` exactly as the contract describes. Prompt 46 mounts it; do not edit `packages/server`.
- `src/mcp.ts`: `registerSearchTools(server, deps)` registering `search_transcript` (`{ query, collection?, urls?, limit? }`), returning hits with title, `[m:ss]`, text and timestamp URL. Prompt 44 calls it; do not edit `packages/mcp`.

## Prefer free and local

Keyword search costs nothing. For vectors, the free-first embed chain applies: a local model (Ollama or Transformers.js) when configured, free tiers with the user's key, then the keyless OVH `bge-m3` endpoint. Rerank, when enabled, uses the cheapest free or keyless LLM rung.

## Out of scope

- Embedding rung implementations: prompt 29. The engine uses only the embed rungs the registry provides. The foundation may have none yet: for tests, record real responses from the keyless OVH `bge-m3` endpoint (`POST https://oai.endpoints.kepler.ai.cloud.ovh.net/v1/embeddings`) with `LIVE=1` and replay them through a minimal `EmbedRung` defined in your test helpers. Do not ship an embedding client in `src/`.
- Storage backends: prompts 37, 39, 20.
- Q&A on top of search: prompt 34.

## Tests

- Real fixtures: `tests/fixtures/contexts/youtube-cCPsdFdlshc.json` (18 minutes, a G-Wagon buyer's guide) and `youtube-jNQXAC9IVRw.json`, plus any more real contexts you record into `packages/search/test/fixtures/`.
- An evaluation set in `packages/search/test/fixtures/queries.json`: 15 or more queries with expected time ranges that you verify by reading the transcripts (include exact-term queries, paraphrase queries and negations). Report precision@5 and MRR for keyword-only, vector-only and hybrid in a test that prints a table and asserts hybrid is not worse than the better single method.
- Record real embedding responses for every chunk and query once with `LIVE=1` (from the keyless OVH endpoint or whichever embed rung is enabled), save them, and replay them with `replayFetch`.
- BM25 unit tests on the real text, query parsing tests, hit merging tests, RRF tests.
- `GET /search` through `searchRoutes` on a bare Hono app, and `search_transcript` through the MCP SDK in-memory transport.

## Acceptance criteria

- [ ] `npx tsc -p tsconfig.json --noEmit 2>&1 | grep -E 'packages/search'` prints nothing.
- [ ] `npx vitest run packages/search` passes; `npx biome check packages/search` is clean.
- [ ] The evaluation table (keyword, vector, hybrid) is in your report and in `docs/guides/search.md`.
- [ ] Keyword-only mode works with no embed rung enabled and says so in the result metadata.

## Docs

- `docs/guides/search.md`: how indexing and fusion work, the one-model-per-index rule, query syntax, the evaluation results.
- Keep the `/search` row in `docs/contracts/http-api.md` and the `search_transcript` row in `docs/contracts/mcp-tools.md` accurate.

## If credentials, tools or network are missing

Keyword search and BM25 need nothing. If no embed rung is enabled and the network is down, ship keyword-only plus the vector path tested against previously recorded real embeddings if any exist in the repo, skip live tests with a message, and report that hybrid quality was not measured live.

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

# 39. Postgres and pgvector storage

| | |
|---|---|
| Track | G. Library and search |
| You own | `providers/storage-postgres/` |
| Shared edits allowed | `packages/core/src/storage-ext.ts` (create from SHARED-CONTRACTS 1.1 if missing) and its `export *` line in `packages/core/src/index.ts`; your rows in `docs/providers.md` and your variables in `.env.example` |
| Commit scope | `storage-postgres` |
| Runs alongside | 49 other prompts in the same folder; depends only on the foundation |

vid2context turns any video into context for AI agents: transcripts, metadata, chapters and cited briefs, free-first, as a CLI, MCP server, HTTP API and web app. A hosted, multi-user deployment needs a real database: shared libraries, full-text search across thousands of transcripts, vector search for semantic queries, and tenants kept apart. Postgres with pgvector is available almost everywhere the owner deploys (Neon and Supabase free tiers, Cloud SQL on GCP, Railway, Alibaba Cloud ApsaraDB). This provider implements the library on Postgres with the same `Storage` contract as every other backend, plus the KV and vector extensions, so surfaces need no changes.

## Read first

1. `CLAUDE.md` and `AGENTS.md`, then `docs/ARCHITECTURE.md` (Storage section).
2. `packages/core/src/storage.ts` (`Storage` and `MemoryStorage` as reference behaviour), `packages/core/src/provider.ts` (`StorageProvider`), `packages/core/src/registry.ts` (`openStorage`), `packages/core/src/testing.ts`.
3. `docs/contracts/providers.md` (Storage providers) and `docs/providers.md`.
4. `docs/prompts/SHARED-CONTRACTS.md`, sections 1.1 (`KvStore`, `VectorStore`, key namespaces), 7, 8 and 9.

## Goal

`@vid2context/provider-storage-postgres` implements `Storage`, `KvStore` and `VectorStore` on Postgres with tsvector search and pgvector HNSW indexes, versioned migrations applied safely under an advisory lock, tenant scoping on every row, running on Node and, for Neon, on Workers.

## Requirements

### Drivers and runtimes

- Node: the `postgres` package (porsager). Workers: Neon's serverless HTTP driver (`@neondatabase/serverless`) when `DATABASE_URL` points at Neon. Keep SQL identical across both behind a small query interface. Declare runtimes `["node", "workers"]` only if the Workers path really works (verify with a Neon database or report and declare `["node"]`).
- Config: `DATABASE_URL` (or `VID2CONTEXT_DATABASE_URL`, which wins), `VID2CONTEXT_PG_SCHEMA` (default `vid2context`), pool size, statement timeout, SSL mode from the URL.
- Enabled when a database URL is set; `priority` lower (wins) than SQLite so a configured Postgres takes over; `VID2CONTEXT_STORAGE=postgres` forces it, another value disables it.

### Schema and tenancy

- Every table has `tenant_id text not null`; the storage instance is bound to one tenant at `create(ctx)` from `VID2CONTEXT_TENANT` (default `default`), and every query filters by it. Primary keys include the tenant.
- Tables: `videos` (ref JSON, title, channel, duration_sec, origin, language, saved_at, context JSONB with the raw transcript), `segments` (video_id, idx, start_sec, end_sec, text, speaker, `tsv tsvector` generated column with the `simple` configuration or a per-language configuration chosen from the transcript language, GIN index), `collections`, `collection_items` (ordered), `kv` (JSONB value, expires_at, index on prefix lookups), `vectors` (model, dimensions, video_id, start_sec, end_sec, text, `embedding vector`).
- pgvector: an HNSW index per embedding model (vectors of different models and dimensions are never compared). Create indexes on first use of a model, for example a partial expression index `((embedding::vector(<dims>))) WHERE model = '<model>'` using `vector_cosine_ops`, or a table per model; choose, explain in the docs, and make queries hit the index (check with `EXPLAIN`).
- Migrations as versioned SQL files in `migrations/`, applied in order inside transactions under `pg_advisory_lock` so two instances starting at once never race, with a `schema_migrations` table. Never destructive.

### Behaviour

- `putContext` upserts the video and replaces its segments in one transaction. `deleteContext` cascades and removes collection membership.
- Collections match `MemoryStorage` semantics; unknown ids throw `Vid2ContextError('not-found')` with a hint.
- `search`: `websearch_to_tsquery` (safe for any user input), `ts_rank_cd` ranking, `ts_headline` snippets, collection and video filters, limit.
- `KvStore` with TTL and cursor listing; `VectorStore` with model filtering and cosine order.
- Map connection, auth and timeout errors to `Vid2ContextError` codes with hints that name the env var to check. Never log the connection string.

## Prefer free and local

For local use, prompt 37's SQLite is the default. For hosted use, document free options first: Neon free tier, Supabase free tier, a local Docker `pgvector/pgvector` container, then paid managed Postgres (Cloud SQL, Railway, ApsaraDB).

## Out of scope

- SQLite and Cloudflare D1: prompts 37 and 20.
- Ranking fusion and rerank: prompt 40.
- Database provisioning in deploy configs: prompts 49 and 50 (you document connection strings only).

## Tests

- Unit tests against real Postgres: PGlite (`@electric-sql/pglite`, Postgres compiled to WASM, with its pgvector extension) as a devDependency of this package. It is a real database engine, not a mock. Run the full `Storage` contract (written against the interface so prompt 23's shared suite can replace it later), KV, and vectors.
- Load the real fixtures `tests/fixtures/contexts/youtube-cCPsdFdlshc.json` and `youtube-jNQXAC9IVRw.json`; assert search hits on words that really occur in them, `websearch_to_tsquery` handling of quotes and `-exclude`, tenant isolation (two tenants, same video id, no leakage), and migration idempotency (run twice).
- Vectors with a real embedding response recorded once from the keyless OVH `bge-m3` endpoint (`LIVE=1`), saved as a fixture.
- Live tests (`LIVE=1`): against `DATABASE_URL` when set, or a Docker `pgvector/pgvector` container when Docker is available; include the advisory-lock test with two concurrent `create` calls.

## Acceptance criteria

- [ ] `npx tsc -p tsconfig.json --noEmit 2>&1 | grep -E 'providers/storage-postgres'` prints nothing.
- [ ] `npx vitest run providers/storage-postgres` passes on PGlite; `npx biome check providers/storage-postgres` is clean.
- [ ] With `DATABASE_URL` set, `registry.openStorage(ctx)` returns this backend; without it, it stays disabled.
- [ ] `EXPLAIN` of a vector query shows the HNSW index in use (paste the plan in your report) on a real Postgres if available.

## Docs

- `docs/guides/library-postgres.md`: connection strings and setup for Neon, Supabase, Cloud SQL, Railway, ApsaraDB and local Docker; enabling pgvector; tenancy; migrations; backups.
- Your row in `docs/providers.md`; `DATABASE_URL`, `VID2CONTEXT_DATABASE_URL`, `VID2CONTEXT_PG_SCHEMA`, `VID2CONTEXT_TENANT` in `.env.example` (check for existing names first).

## If credentials, tools or network are missing

PGlite covers the unit tests offline. Without a real Postgres or Docker, skip live tests with a clear message and report that the Neon/Workers path and the HNSW plan were not verified on a server.

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

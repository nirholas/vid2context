# 37. SQLite library with full-text search

| | |
|---|---|
| Track | G. Library and search |
| You own | `providers/storage-sqlite/` |
| Shared edits allowed | `packages/core/src/storage-ext.ts` (create from SHARED-CONTRACTS 1.1 if missing) and its `export *` line in `packages/core/src/index.ts`; your rows in `docs/providers.md` and your variables in `.env.example` |
| Commit scope | `storage-sqlite` |
| Runs alongside | 49 other prompts in the same folder; depends only on the foundation |

vid2context turns any video into context for AI agents: transcripts, metadata, chapters and cited briefs, free-first, as a CLI, MCP server, HTTP API and web app. Today the library lives in `MemoryStorage` and vanishes on restart. The owner's research workflow (a "G-Wagon" collection fed from a playlist, searched across every episode) needs a persistent local library with real full-text search that works with zero setup. SQLite built into Node (`node:sqlite`) gives exactly that: no server, no dependency, one file under `.vid2context/`. Because storage backends register like providers, the CLI, MCP server and HTTP API pick it up automatically through `registry.openStorage(ctx)`.

## Read first

1. `CLAUDE.md` and `AGENTS.md`, then `docs/ARCHITECTURE.md` (Storage section).
2. `packages/core/src/storage.ts` (the `Storage` interface, `VideoSummary`, `Collection`, `SearchQuery`, `SearchHit`, `Page`, and `MemoryStorage` as the reference behaviour), `packages/core/src/provider.ts` (`StorageProvider`: `priority`, `isEnabled(env)`, `create(ctx)`), `packages/core/src/registry.ts` (`openStorage`), and `packages/core/src/testing.ts`.
3. `docs/contracts/providers.md` (Storage providers section: unknown ids throw `not-found`, raw transcripts always stored).
4. `providers/media-file/` as the reference for a node-only provider package (`"vid2context": { "runtimes": ["node"] }`).
5. `docs/prompts/SHARED-CONTRACTS.md`, sections 1.1 (`KvStore`, `VectorStore`), 7, 8 and 9 (data directory).

## Goal

`@vid2context/provider-storage-sqlite` is a node-only storage provider implementing `Storage`, `KvStore` and `VectorStore` on `node:sqlite`, with FTS5 search ranked by bm25, versioned migrations, and safe concurrent access, enabled by default on Node.

## Requirements

### Database

- `DatabaseSync` from `node:sqlite`. Path: `VID2CONTEXT_DB`, else `<VID2CONTEXT_HOME or .vid2context>/library.db`; create the directory. `:memory:` allowed for tests.
- Pragmas: `journal_mode=WAL`, `busy_timeout` (5000 ms default), `foreign_keys=ON`, `synchronous=NORMAL`.
- Versioned migrations keyed on `PRAGMA user_version`, each in its own transaction, idempotent, applied on `create(ctx)`. Never drop user data in a migration.
- Verify at startup that FTS5 is available in Node's bundled SQLite (`CREATE VIRTUAL TABLE ... USING fts5` in a probe). If it is not, fall back to `LIKE` search with a single `ctx.log.warn` and report it; the backend must still work.

### Schema

- `videos`: id (primary key, the ref id), ref JSON, title, channel, duration_sec, origin, language, saved_at, context JSON (the full `VideoContext`, raw transcript included).
- `segments`: video_id (foreign key, cascade delete), idx, start_sec, end_sec, text, speaker; primary key (video_id, idx).
- `segments_fts`: FTS5 over segment text (external content table pointing at `segments`, `tokenize='unicode61 remove_diacritics 2'`), kept in sync with triggers or explicit writes inside the same transaction.
- `collections` and `collection_items` (ordered, unique per collection), matching `Collection` semantics in `MemoryStorage` (created and updated timestamps, sources list).
- `kv`: key, JSON value, expires_at; implements `KvStore` with TTL (expired rows invisible and lazily purged) and prefix listing with cursors.
- `vectors`: id, model, video_id, start_sec, end_sec, text, vector as a Float32 BLOB; implements `VectorStore` with exact cosine search in JavaScript, filtered by model and optional video ids. Note sqlite-vec as a later option in the docs; do not depend on it.

### Behaviour

- `putContext` replaces a video's row and segments atomically. `deleteContext` removes it from collections too, like `MemoryStorage`.
- `listContexts` newest first with an opaque cursor (keyset pagination on saved_at and id).
- Collection methods throw `Vid2ContextError('not-found')` with a hint for unknown ids (the contract rule).
- `search(query)`: FTS5 `MATCH` with bm25 ranking, `snippet()` or the full segment text, filtered by `collectionId` and `videoIds`, limited. Build the MATCH expression safely from user text: quote each term, support `"exact phrases"` and trailing `*` prefixes the user typed, drop FTS operators and unbalanced quotes, so no input can cause an FTS syntax error. Return `SearchHit` with a normalized score (higher is better).

### Provider

- Default export a `StorageProvider` with id `storage-sqlite`, runtimes `["node"]`, `isEnabled(env)`: true unless `VID2CONTEXT_STORAGE` names a different backend (`memory`, `postgres`, `cloudflare`, ...); `priority` chosen so an explicitly configured remote backend (Postgres) wins over SQLite, and SQLite wins over nothing. Document the order in `docs/providers.md`.
- Close the database cleanly on process exit; one connection per `create`.

## Prefer free and local

This is the free, local, private default: no server, no account, data stays in one file on the user's machine.

## Out of scope

- Postgres and Cloudflare backends: prompts 39 and 20.
- Hybrid ranking, embeddings and rerank: prompt 40 (you only store and query vectors).
- Collections refresh and watch lists: prompt 41.

## Tests

- Run the full `Storage` contract (write it against the interface, mirroring `MemoryStorage` behaviour, so prompt 23's shared suite can replace it later) on an in-memory and an on-disk database in a temp directory.
- Load the real fixtures `tests/fixtures/contexts/youtube-cCPsdFdlshc.json` and `youtube-jNQXAC9IVRw.json`; assert search hits on words that really occur in those transcripts (read them first), ranking order for a two-word query, phrase queries, prefix queries, and that hostile input (`"`, `NEAR(`, `*`, `-`, `OR`) returns results or nothing but never throws.
- KvStore: TTL expiry, prefix listing with cursors. VectorStore: upsert, model filtering, delete by video, cosine order with real embedding vectors (record one real response from the keyless OVH `bge-m3` embedding endpoint with `LIVE=1`, save it as a fixture).
- Concurrency: two connections to the same file, interleaved writes and reads, no `SQLITE_BUSY` failure within the timeout.
- Migration from an empty file, and reopening an existing file at the current version.

## Acceptance criteria

- [ ] `npx tsc -p tsconfig.json --noEmit 2>&1 | grep -E 'providers/storage-sqlite'` prints nothing.
- [ ] `npx vitest run providers/storage-sqlite` passes; `npx biome check providers/storage-sqlite` is clean.
- [ ] After `npm run gen`, `registry.openStorage(createNodeContext())` returns the SQLite backend by default and `MemoryStorage`-only behaviour is gone unless `VID2CONTEXT_STORAGE=memory`.
- [ ] A real run: `npm run cli -- https://www.youtube.com/watch?v=jNQXAC9IVRw` twice; the second run is served from `.vid2context/library.db` (no network calls; check attempts or logs), if the foundation CLI opens storage. If it does not yet, prove the same with a short `tsx` script and say so.

## Docs

- `docs/guides/library-sqlite.md`: where the file lives, backups (`VACUUM INTO`), search syntax users can type, limits.
- Your row in `docs/providers.md`; `VID2CONTEXT_DB` and `VID2CONTEXT_STORAGE` in `.env.example` (check they are not already defined there).

## If credentials, tools or network are missing

Nothing here needs a key. If `node:sqlite` lacks FTS5, ship the `LIKE` fallback and report it. If the network is down, skip the embedding fixture recording and test vectors with vectors you compute from a recorded fixture elsewhere in the repo, or report that the vector test used no real embeddings.

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

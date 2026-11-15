# 20. Cloudflare: Workers AI rungs and D1, R2, KV storage

| | |
|---|---|
| Track | D. Speech-to-text |
| You own | `providers/cloudflare-ai/` (runtimes workers, node, browser for REST), `providers/storage-cloudflare/` (runtime workers) |
| Shared edits allowed | `packages/core/src/types.ts` (optional `Ctx.bindings?: Record<string, unknown>`), `packages/core/src/context.ts` only if `createContext` must pass `bindings` through, `packages/registry/src/workers.ts` (pass non-string env bindings into `ctx.bindings`), `packages/core/src/storage-ext.ts` (create from SHARED-CONTRACTS 1.1 if missing, with its export line), `docs/contracts/providers.md` (document `bindings`), your own rows in `docs/providers.md` and variables in `.env.example` |
| Commit scope | `cloudflare` |
| Runs alongside | 49 other prompts in the same folder; depends only on the foundation |

vid2context turns any video into context for AI agents: transcripts, metadata, chapters and cited briefs, free-first, as a CLI, MCP server, HTTP API and web app. vid2context.com is deployed as a Cloudflare Worker (see the root `wrangler.jsonc` and `packages/server/src/workers.ts`). Cloudflare gives a free daily allocation of Workers AI (Whisper, Llama, embeddings) and cheap durable storage (D1 SQL with FTS5, R2 objects, KV). Today the Worker cannot use any of it: `createWorkersContext` keeps only string env values, so bindings such as `AI`, `DB` or `KV` never reach a provider. This prompt passes bindings through, adds Workers AI rungs (by binding inside Workers, by REST anywhere else), and adds a full Storage backend on D1, R2 and KV. It merges roadmap items 20 and 38.

## Read first

1. `CLAUDE.md` and `AGENTS.md`, then `docs/ARCHITECTURE.md` (runtimes, storage).
2. `packages/core/src/types.ts` (`Ctx`, `Env`), `packages/core/src/context.ts` (`createContext`), `packages/core/src/provider.ts` (`SttRung`, `LlmRung`, `EmbedRung`, `StorageProvider`), `packages/core/src/storage.ts` (`Storage`, `MemoryStorage`, `summarize`), `packages/core/src/testing.ts`.
3. `packages/registry/src/workers.ts` (`createWorkersContext`), `packages/server/src/workers.ts` and the root `wrangler.jsonc` (read only; prompts 46 and 50 own them).
4. `docs/contracts/providers.md` (rungs, storage providers, env conventions) and `docs/providers.md` (the planned Cloudflare rows).
5. `docs/prompts/SHARED-CONTRACTS.md`, sections 1.1 (`storage-ext.ts`: `KvStore`, `VectorStore`, `hasKv`, `hasVectors`), 7, 8 and 9.

## Goal

Inside a Worker, `ctx.bindings` carries the raw bindings, Workers AI rungs (speech-to-text, LLM, embeddings) run through the `AI` binding, and the D1-backed Storage (with R2 for large objects, KV as a `KvStore`, and Vectorize as a `VectorStore` when bound) passes the full Storage contract. Outside Workers, Workers AI speech-to-text and embeddings run over REST with `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN`. All of it is verified against real local Cloudflare runtimes, not mocks.

## Requirements

### Bindings plumbing (minimal shared edits)

- Add `bindings?: Record<string, unknown>` to `Ctx` in `types.ts`, documented as "platform objects such as Cloudflare bindings; providers must treat them as optional". Pass it through `createContext` if needed.
- In `createWorkersContext(env)`, keep building string `env` as today and also pass every non-string value in `ctx.bindings`. Existing callers keep working.
- Document the field in `docs/contracts/providers.md` in the same commit.

### `providers/cloudflare-ai`

- Binding rungs (tier `free`, the daily free neuron allocation), used when `ctx.bindings.AI` exists. Because `rungs(env)` is env-only, enable them with an env flag the Worker sets (`CLOUDFLARE_AI_BINDING=AI`, the binding name), and read the binding from `ctx.bindings` at call time, failing with a hint when it is missing:
  - STT `stt/cloudflare-binding/@cf/openai/whisper-large-v3-turbo` (and `@cf/openai/whisper` if still offered): send audio as the model expects (verify the input format today: base64 or byte array), map segments or VTT output to `Segment[]`, report language.
  - LLM `llm/cloudflare-binding/<model>` for `@cf/meta/llama-3.3-70b-instruct-fp8-fast` plus other current text models you verify in the models list; `json` capability only where verified; streaming via `StreamingLlmRung` if the binding's stream option works (create `llm-stream.ts` from SHARED-CONTRACTS 1.2 only if you implement it and it is missing).
  - Embeddings `embed/cloudflare-binding/@cf/baai/bge-m3` with its real dimensions.
- REST rungs (tier `free`, `requires: ['CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_API_TOKEN']`), runtimes node, workers and browser: STT and embeddings through `https://api.cloudflare.com/client/v4/accounts/<id>/ai/run/<model>`. The Cloudflare REST LLM rung belongs to prompt 24 (free LLM catalog) through Cloudflare's OpenAI-compatible endpoint; do not add a second one. Use distinct ids (`stt/cloudflare/...`, `embed/cloudflare/...`).
- Model ids overridable: `CLOUDFLARE_STT_MODEL`, `CLOUDFLARE_EMBED_MODEL`, `CLOUDFLARE_BINDING_MODEL` (LLM list). Map Cloudflare error bodies (quota exceeded, model not found) to error codes with hints.

### `providers/storage-cloudflare` (runtime workers)

- StorageProvider enabled when the Worker sets `VID2CONTEXT_D1=<binding name>` (env-only `isEnabled`), priority ahead of `MemoryStorage`. `create(ctx)` reads the D1 binding (and optional `VID2CONTEXT_R2`, `VID2CONTEXT_KV`, `VID2CONTEXT_VECTORIZE` binding names) from `ctx.bindings`.
- D1 schema in `providers/storage-cloudflare/migrations/*.sql` (numbered, applied with `wrangler d1 migrations apply` and also checked at startup through a `schema_version` table): `videos` (id, ref JSON, title, channel, duration, origin, language, saved_at, context JSON or an R2 key), `segments` (video_id, idx, start, end, text, speaker), an FTS5 virtual table over segment text, `collections`, `collection_items`.
- R2: store context JSON in R2 when it exceeds a size threshold (D1 rows have size limits; verify the current limit) and keep the R2 key in D1; also expose `putBlob/getBlob` helpers for uploaded media that prompt 46 can use later.
- KV implements `KvStore` (with TTL via `expirationTtl`, minimum 60 seconds; document the clamp); without a KV binding, store KV rows in a D1 table.
- Vectorize implements `VectorStore` when bound (index per embedding model and dimension; metadata filter by videoId); otherwise do not claim `VectorStore`.
- Implement every `Storage` method: contexts, listing with cursors, collections, search with FTS5 `bm25` ranking and safe query escaping, deletes that cascade. `Vid2ContextError('not-found')` for unknown ids.

## Prefer free and local

Workers AI and D1, R2, KV all have free allocations; document them with the date checked. In Workers, binding rungs avoid REST round trips and tokens. On Node, local rungs still come first; Cloudflare REST rungs sit in the free tier with the other hosted free options.

## Out of scope

- The Worker entry, `wrangler.jsonc` and deployment: prompt 50 (serverless) and prompt 46 (server). Do not edit them; document the bindings they need in your guide.
- The Cloudflare REST LLM rung: prompt 24. Other embedding rungs: prompt 29. SQLite and Postgres backends: prompts 37 and 39. Search ranking beyond FTS: prompt 40.

## Tests

- Run against real local Cloudflare implementations with Miniflare (workerd's D1, R2 and KV), or `@cloudflare/vitest-pool-workers` if it fits the repo's vitest setup better. These are real engines, not mocks. Workers AI has no local engine: test binding rungs by recording real REST responses for the same models and replaying them through an adapter, and test the binding call path LIVE in `wrangler dev` (remote AI is used by `wrangler dev` with an account).
- Storage: the full contract over the real fixtures `tests/fixtures/contexts/*.json` (save, get, list with cursor, collections, search for words that really occur in the transcripts, delete), plus `KvStore` TTL behaviour and the R2 overflow path with a large context.
- Bindings plumbing: `createWorkersContext({ AI: {...object}, FOO: 'bar' })` yields `env.FOO` and `bindings.AI`.
- LIVE with `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN`: REST Whisper on `tests/fixtures/media/apollo11-small-step.mp3`, REST bge-m3 embeddings; record those responses as fixtures.

## Acceptance criteria

- [ ] `npx tsc -p tsconfig.json --noEmit 2>&1 | grep -E 'providers/(cloudflare-ai|storage-cloudflare)|packages/(core/src/types|registry/src/workers)'` prints nothing.
- [ ] `npx vitest run providers/cloudflare-ai providers/storage-cloudflare` passes; `npx biome check providers/cloudflare-ai providers/storage-cloudflare` is clean.
- [ ] Existing tests for `packages/registry` and `packages/core` still pass (`npx vitest run packages/registry packages/core`).
- [ ] In `wrangler dev` with a D1 binding, a context saved through the Worker is found again by search (LIVE, or reported).
- [ ] REST Whisper transcribes the Apollo clip (LIVE, or reported as unverified for lack of credentials).

## Docs

- `docs/guides/cloudflare.md`: bindings and the env flags that enable each piece, a `wrangler.jsonc` snippet for D1, R2, KV, AI and Vectorize (for prompt 50 to adopt), migrations, free limits with dates, what runs by binding versus REST.
- `bindings` in `docs/contracts/providers.md`; your rows in `docs/providers.md` and variables in `.env.example`.

## If credentials, tools or network are missing

Miniflare runs locally without an account, so storage is fully testable. Without Cloudflare credentials, the Workers AI rungs ship tested only against responses you could record; if you could record none, ship storage and the plumbing, leave the AI rungs out, and report it.

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

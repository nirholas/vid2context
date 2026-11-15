# 29. Embedding rungs, free first

| | |
|---|---|
| Track | E. LLM and embeddings |
| You own | `providers/embed/`, `providers/embed-transformers/` |
| Shared edits allowed | `docs/providers.md` and `.env.example` (your rows and variables only) |
| Commit scope | `embed` |
| Runs alongside | 49 other prompts in the same folder; depends only on the foundation |

vid2context turns any video into context for AI agents: transcripts, metadata, chapters and cited briefs, free-first, as a CLI, MCP server, HTTP API and web app. Searching a research library by meaning ("which episode talks about the timing chain?") and retrieving the right passages for question answering both need embeddings. The core already defines `EmbedRung` and `EmbedProvider`, but no provider supplies any. This prompt adds embedding rungs in the same free-first order as everything else: local first, free tiers, then keyless OVH (verified live from this VM, no key), and paid last. Embeddings have one rule the other chains do not: vectors from different models cannot be compared, so falling back to another model silently would corrupt an index. The helpers here make that impossible to get wrong.

## Read first

1. `CLAUDE.md` and `AGENTS.md`, then `docs/ARCHITECTURE.md`.
2. `packages/core/src/provider.ts` (`EmbedRung` with `dimensions` and `embed(texts, ctx)`, `EmbedProvider`, `rungs(env)`), `packages/core/src/registry.ts` (`embedRungs(env)`), `packages/core/src/chain.ts`, `packages/core/src/keys.ts`, `packages/core/src/testing.ts`.
3. `providers/llm-openai-compatible/` as the reference rung provider (lanes, pools, error handling, fixtures README).
4. `docs/contracts/providers.md`, `docs/providers.md` (the "Planned" embed row), and `docs/prompts/SHARED-CONTRACTS.md` sections 1.1 (`VectorRecord.model`), 8 and 9.

## Goal

`registry.embedRungs(env)` returns working embedding rungs with zero configuration (OVH keyless `bge-m3`), more with local servers or free keys, and the package exports helpers that pin one model per index so callers (search, ask, storage backends) never mix vectors from different models.

## Requirements

### `providers/embed` (`@vid2context/provider-embed`, HTTP rungs)

- Runtimes `node`, `workers`, `browser`; plain `fetch` against OpenAI-compatible `/embeddings` where available. One `EmbedProvider` with id `embed`.
- Rungs (ids `embed/<service>/<model>`), each verified live or against current docs:
  - local: Ollama (`OLLAMA_EMBED_MODEL`, for example `nomic-embed-text` or `bge-m3`; base from `OLLAMA_BASE_URL`, using `/api/embed` or `/v1/embeddings`), LM Studio (`LMSTUDIO_EMBED_MODEL`), generic `LOCAL_EMBED_BASE_URL` + `LOCAL_EMBED_MODEL`.
  - free: Gemini embeddings through the OpenAI-compatible endpoint (`GEMINI_API_KEY`, `GEMINI_EMBED_MODEL`, verify the current model id), Mistral `mistral-embed` (`MISTRAL_API_KEY`), Jina (`JINA_API_KEY`, free tier; verify) and Cloudflare Workers AI REST `@cf/baai/bge-m3` (`CLOUDFLARE_ACCOUNT_ID` + `CLOUDFLARE_API_TOKEN`; prompt 20 owns the binding variant, so use service name `cloudflare` and leave bindings out).
  - keyless: OVH AI Endpoints `bge-m3` and `Qwen3-Embedding-8B` (both listed in `GET https://oai.endpoints.kepler.ai.cloud.ovh.net/v1/models`; verify the embeddings route and dimensions live).
  - paid: OpenAI `text-embedding-3-small` (`OPENAI_API_KEY`, `OPENAI_EMBED_MODEL`).
- Per rung: true `dimensions` (measured live, not guessed), batch size limit, max input tokens with safe truncation on a word boundary (using a conservative character budget), L2 normalization of outputs so cosine and dot product agree, `<PROVIDER>_EMBED_MODEL` override and `<PROVIDER>_FALLBACK_KEYS` pools, quality scores reflecting retrieval quality (bge-m3 and Qwen3 embeddings high, small local models lower), `requires` per the tier rules.
- Batching: split large `texts` arrays into the rung's batch size, keep order, retry a failed batch once on 5xx.

### `providers/embed-transformers` (`@vid2context/provider-embed-transformers`)

- Runtimes `node` and `browser`. Uses `@huggingface/transformers` with a small multilingual sentence-embedding model (for example a `bge-small` or `multilingual-e5-small` ONNX export; choose one, measure its dimensions and speed, document why), mean pooling and normalization, WebGPU in browsers when available with WASM fallback, onnxruntime in Node, model cache under `.vid2context/models` on Node.
- Tier `local`, enabled by `TRANSFORMERS_EMBED_MODEL` (env-only check). Loads the model lazily on first use and reuses it.

### Model pinning helpers (exported from `providers/embed`)

- `pickEmbedModel(registry, env, opts?)`: the rung id an index should use, by policy (first enabled rung in free-first order, or `VID2CONTEXT_EMBED_MODEL` when set).
- `embedWithModel(registry, rungId, texts, ctx)`: embeds with exactly that rung, no fallback to other models; on failure it throws a `Vid2ContextError` whose hint explains that switching models requires re-indexing, and names other enabled rungs. It may retry the same rung and other pooled keys of the same service and model (`groq`, `groq#2` style), since those produce identical vectors.
- `embedQuery(registry, index: { model }, query, ctx)`: embeds a query with the index's model (and the query prefix convention for models that need one, such as e5 `query:` and `passage:`).
- Document clearly in the package README and guide: an index records its model id (`VectorRecord.model` in `storage-ext.ts`); queries use that model; changing models means re-indexing.

## Prefer free and local

Default order: local (Ollama, LM Studio, Transformers.js) if configured, then free keys, then keyless OVH, then paid. With nothing configured, OVH `bge-m3` works out of the box; `VID2CONTEXT_KEYLESS=0` turns it off.

## Out of scope

- Search and indexing logic: prompt 40. Vector storage: prompts 20, 37, 39 (and `MemoryVectors` in `storage-ext.ts`). Retrieval for Q&A: prompt 34.

## Tests

- Record real responses into each package's `test/fixtures/` (README per file): OVH `bge-m3` and `Qwen3-Embedding-8B` embeddings for a small batch of real sentences taken from `tests/fixtures/contexts/youtube-cCPsdFdlshc.json`, the OVH `/models` listing, one real error (oversized batch or bad model), and responses from any keyed or local service you can reach.
- Unit tests with `replayFetch`: rung construction from env, batching and order, truncation, normalization, dimensions, `embedWithModel` refusing to fall back across models while allowing pooled keys of the same model.
- Semantic sanity on recorded vectors: paraphrase pairs from the real transcript score higher cosine than unrelated pairs.
- Transformers.js: a Node LIVE test that downloads the model and embeds real sentences; a unit test on the recorded output shape.

## Acceptance criteria

- [ ] `npx tsc -p tsconfig.json --noEmit 2>&1 | grep -E 'providers/embed'` prints nothing.
- [ ] `npx vitest run providers/embed providers/embed-transformers` passes; `npx biome check providers/embed providers/embed-transformers` is clean.
- [ ] With no keys, a `tsx` script embeds three real transcript sentences through `registry.embedRungs(env)` using OVH keyless and prints dimensions and pairwise cosines.
- [ ] The workers registry includes `embed` but not `embed-transformers` (check the generated files after `npm run gen`).

## Docs

- `docs/guides/embeddings.md`: rungs, dimensions, limits, the pinning rule with an example of re-indexing.
- Replace the "Planned" embed row in `docs/providers.md` with real rows; add variables to `.env.example`.

## If credentials, tools or network are missing

OVH keyless needs no key and must be verified live. For keyed services without a key, include them only if their docs are unambiguous, mark them "not verified live" in `docs/providers.md`, and list them in your report. Never write vector fixtures by hand.

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

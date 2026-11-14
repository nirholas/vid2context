# 24. LLM rung catalog: more free tiers, keyless lanes, OpenRouter free picker, check:llm

| | |
|---|---|
| Track | E. LLM and embeddings |
| You own | `providers/llm-free-catalog/`, `providers/llm-openrouter/`, `scripts/check-llm.ts` |
| Shared edits allowed | root `package.json` (the `check:llm` script only), `docs/providers.md` and `.env.example` (your rows and variables only) |
| Commit scope | `llm` |
| Runs alongside | 49 other prompts in the same folder; depends only on the foundation |

vid2context turns any video into context for AI agents: transcripts, metadata, chapters and cited briefs, free-first, as a CLI, MCP server, HTTP API and web app. The LLM chain is what cleans captions, names speakers, writes briefs and answers questions, and it must work with zero money: every free key the user adds should add rungs, and the keyless lanes are the safety net. The foundation's `providers/llm-openai-compatible` already ships Ollama, LM Studio, a generic local server, Groq, Cerebras, Mistral, GitHub Models, Gemini AI Studio, OVH and Pollinations keyless, and OpenAI. This prompt adds the rest of the free catalog in a new package (never editing the foundation package), an OpenRouter rung that always picks a live `:free` model instead of pinning ids that get retired, and `npm run check:llm`, which sends one real request to every enabled rung so the owner can see what works today. It absorbs roadmap item 25 (OpenRouter and check:llm).

## Read first

1. `CLAUDE.md` and `AGENTS.md`, then `docs/ARCHITECTURE.md` (the rung chain section).
2. `packages/core/src/provider.ts` (`LlmRung`, `LlmProvider`, `rungs(env)`, `ChatRequest`), `packages/core/src/keys.ts` (`keyPool`, `pooledService`), `packages/core/src/chain.ts` (cooldowns, `rankRungs`), `packages/core/src/errors.ts` (`errorFromResponse`), `packages/core/src/testing.ts`.
3. `providers/llm-openai-compatible/src/index.ts` and `client.ts` (the `LANES` table and the exported `chatWith`, `buildBody`, `answerText`) and its `test/fixtures/README.md`. Read the current lanes first: never duplicate a rung id that package already produces.
4. `docs/contracts/providers.md` (rung fields, env conventions, keyless lanes, model ids) and `docs/providers.md` (including its "Planned" table, which lists the services this prompt adds and their known limits).
5. Read-only references from the owner's other repos (never edit them): `/home/user/sperax/docs/llm-fallback-chain.md` and `/home/user/three.ws/api/_lib/llm.js` (Kilo Code gateway details, multi-key pools, the OpenRouter free picker idea).
6. `docs/prompts/SHARED-CONTRACTS.md`, sections 8 and 9.

## Goal

With any combination of free keys, `registry.llmRungs(env)` includes every service in the free catalog as its own rung (one per model and per pooled key), the keyless Kilo Code lane works with no key, OpenRouter always resolves to a currently free model, and `npm run check:llm` prints a truthful table of which rungs answered and why the others failed.

## Requirements

### `providers/llm-free-catalog` (`@vid2context/provider-llm-free-catalog`)

- Runtimes `node`, `workers`, `browser` (plain fetch). One `LlmProvider` with id `llm-free-catalog`. Reuse `chatWith` and `buildBody` from `@vid2context/provider-llm-openai-compatible` (it is a workspace package; add it as a dependency) rather than writing a second client. If you need a behavior the exported client lacks, wrap it in your package; do not edit the foundation package.
- Lanes to add, each verified against the service's current docs and, where you have a key or the lane is keyless, live:
  - Kilo Code gateway, keyless (optional `KILO_API_KEY` raises limits): endpoint and free model ids as in three.ws `llm.js`; verify they still answer.
  - NVIDIA NIM `nvidia/nemotron-3-super-120b-a12b` (`NVIDIA_API_KEY`), free.
  - SambaNova Cloud `Meta-Llama-3.3-70B-Instruct` (`SAMBANOVA_API_KEY`), free.
  - Zhipu `glm-4.7-flash` (`ZHIPU_API_KEY`), free.
  - SiliconCloud free models (`SILICONFLOW_API_KEY`; confirm the env name and which models are free today).
  - Cloudflare Workers AI REST through its OpenAI-compatible endpoint, `@cf/meta/llama-3.3-70b-instruct-fp8-fast` (`CLOUDFLARE_ACCOUNT_ID` + `CLOUDFLARE_API_TOKEN`), free. Rung ids `llm/cloudflare/...`. Prompt 20 owns the Workers AI binding rungs (`llm/cloudflare-binding/...`); do not add binding code here.
  - Extra per-model Groq or Cerebras rungs only when they are free today and missing from the foundation lanes (check `GROQ_MODEL` defaults first).
- Every lane: `<PROVIDER>_MODEL` (comma-separated list replacing defaults), `<PROVIDER>_FALLBACK_KEYS` pools via `keyPool`, `<PROVIDER>_BASE_URL` override where the service allows, `json` and JSON Schema capability flags set only where verified, `contextTokens` and quality scores per model, priorities placed sensibly among the foundation's free rungs (read their priorities).
- Correctness: strip `reasoning` and `reasoning_content` from answer text (the foundation's `answerText` may already do this: check), respect per-service limits on `max_tokens` and `temperature`, map error bodies through `errorFromResponse`, and set `retryAfterSec` from rate-limit headers where the service sends them.

### `providers/llm-openrouter` (`@vid2context/provider-llm-openrouter`)

- Tier `free`, `OPENROUTER_API_KEY` (pooled). Never pin a `:free` id: they are retired without notice.
- `pickFreeModels(ctx)`: fetch `https://openrouter.ai/api/v1/models`, keep models whose prompt and completion prices are zero and whose id ends in `:free`, rank by context length, recency (`created`) and a small preference list for strong families, cache the ranked list in memory for one hour.
- Rung `llm/openrouter/free-auto`: its `chat()` picks the best cached candidate, and on `not-found`, `rate-limited` or upstream errors tries the next candidate (up to 3) before failing, recording which model answered in `ChatResult.model`.
- Rung `llm/openrouter/<model>` for each id in `OPENROUTER_MODEL` (explicit choices, may be paid models; mark tier `paid` when the id lacks `:free`).
- Send the `HTTP-Referer` and `X-Title` headers OpenRouter recommends, with `https://vid2context.com` and `vid2context`.

### `scripts/check-llm.ts` and `npm run check:llm`

- Loads env with `loadEnvFiles()` from `@vid2context/registry/node`, builds the node registry, and sends one tiny real request (a short instruction with a fixed expected answer) to every enabled LLM rung, with a per-rung timeout and limited concurrency so keyless lanes are not hammered (OVH allows about 2 requests per minute per model per IP).
- Prints a table to stdout: rung id, tier, service, ms, outcome (`ok`, or the error code and short reason), answer correct yes or no. `--json` prints JSON. `--only` and `--skip` filters, `--include-paid` (paid rungs are skipped unless passed, to avoid spend). Exit code nonzero when no rung succeeds.
- Root script: `"check:llm": "tsx scripts/check-llm.ts"` (re-read `package.json` right before editing; others add scripts too).

## Prefer free and local

Free tiers with the user's own key first, keyless lanes as the safety net, paid only with a key and only when allowed. Local rungs are not yours: prompt 27 owns them.

## Out of scope

- Local rungs (Ollama, LM Studio, llama.cpp, vLLM, Jan): prompt 27, which also moves them out of the foundation package.
- Streaming: prompt 25 adds `stream` to the foundation's OpenAI-compatible rung factory. If you build rungs with your own wrapper, keep it compatible with that (do not block a `stream` method from being attached later), and mention in your report that your lanes need streaming wired in the integration pass if prompt 25 has not covered them.
- Native Anthropic and Gemini APIs: prompt 26. Embeddings: prompt 29. The model picker and `/models`: prompts 25, 28, 46.

## Tests

- Record real responses into each package's `test/fixtures/` (with a README line per file): one chat completion per lane you can reach (Kilo keyless live today; keyed lanes when you have keys), one JSON-mode response where supported, one real 429 or 401 error body, and a real OpenRouter `/models` response.
- Unit tests with `replayFetch`: rung construction from env (defaults, model lists, pools, disabled rungs without keys), no rung id collides with the foundation package for any env combination you test, request bodies, answer extraction with reasoning stripped, error mapping, the OpenRouter picker ranking on the recorded models list and its fallthrough on a recorded 404.
- `check:llm` logic tested with recorded responses (table formatting, exit code).
- LIVE tests for every keyless lane and for keyed lanes when keys exist.

## Acceptance criteria

- [ ] `npx tsc -p tsconfig.json --noEmit 2>&1 | grep -E 'providers/llm-free-catalog|providers/llm-openrouter|scripts/check-llm'` prints nothing.
- [ ] `npx vitest run providers/llm-free-catalog providers/llm-openrouter` passes; `npx biome check providers/llm-free-catalog providers/llm-openrouter scripts/check-llm.ts` is clean.
- [ ] `npm run check:llm` on this VM with no keys shows the keyless lanes (foundation's and yours) answering, and with `--json` emits valid JSON.
- [ ] Health output lists every new rung with `enabled` and the env vars it needs, never values.

## Docs

- Move each service you implemented from the "Planned" table to a real table in `docs/providers.md` with tier, env vars, free limits and the date verified; add the variables to `.env.example`.
- `docs/guides/llm.md`: how the LLM chain picks rungs, how to add free keys, OpenRouter behavior, and how to read `check:llm`.

## If credentials, tools or network are missing

Without a key for a service, you cannot record it: implement it only if its docs are unambiguous, mark it "not verified live" in `docs/providers.md`, and list it in your report. Never fake a response fixture. Keyless lanes and the OpenRouter models list need no key and must be verified live.

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

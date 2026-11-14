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

<!-- COMMON -->

# 26. Native Anthropic and Gemini providers, with Vertex AI

| | |
|---|---|
| Track | E. LLM and embeddings |
| You own | `providers/llm-native/` |
| Shared edits allowed | `packages/core/src/llm-stream.ts` (create from SHARED-CONTRACTS 1.2 if missing, with its export line), `docs/providers.md` and `.env.example` (your rows and variables only) |
| Commit scope | `llm-native` |
| Runs alongside | 49 other prompts in the same folder; depends only on the foundation |

vid2context turns any video into context for AI agents: transcripts, metadata, chapters and cited briefs, free-first, as a CLI, MCP server, HTTP API and web app. Most LLMs are reached through OpenAI-compatible endpoints, but two families are worth native support because their native APIs do something the compatible endpoints do not: Anthropic's Messages API has prompt caching (ask ten questions about the same 90k-token playlist and pay for the transcript once) and Claude's strong long-document reasoning, and Gemini's `generateContent` API has a 1M-token context, context caching and native streaming. The owner runs on GCP, so Vertex AI access to both (Claude on Vertex, Gemini on Vertex) is useful when it can be verified. Users choose these models in the chat page's model picker like any other rung.

## Read first

1. `CLAUDE.md` and `AGENTS.md`, then `docs/ARCHITECTURE.md`.
2. Load the `claude-api` skill before writing the Anthropic part: it has the current model ids, prompt caching rules, streaming event names and structured output guidance. Confirm model ids with `GET https://api.anthropic.com/v1/models` when a key is present.
3. `packages/core/src/provider.ts` (`LlmRung`, `ChatRequest` with `json`, `ChatResult` with `usage`), `packages/core/src/keys.ts`, `packages/core/src/errors.ts` (`errorFromResponse`), `packages/core/src/testing.ts`.
4. `providers/llm-openai-compatible/` as the reference rung provider (lanes, pools, fixtures README). Note it already has a Gemini rung through the OpenAI-compatible endpoint (`llm/gemini/...`): your native Gemini rungs use a different service name (`gemini-native`) so ids never collide.
5. `docs/contracts/providers.md`, `docs/providers.md` (the "Planned" row for Anthropic), and `docs/prompts/SHARED-CONTRACTS.md` sections 1.2 (`llm-stream.ts`), 3 (`ModelInfo`), 8 and 9.

## Goal

`providers/llm-native` contributes Anthropic rungs (paid, `ANTHROPIC_API_KEY`), native Gemini rungs (free tier, `GEMINI_API_KEY`), and Vertex AI rungs for both (paid, GCP credentials), each streaming natively, supporting JSON output, and caching long transcripts so repeated questions are cheap.

## Requirements

### Package

- `@vid2context/provider-llm-native`, runtimes `node`, `workers`, `browser` for the API-key paths (plain `fetch`, no vendor SDKs). One `LlmProvider` with id `llm-native` building rungs from `rungs(env)`. Every rung implements `StreamingLlmRung` from `packages/core/src/llm-stream.ts` (create it exactly as SHARED-CONTRACTS 1.2 shows if missing, following that section's procedure).
- If prompt 25's `parseSSE` (in `packages/core/src/llm/`) exists when you get there, use it; otherwise write a small SSE parser inside your package and note it for the integration pass.

### Anthropic (Messages API)

- `POST https://api.anthropic.com/v1/messages` with `x-api-key`, `anthropic-version`, and the current beta headers only if a feature needs one. `ANTHROPIC_API_KEY` with `ANTHROPIC_FALLBACK_KEYS` pools, `ANTHROPIC_BASE_URL` override, `ANTHROPIC_MODEL` (comma-separated list) defaulting to the current cheapest Haiku, plus the current Sonnet as a higher-quality rung. Tier `paid`. `contextTokens` and quality per model from the skill or models endpoint.
- System messages map to the top-level `system` field; user and assistant messages to `messages`.
- Prompt caching: when a request contains a long block (over the model's minimum cacheable size), put it in a content block with `cache_control: { type: 'ephemeral' }`, placed so the stable prefix (instructions plus transcripts) is cached and the question is not. Report `cache_creation_input_tokens` and `cache_read_input_tokens` in `ChatResult.usage` (extend usage additively in your result object if the core type lacks fields, without editing core types).
- Streaming via SSE: `message_start`, `content_block_start`, `content_block_delta` (text deltas become `delta`, thinking deltas become `reasoning`), `message_delta` (usage, stop reason), `message_stop`, and `error` events. `ping` ignored.
- JSON: for `req.json` with a schema, force a single tool whose `input_schema` is the schema (`tool_choice: { type: 'tool', name }`) and return the tool input serialized as the result text; for `json: true` without a schema, instruct JSON and validate it parses. Capability `json` set.
- Errors: 429 with `retry-after` and `anthropic-ratelimit-*` headers to `rate-limited` with `retryAfterSec`; 529 overloaded to `upstream` with a 30 s cooldown hint; 401 and 403 to `auth`; 400 bodies kept in the message.

### Gemini (native `generateContent`)

- `POST https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent` and `:streamGenerateContent?alt=sse`, key in the `x-goog-api-key` header. `GEMINI_API_KEY` pools, `GEMINI_NATIVE_MODEL` list defaulting to the current free-tier Flash and Flash-Lite models (verify today which are free), tier `free`, `contextTokens` 1M where true.
- Map messages to `contents` with roles `user` and `model` and `systemInstruction`. JSON via `generationConfig.responseMimeType: 'application/json'` and `responseSchema` (convert the JSON Schema subset Gemini accepts; drop unsupported keywords and document which).
- Context caching: for long transcripts reused across calls, create a cached content entry (`cachedContents`) when the content exceeds the minimum size, key it by a hash of the content and model, keep the cache name in memory with its TTL, and reuse it. Only when verified live; otherwise rely on Gemini's implicit caching and document that.
- Streaming parses SSE chunks of `GenerateContentResponse`; thinking parts (when present and flagged) become `reasoning`.
- Safety blocks (`promptFeedback.blockReason`, `finishReason: SAFETY`) become `upstream` errors with a hint, so the chain falls through.

### Vertex AI (only where verified live)

- Gemini on Vertex: `https://{location}-aiplatform.googleapis.com/v1/projects/{project}/locations/{location}/publishers/google/models/{model}:generateContent`; Claude on Vertex: the `publishers/anthropic/models/{model}:rawPredict` and `:streamRawPredict` endpoints with `anthropic_version` set to the Vertex value in the body.
- Config: `GOOGLE_CLOUD_PROJECT`, `GOOGLE_CLOUD_LOCATION` (default `us-central1`, or `global` where required), and an access token from either `GOOGLE_ACCESS_TOKEN` (all runtimes) or, on Node only, the GCE metadata server (`http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token` with `Metadata-Flavor: Google`), cached until shortly before expiry. Keep the metadata-server code in a Node-only module that the workers and browser paths never import (or gate it by `ctx.runtime` with a dynamic import).
- Rungs tier `paid`, services `vertex-gemini` and `vertex-anthropic`, enabled only when project and a token source are configured (env-only check: `GOOGLE_CLOUD_PROJECT` plus `GOOGLE_ACCESS_TOKEN` or `VID2CONTEXT_GCE_METADATA=1`).
- The owner's VM is on GCP: test there. If a path cannot be verified (no Vertex API enabled, no model access), leave that rung out and say so.

## Prefer free and local

Native Gemini is a free-tier rung and sits with the other free rungs. Anthropic and Vertex are paid: they only appear when their credentials are set and never run when `VID2CONTEXT_ALLOW_PAID=0`. Caching exists precisely to keep paid use cheap.

## Out of scope

- Gemini video understanding and Gemini audio transcription: prompt 30 (`providers/video-gemini`).
- The OpenAI-compatible Gemini rung (foundation) and the free catalog: prompt 24. Streaming helpers and the model catalog: prompt 25.

## Tests

- Record real responses into `providers/llm-native/test/fixtures/` (README per file; scrub keys and project ids if sensitive): Anthropic non-streaming, Anthropic SSE stream, Anthropic forced-tool JSON, Anthropic response showing cache creation then a second call showing cache reads, a real 429 or 401; Gemini `generateContent`, Gemini SSE stream, Gemini JSON with schema, a real error; Vertex responses for whatever you verified.
- Unit tests with `replayFetch`: request building (system mapping, cache_control placement, schema conversion), stream parsing into events (text versus reasoning), usage mapping, error mapping and cooldown-relevant fields, rung construction from env including pools and disabled rungs.
- LIVE tests per service when credentials exist.

## Acceptance criteria

- [ ] `npx tsc -p tsconfig.json --noEmit 2>&1 | grep -E 'providers/llm-native'` prints nothing.
- [ ] `npx vitest run providers/llm-native` passes; `npx biome check providers/llm-native` is clean.
- [ ] Workers and browser registries do not import any Node-only module from this package (`npm run gen`, then check the generated workers and browser files and the import graph).
- [ ] With `GEMINI_API_KEY` set, a `tsx` script streams a native Gemini answer about a real transcript fixture; with `ANTHROPIC_API_KEY`, two questions about the same transcript show cache reads on the second.

## Docs

- `docs/guides/anthropic-and-gemini.md`: setup, models, caching behavior and its cost effect, Vertex setup on GCP (enable the API, model access, token source).
- Rows in `docs/providers.md` (replace the "Planned" Anthropic row) and variables in `.env.example`.

## If credentials, tools or network are missing

Without a key or GCP access you cannot record that service. Do not write payloads from documentation as if they were recordings. Ship only the services you verified live, list the rest as not included in your report, and test request building for them only if you also ship them. Native Gemini needs only a free AI Studio key; ask for it in your report if it was missing.

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

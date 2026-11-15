# Anthropic, Gemini and Vertex AI (native APIs)

`providers/llm-native` talks to Claude and Gemini through their own APIs instead of the OpenAI-compatible endpoints. The native APIs add what matters for long transcripts: Anthropic prompt caching, Gemini's 1M-token context with implicit caching, native streaming with reasoning summaries, and schema-constrained JSON. The rungs show up in the chat page's model picker and in `GET /api/v1/models` like any other.

Status on 2026-11-15 (re-checked the same day: still no keys, Vertex billing still locked): only the error paths are verified against the real services. Successful answers have never been seen by this code: no Anthropic or Gemini key was available, the Vertex project's billing was locked, and there is no keyless endpoint that speaks the native `messages` or `generateContent` protocols (keyless hosts such as Pollinations and OVH are OpenAI-compatible only, which the other LLM providers already cover). See [Verification status](#verification-status) for exactly what is and is not checked, and the one command that records the rest.

## Rungs

| Rung id | Tier | Needs |
|---|---|---|
| `llm/gemini-native/gemini-3.8-flash` | free | `GEMINI_API_KEY` |
| `llm/gemini-native/gemini-3.5-flash-lite` | free | `GEMINI_API_KEY` |
| `llm/anthropic/claude-haiku-5-5` | paid | `ANTHROPIC_API_KEY` |
| `llm/anthropic/claude-sonnet-5-5` | paid | `ANTHROPIC_API_KEY` |
| `llm/vertex-gemini/gemini-3.8-flash` | paid | `GOOGLE_CLOUD_PROJECT` + a token source |
| `llm/vertex-anthropic/claude-haiku-5-5` | paid | `GOOGLE_CLOUD_PROJECT` + a token source |

Native Gemini sits with the other free rungs, right after the OpenAI-compatible Gemini rung (both draw on the same AI Studio quota). Anthropic and Vertex are paid: they appear only when their credentials are set, and never run with `VID2CONTEXT_ALLOW_PAID=0`.

Every model list can be replaced from env, comma-separated: `GEMINI_NATIVE_MODEL`, `ANTHROPIC_MODEL`, `VERTEX_GEMINI_MODEL`, `VERTEX_ANTHROPIC_MODEL`. Extra keys in `GEMINI_FALLBACK_KEYS` and `ANTHROPIC_FALLBACK_KEYS` each become their own rung (`gemini-native#2`, `anthropic#2`) with their own cooldown.

## Gemini (free)

1. Create a key at https://aistudio.google.com/apikey (free, no billing needed).
2. Put `GEMINI_API_KEY=...` in `.env`.

Defaults are the free-tier models listed on the AI Studio pricing page on 2026-11-14: Gemini 3.8 Flash, then Gemini 3.5 Flash-Lite. The key goes in the `x-goog-api-key` header, never in the URL.

- System messages become `systemInstruction`; assistant turns use the `model` role.
- JSON: `responseMimeType: application/json`, plus `responseJsonSchema` when a schema is given. Keywords Gemini ignores (`minLength`, `maxLength`, `minProperties`, `maxProperties`, `uniqueItems`, `contains`, `minContains`, `maxContains`, `$schema`, `$id`) are dropped before sending; check those in code if they matter.
- Streaming uses `:streamGenerateContent?alt=sse` and asks for thought summaries; thought parts arrive as `reasoning` events, never mixed into the answer.
- A blocked prompt (`promptFeedback.blockReason`) or answer (`finishReason` `SAFETY`, `RECITATION`, `PROHIBITED_CONTENT`, and similar) is an `upstream` error, so the chain moves to the next rung.

### Gemini caching

Gemini 2.5 and newer cache repeated prompt prefixes on their own, from 2,048 to 4,096 tokens depending on the model, with no request field needed. Hits show up as `usage.cacheReadInputTokens` (from `usageMetadata.cachedContentTokenCount`) and are billed at a discount on paid tiers. To get hits, keep the transcript in the system message and keep it identical between questions. Explicit `cachedContents` entries are not created by this release because they could not be verified live; on the free tier they exist only for some Gemini 3 Flash models.

## Anthropic (paid)

1. Create a key in the Claude Console (Settings, API keys) and add credits.
2. Put `ANTHROPIC_API_KEY=...` in `.env`. `ANTHROPIC_BASE_URL` points at a proxy if you use one.

Defaults: Claude Haiku 5.5 (the cheapest current model, $0.10 input and $0.50 output per million tokens) first, then Claude Sonnet 5.5 ($2 and $10) as the higher-quality rung. Both have a 1M-token context.

- System messages go to the top-level `system` field; user and assistant messages to `messages`.
- Requests use API version `2026-10-21`, which rejects `temperature`, so `ChatRequest.temperature` is not sent.
- JSON with a schema uses structured outputs (`output_config.format`), not a forced tool: Claude Sonnet 5.5 and Opus 5.5 reject forced `tool_choice` with a 400. The schema is fitted first: every object gets `additionalProperties: false`, and numeric bounds, string lengths and `maxItems` are dropped. `json: true` without a schema adds a JSON instruction, and the answer must parse or the rung fails over.
- Streaming parses `message_start`, `content_block_start`, `content_block_delta` (text becomes `delta`, thinking becomes `reasoning`), `message_delta` (stop reason, usage), `message_stop` and `error`; `ping` is ignored. On Claude 5-generation models streaming asks for summarized thinking, so the chat page can show reasoning.
- A `refusal` stop reason is an `upstream` error, so the chain tries the next rung.

### Anthropic prompt caching and what it saves

The rung marks long, stable content with `cache_control: { type: 'ephemeral' }`, and never the question:

1. the system message, when it is over the model's minimum (512 tokens on Claude 5.5 models, 1,024 to 4,096 on older ones);
2. in a multi-turn chat, the turn before the new question;
3. in a single long user message, everything before its last blank line (the question after it stays uncached).

The first call writes the cache (about 1.25x the input price for those tokens); calls within the next five minutes that share the prefix read it at about 0.1x. Example: ten questions about a 90k-token playlist on Haiku 5.5 cost about 90k x $0.10/M x 1.25 = $0.011 for the first question's transcript, then about $0.0009 each, instead of $0.009 each without caching. Results report `usage.cacheCreationInputTokens` and `usage.cacheReadInputTokens`.

### Errors

| Upstream | Code | Effect |
|---|---|---|
| 429 | `rate-limited` | waits `retry-after`, else the latest `anthropic-ratelimit-*-reset` |
| 529 overloaded, or an `overloaded_error` stream event | `upstream` | 30 s cooldown |
| 401, 403 | `auth` | 10 min cooldown, hint names the key |
| 400 "credit balance is too low" | `auth` | hint says to add credits |
| other 400 | `upstream` | the API's message is kept |
| 404 | `not-found` | the model id is retired |

## Vertex AI on Google Cloud (paid)

Both families also run on Vertex AI, billed to your project.

1. Enable the Vertex AI API on the project (`gcloud services enable aiplatform.googleapis.com`), and make sure the project's billing account is active.
2. For Claude, enable the model in Model Garden (each Claude model has its own "Enable" step and terms).
3. Give the caller the Vertex AI User role (`roles/aiplatform.user`).
4. Choose a token source:
   - `GOOGLE_ACCESS_TOKEN`: any runtime. For example `GOOGLE_ACCESS_TOKEN=$(gcloud auth print-access-token)`. Tokens last about an hour.
   - `VID2CONTEXT_GCE_METADATA=1`: Node on Compute Engine, Cloud Run or GKE. Tokens come from the metadata server and are cached until two minutes before expiry. The VM's service account needs the `cloud-platform` scope; the default Compute Engine scopes are not enough. The metadata code is loaded by dynamic import only when the runtime is Node, so Workers and browser builds never call it.
5. Set `GOOGLE_CLOUD_PROJECT`. `GOOGLE_CLOUD_LOCATION` sets the Gemini location (default `us-central1`); `VERTEX_ANTHROPIC_LOCATION` sets the Claude location (default `global`; use a region such as `us-east5` if your models are regional).

Gemini on Vertex uses `.../publishers/google/models/{model}:generateContent` and `:streamGenerateContent?alt=sse`, with the same request body as AI Studio. Claude on Vertex uses `.../publishers/anthropic/models/{model}:rawPredict` and `:streamRawPredict` with `anthropic_version` in the body instead of `model`; caching and streaming work as on the Anthropic API.

A project with a billing problem answers HTTP 403 "There are issues with your billing account"; it maps to `auth` with a billing hint, and the chain moves on.

A token minted without that scope (the metadata server on a VM created with default access scopes) answers HTTP 403 "Request had insufficient authentication scopes" with reason `ACCESS_TOKEN_SCOPE_INSUFFICIENT`, on both Gemini and Claude endpoints. It maps to `auth` with a hint to widen the VM's access scopes (stop the VM, then edit it) or to use `GOOGLE_ACCESS_TOKEN` instead. Recorded on the owner's VM on 2026-11-15.

## Verification status

| Path | Anthropic | Gemini (AI Studio) | Vertex Gemini | Vertex Claude |
|---|---|---|---|---|
| URL, headers, auth placement | recorded error | recorded error | recorded error | recorded error |
| Error mapping (bad key, billing) | recorded 401 | recorded 400 `API_KEY_INVALID` | recorded 403 | recorded 403 |
| GCE metadata token | | | recorded on the owner's VM | recorded on the owner's VM |
| Token without the cloud-platform scope | | | recorded 403 | recorded 403 |
| Non-streaming answer and usage | not verified | not verified | not verified | not verified |
| SSE stream (text, reasoning, usage) | not verified | not verified | not verified | not verified |
| JSON Schema output | not verified | not verified | not verified | not verified |
| Cache creation then cache read | not verified | not verified (implicit caching) | | not verified |
| Real 429 with rate-limit headers | not verified | not verified | not verified | not verified |

"Not verified" means the parser for that response was written from the vendors' documentation and is tested only on request building, never on a real success body. Treat these rungs as unproven until the recording below has been done.

### Recording the success fixtures

With a key in `.env` (`GEMINI_API_KEY` is free at https://aistudio.google.com/apikey; `ANTHROPIC_API_KEY` needs credits; Vertex needs `GOOGLE_CLOUD_PROJECT` with active billing plus `GOOGLE_ACCESS_TOKEN` or `VID2CONTEXT_GCE_METADATA=1`), run from the repository root:

```sh
npx tsx --env-file=.env providers/llm-native/scripts/record-fixtures.ts
LIVE=1 npx vitest run providers/llm-native/test/live.test.ts
```

The recorder runs each configured service through the provider's own rungs and writes, per service: `<service>.chat.json`, `<service>.stream.json`, `<service>.json-schema.json` (not for Vertex), and the cache pair `<service>.cache-1.json` and `<service>.cache-2.json` (two questions about the same real transcript, `tests/fixtures/contexts/youtube-cCPsdFdlshc.json`). A service that answers with an error is saved as `<name>.<status>.json` instead, never under the success name. Services without credentials are skipped and listed at the end. It keeps only an allowlist of headers and replaces keys, the project id and emails, but read every new file before committing it, add a row for it in `providers/llm-native/test/fixtures/README.md`, and add replay tests for stream parsing, JSON and usage mapping on those bodies.

## Testing and recording

```sh
npx vitest run providers/llm-native                    # replays recorded responses, no network
LIVE=1 npx vitest run providers/llm-native/test/live.test.ts   # real calls for every service with credentials
npx tsx --env-file=.env providers/llm-native/scripts/record-fixtures.ts   # record fresh fixtures
```

The live tests check an answer, a stream (deltas then one `done`), JSON against a schema, and for Anthropic that the second question about the same transcript reports cache reads.

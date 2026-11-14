# 25. LLM streaming, model catalog and model choice

| | |
|---|---|
| Track | E. LLM and embeddings |
| You own | `packages/core/src/llm/`, `packages/core/src/llm-stream.ts` (create from SHARED-CONTRACTS 1.2 if missing; you own streaming) |
| Shared edits allowed | one `export *` line per new file in `packages/core/src/index.ts`; `providers/llm-openai-compatible/src/` (attach a `stream` method to the rung factory, minimal; prompt 27 also edits this package to move local rungs out); `docs/contracts/providers.md` (a streaming section) |
| Commit scope | `llm` |
| Runs alongside | 49 other prompts in the same folder; depends only on the foundation |

vid2context turns any video into context for AI agents: transcripts, metadata, chapters and cited briefs, free-first, as a CLI, MCP server, HTTP API and web app. The owner wants a chat-style page where users pick the LLM they want from a model picker like LobeHub's (Auto first, then models grouped by provider with capability badges and context sizes), and answers that stream in as they are generated. Today every LLM rung only has a blocking `chat()`, and nothing lists models in a form a UI can show. This prompt adds the runtime-neutral streaming layer (an SSE parser, an OpenAI-compatible streaming client, a chain-aware `chatStream`), wires streaming into the foundation's OpenAI-compatible rungs, and provides `listModels` and `resolveModelChoice`, which the HTTP API (prompt 46), the chat backend (prompt 34) and the chat page (prompt 28) build on.

## Read first

1. `CLAUDE.md` and `AGENTS.md`, then `docs/ARCHITECTURE.md` (the rung chain).
2. `packages/core/src/provider.ts` (`LlmRung`, `ChatRequest`, `ChatResult`, `ChainOptions`), `packages/core/src/chain.ts` (`rankRungs`, `runChain`, cooldowns, `isRungEnabled`), `packages/core/src/pipeline.ts` (`chat`), `packages/core/src/registry.ts` (`llmRungs(env)`, `health`), `packages/core/src/errors.ts`, `packages/core/src/testing.ts`.
3. `providers/llm-openai-compatible/src/index.ts` and `client.ts` (`LANES`, `chatWith`, `buildBody`, `answerText`) and its recorded fixtures.
4. `docs/contracts/providers.md`, `docs/contracts/http-api.md`.
5. `docs/prompts/SHARED-CONTRACTS.md`, sections 1 and 1.2 (`llm-stream.ts`, verbatim), 3 (`ModelInfo`, `ChatApiRequest`, chat SSE events) and 8.

## Goal

Any LLM rung can be streamed through one function with free-first fallback before the first token, the OpenAI-compatible rungs stream natively (including reasoning deltas and usage), and `listModels(registry, env, { kind })` returns `ModelInfo[]` exactly as SHARED-CONTRACTS section 3 defines, ready for a model picker.

## Requirements

### Shared contract file

- If `packages/core/src/llm-stream.ts` does not exist, create it exactly as SHARED-CONTRACTS section 1.2 shows and follow that section's procedure (export line, typecheck, commit it on its own). It defines `ChatStreamEvent`, `StreamingLlmRung`, `canStream` and `streamFromRung`. You own it from then on: changes stay additive and must be mirrored in SHARED-CONTRACTS in the same commit.

### `packages/core/src/llm/` (runtime-neutral, no Node imports)

- `sse.ts`: `parseSSE(body: ReadableStream<Uint8Array>, signal?)` as an async iterable of `{ event?, data, id?, retry? }`. Handles multi-line `data:`, comments (`:` lines), CRLF and LF, events split across chunks, UTF-8 split across chunks (`TextDecoder` with `stream: true`), a trailing event without a blank line, and abort.
- `openai-stream.ts`: `streamOpenAiChat(endpoint: { url, key?, model, headers? }, req: ChatRequest, ctx)` sends the same body the non-streaming client builds plus `stream: true` and `stream_options: { include_usage: true }` (drop `stream_options` for services that reject it; detect a 400 that names it and retry once without), and yields `ChatStreamEvent`s: `delta` for `choices[0].delta.content`, `reasoning` for `delta.reasoning_content` or `delta.reasoning`, then one `done` with the concatenated text, model and usage from the final chunk. Ends on `[DONE]`. A mid-stream JSON error object becomes a thrown `Vid2ContextError`. Non-2xx before the stream starts goes through `errorFromResponse`.
- `stream.ts`: `chatStream(registry, req, chain, ctx)` as an async iterable of `ChatStreamEvent` plus a leading `{ type: 'meta', rung, model }` event (define this extended event type in your module, additive to the shared one) and attempts on completion. Ranks rungs with the same logic as `chat()` (add `json` to needs when asked). Falls through to the next rung on errors that happen before the first delta, applying the chain's cooldown rules (reuse `chain.ts` exports; if a needed helper is private there, do not edit `chain.ts`: reimplement the small piece locally and note it). After the first delta it never switches rungs: it ends with an error that carries the attempts.
- `models.ts`: `listModels(registry, env, { kind?: 'llm' | 'stt' | 'embed' | 'video' | 'visual' })` returning `ModelInfo[]` with every field from SHARED-CONTRACTS section 3: `label` derived from the model id without vendor prefixes, `capabilities` from the rung plus `streaming` when `canStream(rung)`, `enabled` from `isRungEnabled` plus the tier rules (keyless off when `VID2CONTEXT_KEYLESS=0`, paid off when `VID2CONTEXT_ALLOW_PAID=0`), `requires` names only. Sorted by the default policy order. Helpers `groupModels(models)` (by tier, then service) for UIs.
- `choice.ts`: `resolveModelChoice(choice?: { rung: string; strict?: boolean } | { policy })` returning `ChainOptions`: a strict rung becomes `only: [rung]`; a non-strict rung is moved to the front of the ranked list (add an optional, additive `prefer?: string[]` handled inside your `chatStream`, not by editing `chain.ts`); a policy maps to `policy`; nothing means Auto (env policy, free-first). Unknown rung ids raise `bad-request` with a hint to call `/models`.

### Streaming in the foundation's OpenAI-compatible rungs (shared edit)

- In `providers/llm-openai-compatible/src/index.ts`, where each rung object is built, add a `stream(req, ctx)` method that calls `streamOpenAiChat` with the same endpoint and key, typing the rung as `StreamingLlmRung`. Keep the edit minimal, re-read the file immediately before editing, and touch nothing else (prompt 27 is moving the local rungs out of this file at the same time; if they are already gone, do not re-add them).

## Prefer free and local

Model choice defaults to Auto, which is the free-first policy. `listModels` shows disabled rungs too (with the env var names that would enable them) so users see what a free key unlocks, but paid rungs are marked clearly by tier.

## Out of scope

- The `/models` and `/chat` HTTP routes: prompts 46 and 34. The chat UI: prompt 28.
- Native streaming for Anthropic and Gemini (prompt 26), local servers (prompt 27), browser models (prompt 19), and the extra catalog lanes (prompt 24): they implement `StreamingLlmRung` themselves using your helpers when present.
- Changing `chain.ts` or `pipeline.ts`.

## Tests

- Record real SSE streams with `LIVE=1` into `packages/core/test/fixtures/llm/` (README line per file): the OVH keyless `gpt-oss-120b` stream (has reasoning deltas), the OVH Llama stream, and the Pollinations `openai-fast` stream, each captured as the raw response body bytes and headers. Also record a real 429 response from a keyless lane if you can trigger one honestly (OVH limits about 2 per minute), otherwise reuse a real 429 body from existing foundation fixtures.
- `parseSSE`: feed the recorded bodies split at every byte boundary in a sample of positions (including inside multi-byte characters) and assert identical events.
- `streamOpenAiChat`: deltas concatenate to the `done` text, reasoning never leaks into `delta`, usage present when the service sends it.
- `chatStream`: with `replayFetch` serving a recorded 429 for the first rung and a recorded stream for the second, assert fallback, the `meta` event names the second rung, attempts include the 429 with a cooldown; a stream that errors after the first delta does not fall back.
- `listModels`: build from the real foundation registry with different envs (no keys, a Groq key, `VID2CONTEXT_KEYLESS=0`) and assert fields, ordering, `streaming` capability, and that no env value appears anywhere in the output.

## Acceptance criteria

- [ ] `npx tsc -p tsconfig.json --noEmit 2>&1 | grep -E 'packages/core/src/(llm|llm-stream)|providers/llm-openai-compatible'` prints nothing.
- [ ] `npx vitest run packages/core/test/llm providers/llm-openai-compatible` passes; `npx biome check packages/core/src/llm packages/core/src/llm-stream.ts packages/core/test/llm` is clean.
- [ ] A short `tsx` script streams a real answer from the keyless chain to the terminal token by token, and prints the `ModelInfo` list for the current env.
- [ ] The foundation's non-streaming `chat()` behavior and tests are unchanged.

## Docs

- A "Streaming" section in `docs/contracts/providers.md`: `StreamingLlmRung`, event order, fallback rule, how a provider adds streaming.
- `docs/guides/models.md`: how models are listed, what each capability badge means, Auto versus a pinned model versus strict.

## If credentials, tools or network are missing

Keyless lanes need no key. If the network is down, use the existing recorded non-streaming fixtures for the catalog tests, skip the streaming recordings, leave streaming tests that need them out, and list exactly what was not verified in your report. Never hand-write an SSE stream.

<!-- COMMON -->

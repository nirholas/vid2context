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
- `models.ts`: `listModels(registry, env, { kind?: 'llm' | 'stt' | 'embed' | 'video' | 'visual' })` returning `ModelInfo[]` with every field from SHARED-CONTRACTS section 3: `label` derived from the model id without vendor prefixes, `capabilities` from the rung plus `stream` (the capability name in docs/contracts/providers.md) when `canStream(rung)`, `enabled` from `isRungEnabled` plus the tier rules (keyless off when `VID2CONTEXT_KEYLESS=0`, paid off when `VID2CONTEXT_ALLOW_PAID=0`), `requires` names only. Sorted by the default policy order. Helpers `groupModels(models)` (by tier, then service) for UIs.
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
- `listModels`: build from the real foundation registry with different envs (no keys, a Groq key, `VID2CONTEXT_KEYLESS=0`) and assert fields, ordering, the `stream` capability, and that no env value appears anywhere in the output.

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

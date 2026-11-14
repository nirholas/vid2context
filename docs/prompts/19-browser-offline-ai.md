# 19. In-browser and offline AI: Transformers.js Whisper, WebLLM, Chrome built-in AI

| | |
|---|---|
| Track | D. Speech-to-text |
| You own | `providers/stt-transformers/` (runtimes node, browser), `providers/llm-browser/` (runtime browser) |
| Shared edits allowed | `packages/core/src/llm-stream.ts` (create from SHARED-CONTRACTS 1.2 if missing, with its export line); your own rows in `docs/providers.md` and variables in `.env.example` |
| Commit scope | `browser-ai` |
| Runs alongside | 49 other prompts in the same folder; depends only on the foundation |

vid2context turns any video into context for AI agents: transcripts, metadata, chapters and cited briefs, free-first, as a CLI, MCP server, HTTP API and web app. One deployment target is GitHub Pages in client-only mode: no server at all, where a user drops a local recording into the web page and it is transcribed and summarized on their own device, with nothing uploaded. The same models also give Node a fully offline path with no binaries to build. This prompt delivers both halves: a Transformers.js Whisper rung for Node and the browser, and local LLM rungs that run inside the browser (WebLLM and Chrome's built-in Prompt API). It merges roadmap items 19 and 28.

## Read first

1. `CLAUDE.md` and `AGENTS.md`, then `docs/ARCHITECTURE.md` (runtimes and the GitHub Pages client-only mode).
2. `packages/core/src/types.ts`, `packages/core/src/provider.ts` (`SttRung`, `LlmRung`, `ChatRequest`, `rungs(env)`, `isEnabled`), `packages/core/src/testing.ts`, and `packages/registry/src/browser.ts` (`createBrowserContext(env)`: in the browser, `Env` is user settings).
3. `docs/contracts/providers.md` (rung fields; llm capabilities include `stream`; runtimes must be honest) and `docs/providers.md`.
4. `docs/prompts/SHARED-CONTRACTS.md`, sections 1.2 (`llm-stream.ts`: `StreamingLlmRung`, `streamFromRung`), 6 (web stack, client-only mode, `v2c-settings`), 7, 8 and 9 (`.vid2context/models`).

## Goal

`stt/transformers/<model>` transcribes with timestamps on Node (onnxruntime-node) and in the browser (WebGPU, WASM fallback), fully offline after the first model download. `llm/webllm/<model>` and `llm/chrome-ai/prompt-api` give the browser streaming local chat rungs. All are tier `local`, enabled from env-style settings, and verified on real audio and in a real browser.

## Requirements

### `providers/stt-transformers` (runtimes node, browser)

- Use `@huggingface/transformers` (current major) with the automatic-speech-recognition pipeline and Whisper ONNX models from the `onnx-community` organization on Hugging Face (verify the current repo names: a base model and a `large-v3-turbo` variant, with quantized weights). `TRANSFORMERS_STT_MODEL` selects the model; default a small multilingual model for CPU or WASM and recommend the turbo model on WebGPU.
- Device: WebGPU when `navigator.gpu` exists and works, WASM otherwise, `onnxruntime-node` (CPU, or CUDA where the package supports it) in Node. `TRANSFORMERS_DEVICE` overrides.
- Long-form: chunked inference (`chunk_length_s` around 30, `stride_length_s` around 5) with `return_timestamps: true`, mapped to `Segment[]` with correct absolute times; language and task (`transcribe` or `translate`) from `SttOptions`.
- Audio input: the pipeline needs 16 kHz mono float samples. In the browser, decode with Web Audio (`OfflineAudioContext` resampling). In Node, decode with ffmpeg (`FFMPEG_PATH`, then `PATH`) to raw 16 kHz mono PCM. Do not import Node built-ins into the browser entry: split `src/node.ts` and `src/browser.ts` behind the package's conditional exports, and keep `src/index.ts` runtime-safe.
- Model cache: `.vid2context/models/transformers/` in Node (`VID2CONTEXT_HOME` respected), the browser's Cache Storage in the browser; progress callbacks surfaced through `ctx.log` and an exported `onProgress` hook the web app can use.
- Rung: tier `local`, capabilities `segments`, `language-detect`, `translate`; `isEnabled(env)` true when `TRANSFORMERS_STT_MODEL` is set (the web app sets it after feature detection; in Node the user sets it).

### `providers/llm-browser` (runtime browser)

- WebLLM (`@mlc-ai/web-llm`): rungs for a few small instruct models from WebLLM's prebuilt list (verify ids today; pick models that fit common laptop GPUs, for example 1B to 4B parameter instruct models), WebGPU required, `WEBLLM_MODEL` env selects (comma-separated list, one rung each), streaming through `StreamingLlmRung`.
- Chrome built-in AI: the Prompt API through the `LanguageModel` global (check the current API shape in Chrome's docs: `availability()`, `create()`, `prompt()`, `promptStreaming()`, download progress). One rung `llm/chrome-ai/prompt-api`, streaming, context window from the API's reported quota where available.
- Both tier `local`, capabilities include `stream` (and `json` only where you verified structured output works).
- Rungs stay env-only: the web app runs an exported `detectBrowserAi(): Promise<{ webgpu: boolean; webllm: boolean; chromePromptApi: 'available' | 'downloadable' | 'unavailable' }>` and writes env flags (`WEBLLM_MODEL`, `CHROME_AI=1`) into the browser Env; `isEnabled` reads those flags only.
- If `packages/core/src/llm-stream.ts` does not exist, create it exactly as SHARED-CONTRACTS 1.2 shows and follow that section's procedure.

### Demo pages

- `providers/stt-transformers/demo/index.html` and `providers/llm-browser/demo/index.html` (plus a script each, served by Vite in dev): pick a file or type a prompt, see progress, segments or a streamed answer. They are used for Playwright checks and manual verification, and are not part of the published package.

## Prefer free and local

Everything here is local and free by definition. These rungs only exist where they can run (feature detection); they never send audio or text anywhere.

## Out of scope

- whisper.cpp: prompt 18. Local LLM servers such as Ollama: prompt 27. Local embeddings with Transformers.js: prompt 29.
- The web app's client-only mode UI and the chat page: prompts 47 and 28. They consume your rungs and `detectBrowserAi`.
- Core streaming helpers beyond `llm-stream.ts`: prompt 25.

## Tests

- Node: a LIVE test that downloads the small Whisper model into a temp `VID2CONTEXT_HOME` and transcribes `tests/fixtures/media/apollo11-small-step.mp3`, asserting "small step" and monotonic timestamps. Record the raw pipeline output from that run into `providers/stt-transformers/test/fixtures/` and unit-test your mapping from it (chunk offsets, timestamps, language).
- Unit tests: env-only `isEnabled`, device selection logic, rung shapes, that the browser entry has no `node:` imports (scan the file).
- Browser: Playwright (install it in your package as a devDependency if missing) with Chromium against each demo page: transcribe the Apollo clip with WASM (WebGPU may not exist headless), and run the Chrome Prompt API rung only where `availability()` reports it; record what each environment supported. If Playwright cannot run here, say exactly what was verified manually.
- WebLLM: a LIVE browser test with the smallest model if the environment has WebGPU; otherwise report it as unverified.

## Acceptance criteria

- [ ] `npx tsc -p tsconfig.json --noEmit 2>&1 | grep -E 'providers/(stt-transformers|llm-browser)'` prints nothing.
- [ ] `npx vitest run providers/stt-transformers providers/llm-browser` passes; `npx biome check providers/stt-transformers providers/llm-browser` is clean.
- [ ] `npm run gen` lists `stt-transformers` in the node and browser registries and `llm-browser` in the browser registry only.
- [ ] With `TRANSFORMERS_STT_MODEL` set, `npm run cli -- tests/fixtures/media/apollo11-small-step.mp3 --mode stt` transcribes through `stt/transformers/<model>` (check `attempts`).
- [ ] The demo page transcribes the Apollo clip in headless Chromium (or the report says why not).

## Docs

- `docs/guides/offline-and-browser.md`: what runs where, model sizes and download costs, WebGPU versus WASM, the Chrome Prompt API's availability, privacy, and how the web app enables these rungs.
- Your rows in `docs/providers.md` and variables in `.env.example` (`TRANSFORMERS_STT_MODEL`, `TRANSFORMERS_DEVICE`, `WEBLLM_MODEL`, `CHROME_AI`).

## If credentials, tools or network are missing

No keys are needed. Model downloads need network: without it, test only the mapping on recorded output and report the rest. Without a browser runtime that can run Playwright, report which browser checks did not run. Never fake a model output fixture.

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

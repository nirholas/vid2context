# 27. Local LLM servers: Ollama, LM Studio, llama.cpp, vLLM, Jan, with auto-detection

| | |
|---|---|
| Track | E. LLM and embeddings |
| You own | `providers/llm-local/` |
| Shared edits allowed | `providers/llm-openai-compatible/src/` (remove only the local lanes you move; prompt 25 is attaching `stream` in the same files), `packages/core/src/llm-stream.ts` (create from SHARED-CONTRACTS 1.2 if missing, with its export line), `docs/providers.md` and `.env.example` (your rows and variables only) |
| Commit scope | `llm-local` |
| Runs alongside | 49 other prompts in the same folder; depends only on the foundation |

vid2context turns any video into context for AI agents: transcripts, metadata, chapters and cited briefs, free-first, as a CLI, MCP server, HTTP API and web app. Local models are the first tier of the free-first chain: free, private, and the only option under the `local-only` policy. The foundation ships three local lanes inside `providers/llm-openai-compatible` (Ollama, LM Studio, a generic server) through OpenAI-compatible endpoints, which has a serious trap: Ollama's context window defaults to a few thousand tokens and silently truncates long prompts, so a 30-minute transcript loses most of its content with no error. This prompt moves local LLM support into its own package with correct context sizing, adds llama.cpp, vLLM, Jan and LocalAI, and adds detection that finds local servers and their models and prints the env lines to enable them. The roadmap called this item `llm-local-detect`; the package is named `llm-local` because it holds the rungs as well as detection.

## Read first

1. `CLAUDE.md` and `AGENTS.md`, then `docs/ARCHITECTURE.md`.
2. `packages/core/src/provider.ts` (`LlmRung`, `rungs(env)`, `isEnabled`), `packages/core/src/chain.ts` (`local-only` policy), `packages/core/src/testing.ts`.
3. `providers/llm-openai-compatible/src/index.ts` and `client.ts`: the `ollama`, `lmstudio` and `local` lanes you will move, their env vars (`OLLAMA_MODEL`, `OLLAMA_BASE_URL`, `LMSTUDIO_MODEL`, `LMSTUDIO_BASE_URL`, `LOCAL_LLM_BASE_URL`, `LOCAL_LLM_MODEL`, `LOCAL_LLM_API_KEY`) and the exported `chatWith`.
4. `docs/contracts/providers.md`, `docs/providers.md`, and `docs/prompts/SHARED-CONTRACTS.md` sections 1.2, 5 (CLI setup scripts), 8 and 9.

## Goal

All local LLM rungs live in `providers/llm-local`, keep every existing env var working, size the context window correctly so long transcripts are never silently truncated, stream, and `npx tsx providers/llm-local/src/detect.ts` lists every local server and model on the machine with the exact env lines to enable them.

## Requirements

### Rungs (`@vid2context/provider-llm-local`, provider id `llm-local`)

- Runtimes `node` and `browser` (in a browser, local servers work when they allow the page origin, for example `OLLAMA_ORIGINS`; document it). Plain `fetch`. Tier `local`. Rung ids keep the foundation's form (`llm/ollama/<model>`, `llm/lmstudio/<model>`, `llm/local/<model>`) so users' configs and logs stay valid.
- Servers and env vars (`<SERVER>_BASE_URL` with the default port, `<SERVER>_MODEL` comma-separated list, rung enabled when the model var is set):
  - Ollama: native `POST /api/chat` (not the OpenAI-compatible endpoint) so `options.num_ctx` can be set. Size `num_ctx` from the request: estimated prompt tokens plus `maxTokens` plus headroom, capped by the model's context length read once from `POST /api/show` (`model_info` context length) and cached per model. If the prompt exceeds the model's maximum, throw `too-large` with a hint naming a larger-context model, instead of truncating. JSON via `format: 'json'` or a JSON Schema in `format` where the server version supports it. Streaming via the NDJSON stream. `keep_alive` from `OLLAMA_KEEP_ALIVE`. Default base `http://localhost:11434` (accept the foundation's `OLLAMA_BASE_URL` value even if it ends in `/v1`, by stripping that suffix).
  - LM Studio (`LMSTUDIO_*`, `:1234/v1`), llama.cpp server (`LLAMACPP_*`, `:8080/v1`), vLLM (`VLLM_*`, `:8000/v1`), Jan (`JAN_*`, `:1337/v1`), LocalAI (`LOCALAI_*`, `:8080/v1`), and the generic `LOCAL_LLM_BASE_URL` + `LOCAL_LLM_MODEL` (+ `LOCAL_LLM_API_KEY`): OpenAI-compatible chat (reuse `chatWith` from the foundation package), with streaming. If prompt 25's `streamOpenAiChat` exists in `packages/core/src/llm/` when you get there, use it; otherwise implement OpenAI-compatible streaming locally in your package and note it.
- Every rung implements `StreamingLlmRung` (create `packages/core/src/llm-stream.ts` exactly as SHARED-CONTRACTS 1.2 shows if missing).
- Capabilities from what the server reports where possible (`/api/show` for Ollama: tools, vision, context length); otherwise conservative defaults.

### Moving the foundation lanes (shared edit)

- After your rungs pass their tests, remove the `ollama`, `lmstudio` and `local` lane definitions from `providers/llm-openai-compatible/src/index.ts` (and any test expectations in that package that assert them, only if they now fail because the lanes moved). Re-read the file immediately before editing: prompt 25 is adding a `stream` method in the same file. Touch only those lanes. Keep that package's docstring accurate.
- Verify no rung id appears twice in the node registry after the move.

### Detection

- `detectLocalServers(ctx, { timeoutMs })`: probe the default ports above in parallel with short timeouts (and any base URLs already set in env), identify the server by its responses (`/api/tags` and `/api/version` for Ollama, `/v1/models` for the rest, server headers where present), list installed models, and for Ollama read context length and capabilities via `/api/show`.
- Also probe local speech-to-text servers (speaches and faster-whisper-server on `:8000`, whisper.cpp server on `:8080` with its `/inference` route) and local embedding models (Ollama embedding models such as `nomic-embed-text`, `bge-m3`), and report them as suggestions for the providers that use them (`LOCAL_STT_BASE_URL`, `OLLAMA_EMBED_MODEL`).
- Returns structured results plus suggested env lines, recommending a model per task (a larger instruct model for briefs, a small fast one for cleanup) with its context length.
- `src/detect.ts` CLI: `npx tsx providers/llm-local/src/detect.ts [--json]` prints a readable report (stdout) and the env block to paste into `.env`. Export `detectLocalServers` so the CLI's `doctor` (prompt 43) can call it later.

## Prefer free and local

This prompt is the local tier. Detection never sends anything off the machine. Recommend models that fit the user's hardware (report RAM and, when `nvidia-smi` exists on Node, GPU memory in the detect output).

## Out of scope

- Hosted free and keyless lanes: prompt 24 and the foundation. Streaming helpers and model catalog: prompt 25. Local speech-to-text rungs: prompts 17 (OpenAI-compatible local), 18 (whisper.cpp). Local embeddings rungs: prompt 29.

## Tests

- Install Ollama locally if it is not present and you can (official install script into the user's home, no sudo needed for the binary in many setups; skip if not possible), pull a tiny model such as `qwen2.5:0.5b`, and record real responses into `providers/llm-local/test/fixtures/` (README per file): `/api/tags`, `/api/show`, `/api/version`, a non-streaming `/api/chat`, a streaming NDJSON chat, a JSON-format chat, and an OpenAI-compatible `/v1/models` and chat stream from any second server you can run (llama.cpp server with a tiny GGUF works well).
- Unit tests with `replayFetch`: `num_ctx` sizing from a real long transcript fixture (`tests/fixtures/contexts/youtube-cCPsdFdlshc.json`), the `too-large` error when the prompt exceeds the model maximum, base URL normalization, stream parsing, env compatibility with every foundation variable, detection classification from recorded probe responses.
- LIVE tests when a local server is running.

## Acceptance criteria

- [ ] `npx tsc -p tsconfig.json --noEmit 2>&1 | grep -E 'providers/llm-local|providers/llm-openai-compatible'` prints nothing.
- [ ] `npx vitest run providers/llm-local providers/llm-openai-compatible` passes; `npx biome check providers/llm-local` is clean.
- [ ] With Ollama running, a 15-minute transcript question gets an answer that references content from the end of the transcript (proof it was not truncated), under `VID2CONTEXT_POLICY=local-only`.
- [ ] `npx tsx providers/llm-local/src/detect.ts` prints the servers and env lines on this machine.

## Docs

- `docs/guides/local-llm.md`: each server, ports, env vars, the context-window trap and how it is handled, browser use with allowed origins, detection.
- Move the local rows in `docs/providers.md` to a section for `llm-local` with the new servers; add variables to `.env.example`.

## If credentials, tools or network are missing

No keys are needed. If you cannot install or run any local server, keep the existing foundation lanes in place (do not move them), ship detection and the new rungs only if you could record real server responses, and report clearly what was not verified.

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

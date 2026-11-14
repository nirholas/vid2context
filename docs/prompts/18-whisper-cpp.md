# 18. Local speech-to-text with whisper.cpp

| | |
|---|---|
| Track | D. Speech-to-text |
| You own | `providers/stt-whisper-cpp/` (node only, tier local) |
| Shared edits allowed | Your own rows in `docs/providers.md` and variables in `.env.example` |
| Commit scope | `whisper-cpp` |
| Runs alongside | 49 other prompts in the same folder; depends only on the foundation |

vid2context turns any video into context for AI agents: transcripts, metadata, chapters and cited briefs, free-first, as a CLI, MCP server, HTTP API and web app. The default policy tries local rungs first: free, private, and no rate limits. whisper.cpp is the strongest local speech-to-text option on ordinary hardware, fast on NVIDIA GPUs and Apple Silicon and usable on CPU with small models. Whether the owner has an NVIDIA GPU is an open question from the handoff: it decides whether whisper.cpp should lead the speech-to-text chain by default or hosted free rungs should. This prompt makes whisper.cpp a first-class local rung that installs itself, picks a model for the hardware it finds, and reports that hardware so the owner can decide.

## Read first

1. `CLAUDE.md` and `AGENTS.md`, then `docs/ARCHITECTURE.md`.
2. `packages/core/src/types.ts` (`AudioInput`, `Segment`), `packages/core/src/provider.ts` (`SttRung`, `SttProvider`, `rungs(env)`, `isEnabled`), `packages/core/src/testing.ts`.
3. `providers/stt-openai-compatible/src/index.ts` (how a rung is shaped and how the local rung is enabled) and `providers/media-file/src/index.ts` (a node-only provider).
4. `docs/contracts/providers.md` (rung fields, `isEnabled` must be synchronous and env-only, `runtimes: ["node"]` for anything that spawns processes) and `docs/providers.md`.
5. `docs/prompts/SHARED-CONTRACTS.md`, sections 5 (setup scripts the CLI calls later), 7, 8 and 9 (`.vid2context/bin`, `.vid2context/models`, `locks/`).

## Goal

A node-only provider whose rung transcribes through whisper.cpp with segment timestamps, a setup script that installs or builds the binary and downloads a verified model chosen for the detected hardware, and exported GPU detection the CLI's `doctor` can use. The rung is enabled only when setup is complete, decided from env alone.

## Requirements

### Binary

- Resolution order: `WHISPER_CPP_BIN` (path to `whisper-cli`), then `PATH` (`whisper-cli`, and `whisper-server` for server mode), then a managed install in `.vid2context/bin/whisper.cpp/` (or `VID2CONTEXT_HOME`).
- Managed install: use official prebuilt binaries from the ggml-org/whisper.cpp releases where the project publishes them for the platform (verify on the releases page today), otherwise build from the latest release tag's source with CMake: CUDA when `nvcc` and an NVIDIA GPU are present (`-DGGML_CUDA=1`), Metal on Apple Silicon (default there), Vulkan when the SDK is present, CPU otherwise. Record the version, commit and build flags in a `build.json` next to the binary. Use a file lock in `.vid2context/locks/` so two processes never build at once. Fail with a clear hint when CMake or a compiler is missing.

### Models

- Download ggml models from the official Hugging Face repository (`ggerganov/whisper.cpp`): `tiny`, `base`, `small`, `medium`, `large-v3-turbo`, English-only variants where they exist, and quantized variants (`q5_0`, `q8_0`) where published. Verify each file's checksum against the value the repository publishes (check how it publishes them today), store in `.vid2context/models/whisper/`, resume partial downloads, and never leave a half-written model file behind.
- `WHISPER_CPP_MODEL` selects a model by name (`base.en`, `large-v3-turbo-q5_0`) or absolute path.
- Recommendation by hardware: NVIDIA GPU with 6 GB or more VRAM, or Apple Silicon: `large-v3-turbo`; CPU only: `base` or `small` (English-only variant when the language is English). After a transcription, report the realtime factor (audio seconds per wall second) in the attempt detail.

### GPU detection (exported)

- `detectHardware(): Promise<{ gpu: { vendor: 'nvidia' | 'apple' | 'amd' | 'intel' | 'none'; name?: string; vramMb?: number; cuda?: boolean; metal?: boolean; vulkan?: boolean }; cpuCores: number; memoryMb: number }>` using `nvidia-smi --query-gpu=name,memory.total --format=csv`, `system_profiler` or `sysctl` on macOS, `vulkaninfo --summary` when present, and `os` for CPU and memory. Prompt 43's `doctor` command will call it.

### Running

- One-shot mode: convert the input to 16 kHz mono 16-bit WAV with ffmpeg (`FFMPEG_PATH`, then `PATH`, then `~/.local/bin/ffmpeg`), run `whisper-cli -m <model> -f <wav> -oj -of <tmp>` (plus `-l <lang>` or `-l auto`, `--prompt` from `SttOptions.prompt`, thread count from the CPU), and parse the JSON output into segments (`offsets.from` and `offsets.to` in milliseconds) and the detected language.
- Server mode (optional, `WHISPER_CPP_SERVER_URL` or a managed `whisper-server` started on demand on a random local port and stopped on exit) for repeated calls without reloading the model; use its `/inference` endpoint.
- Spawn without a shell, arguments as an array, timeouts scaled to audio duration, kill on `ctx.signal` abort, cap stderr, delete temp files in `finally`. Map failures (missing model, out of memory, bad audio) to `Vid2ContextError` with hints.
- Rung: id `stt/whisper-cpp/<model>`, tier `local`, priority before other local rungs when a GPU was detected at setup time (setup writes `WHISPER_CPP_GPU=1`), capabilities `segments`, `language-detect`, `prompt`, `translate` (whisper's translate-to-English), no `maxBytes` (local files have no upload limit).
- `isEnabled(env)` is synchronous and env-only: true when `WHISPER_CPP_MODEL` is set (setup prints the exact lines to add). Do not stat files in `isEnabled`; validate paths at transcription time and fail with a hint.

### Setup script

- `npx tsx providers/stt-whisper-cpp/src/setup.ts [--model <name>] [--force-cpu] [--server]`: detects hardware, installs the binary, downloads the recommended or chosen model, runs a smoke transcription of `tests/fixtures/media/apollo11-small-step.mp3`, and prints the env lines to add to `.env` (`WHISPER_CPP_BIN`, `WHISPER_CPP_MODEL`, `WHISPER_CPP_GPU`). Export the same as a function for the CLI.

## Prefer free and local

This is the local, private rung. With it enabled and the default `free` policy, nothing leaves the machine for speech-to-text. With `VID2CONTEXT_POLICY=local-only`, it is the rung that makes speech-to-text possible at all.

## Out of scope

- Hosted speech-to-text: prompt 17. Transformers.js in Node and the browser: prompt 19.
- The long-audio orchestrator: prompt 04 (whisper.cpp needs no splitting for size, but the orchestrator may still split for parallelism).
- The CLI `doctor` and `setup` commands: prompt 43 calls your exports.

## Tests

- Record real whisper.cpp JSON output from transcribing the Apollo clip with the tiny or base model into `providers/stt-whisper-cpp/test/fixtures/` (document the whisper.cpp version and command). Unit tests parse it into segments and assert timing and text ("small step").
- Unit tests for argument building, model name resolution, hardware parsing from real recorded `nvidia-smi` or `sysctl` output (record what this VM returns; add a second sample only from a real machine), and env-only `isEnabled`.
- LIVE: run setup end to end into a temp `VID2CONTEXT_HOME` (prebuilt binary or source build, tiny model), transcribe the Apollo clip, assert the text, and check that aborting mid-run kills the process.

## Acceptance criteria

- [ ] `npx tsc -p tsconfig.json --noEmit 2>&1 | grep -E 'providers/stt-whisper-cpp'` prints nothing.
- [ ] `npx vitest run providers/stt-whisper-cpp` passes; `npx biome check providers/stt-whisper-cpp` is clean.
- [ ] `npm run gen` lists the provider in the node registry only.
- [ ] After running the setup script on this VM and adding its env lines, `npm run cli -- tests/fixtures/media/apollo11-small-step.mp3 --mode stt` transcribes through `stt/whisper-cpp/<model>` (check `attempts`).
- [ ] The report states the detected hardware on this VM and the realtime factor measured.

## Docs

- `docs/guides/whisper-cpp.md`: setup, models and sizes, hardware recommendations, server mode, troubleshooting, and the open question for the owner (an NVIDIA GPU decides whether whisper.cpp leads the default chain).
- Your rows in `docs/providers.md` and variables in `.env.example` (`WHISPER_CPP_BIN`, `WHISPER_CPP_MODEL`, `WHISPER_CPP_GPU`, `WHISPER_CPP_SERVER_URL`, `WHISPER_CPP_THREADS`).

## If credentials, tools or network are missing

No keys are needed. If neither prebuilt binaries nor a compiler are available, ship the provider with parsing and setup code tested against recorded output, and report that the live build could not run. If Hugging Face is unreachable, the model download cannot be verified: report it, never commit a model file.

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

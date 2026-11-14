# 43. The full CLI

| | |
|---|---|
| Track | H. Surfaces |
| You own | `packages/cli/` |
| Shared edits allowed | None |
| Commit scope | `cli` |
| Runs alongside | 49 other prompts in the same folder; depends only on the foundation |

vid2context turns any video into context for AI agents: transcripts, metadata, chapters and cited briefs, free-first, as a CLI, MCP server, HTTP API and web app. The CLI is the first thing a developer tries (`npx vid2context <url>`) and the tool agents shell out to when MCP is not set up. Today it is minimal: one input, `--format`, `--timestamps`, `--mode`, `--lang`. This prompt turns it into a complete, scriptable command: subcommands for lists, bundles, packs, the library, collections, models and an environment `doctor`, with JSON output everywhere, clean stdout, documented exit codes and shell completions.

## Read first

1. `CLAUDE.md` and `AGENTS.md` (operating rules and commands), then `docs/ARCHITECTURE.md`.
2. `packages/core/src/types.ts`, `packages/core/src/provider.ts`, `packages/core/src/pipeline.ts`, `packages/core/src/registry.ts`, `packages/core/src/storage.ts` and `packages/core/src/testing.ts`.
3. `packages/cli/src/main.ts`, `packages/cli/src/bin.ts` and `packages/cli/test/cli.test.ts` (keep the `Io` and `RunDeps` injection pattern).
4. `packages/registry/src/node.ts` (`createRegistry`, `createNodeContext`, `loadEnvFiles`).
5. `docs/providers.md` and `.env.example` (rung and env var names for `models` and `doctor`).
6. `docs/prompts/SHARED-CONTRACTS.md`, sections 2 (formatter ids), 5 (CLI commands) and 8.

## Goal

`vid2context` has the subcommands and global flags in SHARED-CONTRACTS section 5, each with `--help` and `--json`, writes only program output to stdout, maps every error code to a documented exit code, ships bash, zsh and fish completions, and picks up features from parallel prompts (SQLite storage, bundle, library, server) automatically or by checking for them before finishing.

## Requirements

### Commands

- `get <input>` (also the default when the first argument is not a command): today's behaviour plus `--comments [n]`, `--refresh`, `--out <file>` (write instead of stdout, refusing to overwrite without `--force`).
- `list <input> [--limit n]`: expand a playlist, channel, feed or page with `expandInput`; one ref per line, or JSON.
- `formats`: from the `formatters` map at runtime, never a hard-coded list.
- `pack <inputs...> [--max-tokens n]`: the `pack` formatter via `renderMany` when prompt 01 has landed it; otherwise the `text` formatter per input with a header, and report it.
- `bundle <inputs...> -o file.zip`: only if `buildBundle` is exported from `@vid2context/core` (prompt 15) when you finish; otherwise leave the command out and report it.
- `search <query> [--collection id] [--limit n]`: `Storage.search` on `registry.openStorage(ctx)`, printing title, `[m:ss]`, text and timestamp URL.
- `library ls | show <id> | rm <id>`: over the same storage. Note in help text that without a persistent backend the library lives only for the process.
- `collection create | add | ls | show | rm`: over the `Storage` collection methods. `collection refresh` only if `@vid2context/library` (prompt 41) exists when you finish.
- `models [--kind llm|stt|embed|video|visual]`: every rung from `registry.health(env)` grouped by tier (local, free, keyless, paid) with enabled state and the env var names a disabled rung needs. Never print values.
- `doctor`: Node version (22 or newer), ffmpeg and ffprobe (`FFMPEG_PATH`, PATH, `~/.local/bin`), yt-dlp and deno, NVIDIA GPU via `nvidia-smi`, data directory writable (`.vid2context/` or `VID2CONTEXT_HOME`), which keys are set (names only), keyless reachability (one cheap request to the OVH models list), and a real YouTube captions probe on `jNQXAC9IVRw` that detects an IP block and prints the hint. Each check: ok, warn or fail, with a fix line. `--json` for machines.
- `config`: the resolved env-driven settings (`VID2CONTEXT_POLICY`, `VID2CONTEXT_ALLOW_PAID`, `VID2CONTEXT_SKIP`, `VID2CONTEXT_KEYLESS`, storage backend), secrets masked. If `@vid2context/config` (prompt 05) exists when you finish, use its `explain()` output and `--profile`.
- `serve [--port n] [--host h]`: start the HTTP API from `@vid2context/server` (exists today).
- `mcp`: start the stdio MCP server from `@vid2context/mcp`.

### Global flags and behaviour

- `--format`, `--timestamps`, `--mode`, `--lang`, `--policy`, `--only`, `--skip`, `--allow-paid`, `--json`, `--quiet`, `--verbose`, `--out`, passed into `ChainOptions` and `GetContextOptions`.
- Parse with `node:util` `parseArgs`; no CLI framework. Unknown flags fail with a hint naming the closest valid flag.
- stdout carries only program output. Progress, spinners, errors, hints and attempts go to stderr. Spinners only when stderr is a TTY and not `--quiet`.
- Exit codes: a table in one module mapping each `ErrorCode` (and usage errors) to a stable number; document it.
- Errors print the message, the hint and, with `--verbose` or `--json`, the attempts list.
- Load `.env` with `loadEnvFiles()` at startup (shell variables win).
- Completions: `vid2context completion bash|zsh|fish` prints a script generated from the same command table that drives `--help`.

## Out of scope

- MCP tools: prompt 44 (MCP tools). HTTP routes: prompt 46 (HTTP API).
- Building the bundle, pack and storage backends themselves: prompts 15 (bundle), 01 (output formats), 37 (SQLite), 41 (library).
- Setup flows for whisper.cpp, local LLMs and yt-dlp: prompts 18, 27 and 11 export functions; wire them into `doctor` only if they exist when you finish.
- Distributable bundles for `npx`: prompt 38 (local CI and release).

## Tests

- Command functions tested with injected `Io` and a `testContext` whose `replayFetch` serves the recorded fixtures in `providers/youtube/test/fixtures/` and `providers/stt-openai-compatible/test/fixtures/`: `get` in every format, `list` on a recorded playlist (record your own into `packages/cli/test/fixtures/` with `LIVE=1`), `formats`, `models` (assert no env values appear in output when keys are set in the test env), `search` and `library` over `MemoryStorage`, `config` masking.
- Exit code table: every `ErrorCode` maps to a distinct, documented code.
- `doctor` checks split into pure functions tested on real command outputs you capture once (for example a real `nvidia-smi` or `ffmpeg -version` output saved as a fixture).
- `LIVE=1` subprocess tests: run `npx tsx packages/cli/src/bin.ts` against real YouTube for `get`, `list` and `doctor`, asserting stdout and stderr separation.
- Completions: each generated script passes `bash -n` (and `zsh -n` when zsh exists).

## Acceptance criteria

- [ ] `npx tsc -p tsconfig.json --noEmit 2>&1 | grep packages/cli` prints nothing.
- [ ] `npx vitest run packages/cli` passes.
- [ ] `npx biome check packages/cli` is clean.
- [ ] `npm run cli -- https://www.youtube.com/watch?v=jNQXAC9IVRw > out.txt` leaves `out.txt` with only the transcript.
- [ ] `npm run cli -- doctor` runs on this machine and reports every check.
- [ ] `npm run cli -- --help` and each `<command> --help` are accurate.

## Docs

- `docs/cli.md`: every command and flag with a real output sample captured from the running CLI, the exit code table, and completion setup.

## If credentials, tools or network are missing

Nothing here needs a key. Without network, run the replayed tests, skip the LIVE subprocess tests with a clear message, and say in your report which `doctor` checks were exercised only against captured outputs.

<!-- COMMON -->

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

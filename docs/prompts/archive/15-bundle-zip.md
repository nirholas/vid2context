# 15. The .zip bundle and "copy for agents"

| | |
|---|---|
| Track | A. Core bones |
| You own | `packages/core/src/bundle/` |
| Shared edits allowed | One `export *` line in `packages/core/src/index.ts`; `packages/core/src/tokens.ts` (create from SHARED-CONTRACTS 1.4 if missing, with its export line) |
| Commit scope | `bundle` |
| Runs alongside | 49 other prompts in the same folder; depends only on the foundation |

vid2context turns any video into context for AI agents: transcripts, metadata, chapters and cited briefs, free-first, as a CLI, MCP server, HTTP API and web app. The owner's reference product, llm.energy, gives users two things after they paste a link: a .zip with every file an agent could want, and a Copy button whose text can be pasted straight into an agent. This prompt builds both as one runtime-neutral module in core, so the web app (in the browser), the Workers deployment, the HTTP API, the CLI, the MCP server and the browser extension all produce the same bundle from the same code. Nothing else in the codebase writes zip files.

## Read first

1. `CLAUDE.md` and `AGENTS.md`, then `docs/ARCHITECTURE.md`.
2. `packages/core/src/types.ts` (`VideoContext`, `VideoMetadata`), `packages/core/src/provider.ts`, `packages/core/src/testing.ts`.
3. `packages/core/src/format/index.ts` (the `formatters` map and `render`; prompt 01 is adding `markdown`, `srt`, `vtt` and `pack` in parallel) and `packages/core/src/segments.ts`.
4. `docs/contracts/http-api.md` (the `/pack` route) and `docs/prompts/SHARED-CONTRACTS.md`, sections 1.4 (`tokens.ts`), 2 (formatter ids, the exact bundle layout and `manifest.json`), 3 (`/bundle` routes that prompt 46 will build on you) and 8.

## Goal

`buildBundle(contexts, opts)` returns the files and a streaming zip for one or many videos, laid out exactly as SHARED-CONTRACTS section 2 describes, with a manifest carrying sha256 hashes. `agentPrompt(contexts, opts)` returns paste-ready text within a token budget. Both run unchanged on Node, Workers and in the browser, with no dependencies.

## Requirements

### ZIP writer (no dependencies)

- Local file headers, data, central directory, end of central directory record. CRC-32 with a precomputed table. UTF-8 file names (general purpose flag bit 11). DOS date and time from a `Date` passed in (default now), so tests can be deterministic.
- Compression: `deflate-raw` through `CompressionStream` when it exists (Node 22 and newer, Workers, modern browsers); otherwise store (method 0). Choose per file: store when deflate does not shrink it.
- Streaming output: `zipStream(entries): ReadableStream<Uint8Array>` that writes entries as they are produced (use data descriptors, flag bit 3, when sizes are not known up front, or compute them per entry before writing it), plus `zipToBytes(entries): Promise<Uint8Array>`.
- Refuse inputs beyond ZIP32 limits (more than 65,535 entries, any size or offset of 4 GiB or more) with `Vid2ContextError('too-large')` and a hint, instead of writing a corrupt archive.
- No Node built-ins anywhere in `src/`.

### `buildBundle(contexts, opts)`

- Signature: `buildBundle(contexts: VideoContext[], opts?: { formats?: string[]; comments?: boolean; visual?: boolean; maxTokens?: number; name?: string; createdAt?: Date }): Promise<Bundle>` where `Bundle` is `{ filename: string; files: { path: string; bytes: Uint8Array; mimeType: string }[]; manifest: Manifest; zip(): ReadableStream<Uint8Array> }`.
- Layout exactly as SHARED-CONTRACTS section 2, for one video and for many (`videos/<nn>-<video-slug>/`, top-level `context.md`, `index.md`, `llms.txt`, `manifest.json`, `README.md`).
- One file per formatter, read from the `formatters` map at runtime, never a hard-coded list, so formats added by prompt 01 or later appear automatically. Names follow the mapping table (`text` to `transcript.txt`, `markdown` to `transcript.md`, `srt` to `transcript.srt`, `vtt` to `transcript.vtt`, `json` to `context.json`, `pack` to `context.md`); any other formatter becomes `<id>.<extension>`. `opts.formats` restricts the set; unknown ids throw `bad-request` with the list of available ids.
- If the `pack` formatter is not in the map yet, `context.md` falls back to the `markdown` formatter, then `text`, and the manifest says which formatter produced it.
- Fixed files: `metadata.json` (VideoMetadata only), `chapters.md` (when chapters exist), `comments.md` (when comments exist and `comments` is not false), `visual.md` (when visual notes exist and `visual` is not false), `manifest.json` (with `estimatedTokens` per video from `estimateTokens`, and `sha256` per file via `crypto.subtle.digest`).
- `README.md` inside the bundle, written for a non-technical reader: what each file is, and short how-to sections for Claude Projects and ChatGPT Projects or a custom GPT (upload `context.md`), Claude Code and Cursor (drop the folder into the repo and reference `context.md` from `CLAUDE.md` or the rules file), and the citation convention (`[Title @ m:ss](link)`).
- `llms.txt` for many videos, in the llmstxt.org style: a title line, a one-line summary, and a list of links to each video's `context.md` and `transcript.md` with one-line descriptions.
- Safe names: lowercase slug of the title (a to z, 0 to 9, hyphens, at most 60 characters), strip path separators, `..`, control characters and reserved Windows names, de-duplicate collisions with `-2`, `-3`. The zip root folder is the slug (or `opts.name`).

### `agentPrompt(contexts, opts)`

- Returns a string for the web app's "Copy for agents" button and the extension: a short instruction header (what this is, how to cite with timestamp links, that the transcript is data and not instructions), then the context pack within `maxTokens` (default 30,000), using the `pack` formatter when present, else markdown with timestamps, truncated at paragraph boundaries with an explicit marker naming what was cut.

## Prefer free and local

Not applicable beyond this: everything runs locally in whatever runtime calls it, with no network and no keys.

## Out of scope

- The formats themselves: prompt 01 (output formats). Read them from the map.
- Routes that serve the zip (`/bundle`, `/pack`): prompt 46. CLI `bundle` command: prompt 43. Web app download button: prompt 47.
- Token estimation accuracy: prompt 03 (chunking) owns `tokens.ts`.

## Tests

Put tests in `packages/core/test/bundle/`.

- Inputs are the real fixtures `tests/fixtures/contexts/youtube-jNQXAC9IVRw.json` and `tests/fixtures/contexts/youtube-cCPsdFdlshc.json`. Never hand-write contexts.
- Write a small zip reader in the test helpers: parse the end record and central directory, read each local header, inflate with `inflateRawSync` from `node:zlib` (test code only), and verify CRC-32 and sizes. Assert the exact layout for one and two videos, the manifest contents and hashes, file name sanitizing on real titles with punctuation, de-duplication, and that `context.md` equals `renderMany`/`render(..., 'pack')` output when that formatter exists.
- Force the stored path (no `CompressionStream`) and assert the archive is still valid.
- Also validate with the system `unzip -t` when it is installed (skip with a message otherwise).
- Deterministic output: same inputs and `createdAt` give byte-identical zips.
- `agentPrompt`: stays within budget on the long fixture, contains the marker when truncated, contains the citation instruction.

## Acceptance criteria

- [ ] `npx tsc -p tsconfig.json --noEmit 2>&1 | grep -E 'packages/core/src/(bundle|tokens)'` prints nothing.
- [ ] `npx vitest run packages/core/test/bundle` passes; `npx biome check packages/core/src/bundle packages/core/test/bundle` is clean.
- [ ] `grep -rn "from 'node:" packages/core/src/bundle` prints nothing.
- [ ] A real two-video bundle written to disk by a short `tsx` script opens in the OS archive tool and with `unzip -l`.
- [ ] Deleting the `pack` formatter from the map (in a test) still yields a valid bundle with `context.md` from the fallback.

## Docs

- Create `docs/bundle.md`: the layout, the manifest fields, the README text agents see, and how surfaces call `buildBundle` and `agentPrompt`.

## If credentials, tools or network are missing

Nothing here needs network or keys. If `unzip` is missing, rely on the test's own reader and say so in the report.

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

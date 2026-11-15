# 03. Token estimates, chunking and sections

| | |
|---|---|
| Track | A. Core bones |
| You own | `packages/core/src/chunk/`, and the implementation of `packages/core/src/tokens.ts` (create it from SHARED-CONTRACTS 1.4 if missing; improve accuracy, never change the signature) |
| Shared edits allowed | one `export *` line each in `packages/core/src/index.ts` for `chunk/index.ts` and (if you create it) `tokens.ts` |
| Commit scope | `chunk` |
| Runs alongside | 49 other prompts in the same folder; depends only on the foundation |

vid2context turns any video into context for AI agents: transcripts, metadata, chapters and cited briefs, free-first, as a CLI, MCP server, HTTP API and web app. Speech is about 12k tokens per hour, so the owner's motivating example (a 15-episode G-Wagon buyer series of 30-minute videos) is about 90k tokens: too much to paste whole into most agents. Agents need an outline first (chapters with token counts), then the sections they care about. This prompt builds the runtime-neutral pieces every surface uses for that: token estimates, chapter-aware chunking, outlines, time-range and chapter sections, and a budget planner. The MCP tools `get_outline` and `get_section` and the HTTP routes `/outline` and `/section` in `docs/contracts/` are built on these by prompts 44 and 46.

## Read first

1. `CLAUDE.md` and `AGENTS.md`, then `docs/ARCHITECTURE.md`.
2. `packages/core/src/types.ts` (`Segment`, `Chapter`, `VideoContext`), `packages/core/src/provider.ts`, `packages/core/src/testing.ts`.
3. `packages/core/src/segments.ts` (`sliceSegments`, `segmentsToText`, `formatTimestamp`, `timestampUrl`).
4. `docs/contracts/http-api.md` (`GET /outline`, `GET /section`: the response shapes you must make easy) and `docs/contracts/mcp-tools.md` (`get_outline`, `get_section`).
5. `docs/prompts/SHARED-CONTRACTS.md`, sections 1.4 (`tokens.ts`), 7 (fixtures) and 8.
6. `tests/fixtures/README.md`: both real contexts (`youtube-jNQXAC9IVRw.json` with 3 description chapters, `youtube-cCPsdFdlshc.json`, 18 minutes, 521 segments, no chapters).

## Goal

A set of pure, runtime-neutral functions that let any surface say "this video has these sections and costs this many tokens", fetch exactly one section, and plan which videos and sections fit a given budget, with token estimates whose error against real tokenizers is measured and documented.

## Requirements

### `tokens.ts`

- If `packages/core/src/tokens.ts` does not exist, create it exactly as SHARED-CONTRACTS section 1.4 shows and follow that section's procedure (commit it on its own right away).
- You own its accuracy. Measure `estimateTokens` against real tokenizers on the real fixtures (English transcript text, plus a CJK sample you record from a real captioned video, documented): use `gpt-tokenizer` or `js-tiktoken` (o200k or cl100k) and a Llama-family tokenizer as test-only devDependencies of `packages/core` if the shared rules allow; otherwise vendor nothing and measure in a one-off script under `packages/core/test/chunk/` that you run and record results from. Improve the heuristic if the error is above about 15 percent (for example, count digits, punctuation and whitespace runs separately) while keeping runtime code dependency-free and the signature `estimateTokens(text: string): number`.
- Document the measured error per script in `docs/chunking.md`.

### Chunking

- `chunkTranscript(context, opts)` with `opts = { maxTokens: number, overlapTokens?: number, by?: 'chapters' | 'time' | 'tokens', targetSec?: number }` returns `TranscriptChunk[]`: `{ index, startSec, endSec, text, tokens, chapterIndex?, chapterTitle?, segmentRange: [first, last] }`.
- Default `by`: `chapters` when the context has chapters, else `tokens`. A chapter larger than `maxTokens` is split further; small adjacent pieces are never merged across chapter boundaries.
- Cut only on sentence ends (punctuation) or pauses (gap of 1 s or more); fall back to segment boundaries for unpunctuated text; never split a segment.
- Overlap repeats whole segments from the end of the previous chunk, up to `overlapTokens`.
- Invariants (tested): chunks cover every segment, in order; start and end times are monotonic; every chunk except an unavoidable single oversized segment is within `maxTokens`.

### Outline and sections

- `outline(context)`: `{ title, durationSec, totalTokens, sections: { index, title, startSec, endSec, tokens, source: 'chapters' | 'time' }[] }`. Videos without chapters get synthetic time sections (about 5 minutes, cut on pauses) titled by time range ("12:00 to 17:03"). This must match what `GET /outline` returns in `docs/contracts/http-api.md` (`chapters: (Chapter & { tokens })[]`, `totalTokens`): provide a small adapter `outlineForApi(context)` with exactly that shape.
- `getSection(context, sel)` with `sel = { fromSec?, toSec?, chapter?: number | string }`: returns a `VideoContext` whose transcript holds only the overlapping segments, whose `metadata.chapters` is trimmed to the range, and whose `metadata.extra.section = { fromSec, toSec, chapterTitle? }`, so every formatter renders it unchanged. `chapter` as a string matches titles case-insensitively (exact first, then prefix, then substring); no match throws `Vid2ContextError('bad-request')` with a hint listing the chapter titles.
- `parseTimeArg(value)`: accepts seconds (`754`), `m:ss`, `h:mm:ss`, as `docs/contracts/http-api.md` allows for `from` and `to`; invalid input throws `bad-request`.

### Budget planner

- `fitToBudget(contexts, maxTokens, opts?)` returns a plan `{ items: { videoId, whole: boolean, sections?: { startSec, endSec, tokens }[] }[], totalTokens, omitted: { videoId, startSec, endSec, tokens }[] }`. Strategy: include whole videos while they fit; then share the remaining budget across the rest in proportion to their length, taking leading sections first; list everything omitted so callers can tell the reader what is missing.

### Exports

- Export everything from `packages/core/src/chunk/index.ts` and add the `export *` line to `packages/core/src/index.ts` (re-read first). Use specific names to avoid collisions with other prompts (`chunkTranscript`, `outline` may collide: prefer `transcriptOutline` and keep `outline` only if free).

## Prefer free and local

Everything here is local, pure computation. No network, no keys.

## Out of scope

- Formatters and the context pack (prompt 01); they will call `fitToBudget` later.
- Search indexing windows (prompt 40) and RAG retrieval (prompt 34): they may reuse your chunker but own their own logic.
- MCP tools and HTTP routes (prompts 44 and 46).

## Tests

Put tests in `packages/core/test/chunk/`.

- Both real contexts from `tests/fixtures/contexts/`: chapter mode on `jNQXAC9IVRw` (3 chapters), token mode on `cCPsdFdlshc` at budgets 200, 1000 and 4000.
- Invariant checks over every chunk produced from the real data (coverage, order, budget, overlap correctness).
- `getSection` by time range, by chapter index and by chapter title, then `render(section, 'text')` from core to prove formatters accept it.
- `parseTimeArg` with real-world inputs (`"1:02:03"`, `"75"`, `"12:5"` rejected).
- `fitToBudget` with both contexts at several budgets: total never exceeds the budget; omitted ranges plus included ranges cover each video exactly.
- Token accuracy: the measurement script output committed as a small JSON report, and a test asserting the error stays under the documented bound for the English fixture.

## Acceptance criteria

- [ ] `npx tsc -p tsconfig.json --noEmit 2>&1 | grep -E 'packages/core/src/(chunk|tokens)'` prints nothing.
- [ ] `npx vitest run packages/core/test/chunk` passes.
- [ ] `npx biome check packages/core/src/chunk packages/core/src/tokens.ts packages/core/test/chunk` is clean.
- [ ] `outlineForApi` on the real `cCPsdFdlshc` context returns sections whose token counts sum to `totalTokens` (within rounding).
- [ ] A short `tsx` script printing the outline of a live YouTube video (fetched with the foundation CLI or `getVideoContext`) works; paste its output in your report.

## Docs

- Create `docs/chunking.md`: token estimate accuracy table, chunking rules, outline and section semantics, budget planner behaviour, with a real outline example from the fixture.

## If credentials, tools or network are missing

Nothing here needs a key. If you cannot install a reference tokenizer, measure with whatever real tokenizer is already available on the machine (for example through a local model server) or report the accuracy as unmeasured and keep the shared heuristic unchanged.

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

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

<!-- COMMON -->

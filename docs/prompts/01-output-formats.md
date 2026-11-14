# 01. Output formats: Markdown, SRT, WebVTT and the context pack

| | |
|---|---|
| Track | A. Core bones |
| You own | `packages/core/src/format/` |
| Shared edits allowed | `packages/core/src/tokens.ts` (create from SHARED-CONTRACTS 1.4 if missing) and one `export *` line in `packages/core/src/index.ts` for it |
| Commit scope | `format` |
| Runs alongside | 49 other prompts in the same folder; depends only on the foundation |

vid2context turns any video into context for AI agents: transcripts, metadata, chapters and cited briefs, free-first, as a CLI, MCP server, HTTP API and web app. Every surface renders output through one map, `formatters` in `packages/core/src/format/index.ts`, so a formatter added here appears in the CLI's `--format`, the MCP tools, the HTTP API, the web app and the .zip bundle without anyone else touching code. Today only `text` and `json` exist. This prompt adds the formats people actually paste into agents and players: Markdown with timestamp links, SRT, WebVTT, and the context pack, the single Markdown file the owner uploads to ChatGPT Projects or Claude Projects as the zero-setup way to use vid2context.

## Read first

1. `CLAUDE.md` (operating rules and commands), then `docs/ARCHITECTURE.md`.
2. `packages/core/src/types.ts` and `packages/core/src/provider.ts` (the contracts), and `packages/core/src/testing.ts` (replayFetch, testContext).
3. `packages/core/src/format/index.ts` (the `Formatter` interface, `formatters`, `render`) and `packages/core/src/segments.ts` (`formatTimestamp`, `timestampUrl`, `segmentsToText`, `sliceSegments`, `decodeEntities`).
4. `docs/prompts/SHARED-CONTRACTS.md`, sections 1.4 (`tokens.ts`), 2 (formatter ids and bundle file names) and 7 (shared fixtures), and section 8 for shared files.

## Goal

`render(context, id, opts)` produces correct, agent-friendly output for the ids `markdown`, `srt`, `vtt` and `pack`, and `renderMany(contexts, id, opts)` produces one document from several videos for the formats that support it. The output is tested on real transcripts, and SRT and VTT parse back to the same timings.

## Requirements

### Interface changes (additive only)

- Keep `Formatter`, `formatters` and `render` working exactly as today for `text` and `json`.
- Add optional `renderMany?(contexts: VideoContext[], opts: FormatOptions): string` to `Formatter`, and an exported `renderMany(contexts, format, opts)` helper. Formats without `renderMany` throw `Vid2ContextError('bad-request')` with a hint listing the formats that accept several videos.
- Add optional fields to `FormatOptions`: `maxTokens?: number`, `includeComments?: boolean`, `includeVisual?: boolean`, `linkTimestamps?: boolean` (default true). Existing callers must compile unchanged.
- Put each formatter in its own file (`markdown.ts`, `srt.ts`, `vtt.ts`, `pack.ts`, plus shared helpers such as `paragraphs.ts`) and register them in `index.ts` under the ids in SHARED-CONTRACTS section 2. Never rename `text` or `json`.

### `markdown`

- Title block: `# Title`, then a compact metadata list: channel (linked when `channel.url` exists), published date, duration, source URL, language, transcript origin and producer (for example "auto-captions from youtube-captions", "speech-to-text by stt/groq/whisper-large-v3-turbo"), and "machine-translated" when `transcript.translated` is true.
- Description excerpt, bounded (first 600 characters, cut on a word boundary, with a note that it was shortened).
- Chapters as `##` headings at their start times. Videos without chapters get no synthetic headings.
- Paragraphs grouped from segments on sentence ends and pauses (a gap of 1.5 s or more), targeting 30 to 90 seconds or about 120 words, never splitting a segment. Each paragraph starts with `[m:ss](timestampUrl(ref, startSec))`, or plain `[m:ss]` when `timestampUrl` returns undefined or `linkTimestamps` is false.
- Speaker turns: when segments carry `speaker`, start a new paragraph on every speaker change and prefix it with `**Speaker:**`.
- Optional `## Comments` (author, likes, creator and pinned flags, replies indented) and `## On screen` (visual notes with timestamps) sections when the data exists and the matching option is set.
- Use `h:mm:ss` for every timestamp in a document when the video is an hour or longer, so columns stay consistent.

### `srt` and `vtt`

- Cue timing: SRT `HH:MM:SS,mmm --> HH:MM:SS,mmm` with sequential numbering from 1; VTT `HH:MM:SS.mmm --> HH:MM:SS.mmm`.
- At most 2 lines of at most 42 characters per cue. Split long segments into several cues, distributing time in proportion to text length, breaking on word boundaries.
- Never emit overlapping or zero-length cues: clamp each cue's end to the next cue's start, and give a minimum duration of 0.5 s when the source gives less (borrowing from the gap when possible).
- VTT: `WEBVTT` header, a `NOTE` block naming the source URL, transcript origin and producer, escape `&`, `<`, `>` in cue text, and use voice tags `<v Speaker>` when segments carry `speaker`. SRT: strip characters that break players (control characters), keep plain text.
- Decode HTML entities that survived in caption text (`decodeEntities`).

### `pack` (the context pack)

- One Markdown document for one or many contexts, written for the model that will read it. It starts with a short header: what the document is, how many videos, total duration, and the citation rule: "Cite as [Title @ m:ss](link)". Then a table of contents (with anchors) when there are two or more videos.
- Per video: title, channel, date, duration, URL, origin, chapters list with timestamp links, then the transcript as timestamped paragraphs (same grouping as `markdown`).
- Budget: `maxTokens` measured with `estimateTokens` from `packages/core/src/tokens.ts`. If the file does not exist, create it exactly as SHARED-CONTRACTS section 1.4 shows and follow that section's procedure.
- When over budget, degrade in this order and stop as soon as it fits: drop comments; drop visual notes; reduce timestamp density (one link per 2 to 3 paragraphs); shorten descriptions; then truncate each video's transcript in proportion to its length, cutting at paragraph boundaries. Every truncation leaves an explicit marker naming the cut time range and how to get it ("The rest, 12:40 to 31:05, is omitted for length. Fetch it with the get_section tool or the full transcript."). Never drop content silently, and never exceed the budget.
- `render(context, 'pack')` is the one-video case of `renderMany`.

## Out of scope

- The .zip bundle and "copy for agents" text: prompt 15 (bundle). It reads your formatters from the map.
- Caption cleanup (punctuation, rolling dedupe, Whisper loops): prompt 02. Render the segments you are given.
- Chunking, outlines and section fetch: prompt 03. Keep your paragraph grouping local to the format module.
- Surfaces (CLI flags, MCP tools, HTTP routes): prompts 43, 44, 46. They list `formatters` at runtime.

## Tests

Put tests in `packages/core/test/format/`.

- Inputs are real `VideoContext` fixtures: `tests/fixtures/contexts/youtube-jNQXAC9IVRw.json` (short, creator captions, en) and `tests/fixtures/contexts/youtube-cCPsdFdlshc.json` (longer, auto-captions). If they are missing when you start, produce them with the foundation CLI as SHARED-CONTRACTS section 7 describes and keep your copies in `packages/core/test/fixtures/contexts/` with a README line saying where and when they were recorded. Do not hand-write contexts.
- Snapshot each format for both fixtures with `toMatchFileSnapshot` into `packages/core/test/format/__snapshots__/`, and read the snapshots yourself once: they must look right to a human.
- Write a strict SRT parser and a strict WebVTT cue parser in the test helpers. Assert: the output parses, cue numbers are sequential, no cue overlaps the next, no cue is shorter than 0.5 s unless the source was, no line exceeds 42 characters, no cue has more than 2 lines, and every source word appears in order in the cue text.
- `pack` budget: for the long fixture, render with `maxTokens` of 1000, 4000 and unlimited. Assert `estimateTokens(output) <= maxTokens`, the truncation marker is present exactly when content was cut, and the marker's time range matches what was cut.
- `renderMany` with both fixtures: table of contents present, anchors resolve, per-video headers in input order.
- Edge cases from real data: a transcript whose last segment ends after `durationSec`, segments with entities like `&amp;#39;`, a context with no chapters and no channel URL.

## Acceptance criteria

- [ ] `npx tsc -p tsconfig.json --noEmit 2>&1 | grep -E 'packages/core/src/(format|tokens)'` prints nothing.
- [ ] `npx vitest run packages/core/test/format` passes.
- [ ] `npx biome check packages/core/src/format packages/core/test/format` is clean.
- [ ] `render(ctx, 'text')` and `render(ctx, 'json')` output is byte-identical to before your change (assert it in a test against the fixtures).
- [ ] `npm run cli -- https://www.youtube.com/watch?v=jNQXAC9IVRw --format markdown` (and `srt`, `vtt`, `pack`) prints correct output for the real video, if the foundation CLI passes `--format` through to `render`. If it does not yet, call `render` from a short `tsx` script instead and say so in your report.
- [ ] A VTT file you generated plays with captions in a real browser `<video><track>` (check with Playwright if it is installed, otherwise open it manually and state how you checked).

## Docs

- Create `docs/formats.md`: one section per format with what it is for, the options it honours, and a short real sample taken from the jNQXAC9IVRw fixture output (a few lines, not the whole file).
- If `docs/contracts/` describes `Formatter` or `FormatOptions`, add the new optional fields there in the same commit.

## If credentials, tools or network are missing

Nothing here needs a key. If the shared fixtures are missing and the network is down, use the real YouTube fixtures in `providers/youtube/test/fixtures/` through the YouTube provider's exported parsers to build contexts in the test, and report that the end-to-end CLI check was not run.

<!-- COMMON -->

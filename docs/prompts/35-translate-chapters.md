# 35. Translation and auto-chapters

| | |
|---|---|
| Track | F. Intelligence |
| You own | `packages/translate/`, `packages/chapters/` |
| Shared edits allowed | `packages/core/src/tokens.ts` (create from SHARED-CONTRACTS 1.4 if missing) and its `export *` line in `packages/core/src/index.ts`; the translation and `/chapters` rows in `docs/contracts/http-api.md` |
| Commit scope | `translate` or `chapters` |
| Runs alongside | 49 other prompts in the same folder; depends only on the foundation |

vid2context turns any video into context for AI agents: transcripts, metadata, chapters and cited briefs, free-first, as a CLI, MCP server, HTTP API and web app. Two enrichments make long or foreign-language videos usable by agents: translation (a German review read as English) and chapters (a 40-minute video with no chapters becomes navigable, so an agent can fetch one section instead of 8k tokens). This prompt covers roadmap items 35 (translation) and 36 (auto-chapters): work `docs/contracts/` assigns to item 36 is yours. Both are layers next to the raw transcript, never replacements.

## Read first

1. `CLAUDE.md` and `AGENTS.md`, then `docs/ARCHITECTURE.md`.
2. `packages/core/src/types.ts` (`Transcript.translated`, `Chapter`, `VideoMetadata.chapters`), `packages/core/src/provider.ts` (`CaptionOptions.allowTranslated`, `ChatRequest`), `packages/core/src/pipeline.ts` (`getVideoContext` with `language`, `chat`), `packages/core/src/segments.ts`, and `packages/core/src/testing.ts`.
3. `providers/youtube/src/captions.ts` (how `tlang` translated tracks are chosen today).
4. `docs/contracts/http-api.md`: `GET /transcript?...&lang=xx&translate=1` (a route prompt 46 owns; you export the function it calls) and `POST /chapters` (yours, through `src/http.ts`), plus the `RouteDeps` sub-app pattern.
5. `docs/prompts/SHARED-CONTRACTS.md`, sections 1.4 and 8. `tests/fixtures/README.md`.

## Goal

`@vid2context/translate` exports `translateContext(registry, context, { language, glossary? }, ctx)` that prefers a platform translation and falls back to chunked LLM translation that preserves every segment and timestamp. `@vid2context/chapters` exports `autoChapters(registry, context, opts, ctx)` that proposes valid chapters offline with a TextTiling-style algorithm and optionally titles and refines them with an LLM, plus a Hono sub-app with `POST /chapters`.

## Requirements

### Translation (`packages/translate`)

- Order: (1) if the context's source has platform captions in the target language or a platform machine translation (YouTube `tlang`), get it through `getVideoContext(registry, input, { language, refresh: true }, ctx)` and accept it when `transcript.language` matches; (2) otherwise translate with the LLM chain.
- LLM translation: chunk segments by token budget (`estimateTokens`), send each chunk as a JSON array of `{ id, text }` and require a JSON array back with the same ids; verify the count and ids, retry the chunk once with the error, and on a second failure keep the original text for that chunk and record it in a report. Keep `startSec`, `endSec`, `speaker` from the source segments.
- Glossary: names, product and model terms kept as given (passed in, plus automatically the channel name and capitalized terms that repeat in the title and description).
- Result: a new `Transcript` with `language` set to the target, `translated: true`, `producer` (rung id or caption provider id), `model`, and the original kept by the caller. Never overwrite the stored raw transcript.
- Source text in prompts is untrusted: fence it as data (use `fenceUntrusted` from prompt 10 if `packages/core/src/security` exists when you finish, else a local helper).
- Export `translateContext` for prompt 46's `translate=1` handling; do not edit `packages/server`.

### Auto-chapters (`packages/chapters`)

- Offline segmentation (no LLM, runtime-neutral): a TextTiling-style lexical cohesion algorithm over sliding windows of transcript tokens (stopword list per language for en at least, depth scores, smoothing, boundary selection), snapping boundaries to segment starts.
- Validation of any chapter list: first chapter at 0, strictly ascending, minimum length (default 60 s), count scaled to duration (roughly one per 3 to 8 minutes, configurable), `endSec` filled, final chapter ends at the duration.
- Optional LLM step: given the offline boundaries and the text of each section, propose a short title per chapter and allow moving each boundary within a small window (snap to a segment start), returning JSON validated against the rules above; fall back to offline boundaries with titles from the most distinctive terms when the LLM fails.
- Optional per-chapter summaries (one or two sentences each) behind a flag.
- Output: `{ chapters: Chapter[], producer, rung?, source: 'auto' }`. Mark the source in metadata `extra.chapterSource = 'auto'` when callers store it. Only apply to videos without chapters unless `force` is set.
- `src/http.ts`: `chaptersRoutes(deps: RouteDeps): Hono` with `POST /chapters` per the contract (`{ url }` to `{ chapters, producer, rung }`). Prompt 46 mounts it.

## Prefer free and local

Translation: platform captions or YouTube's own translation first (free, no model), then local LLM rungs, then free tiers, then keyless lanes. Auto-chapters: the offline algorithm needs nothing; the LLM titling step uses the cheapest enabled rung.

## Out of scope

- YouTube caption track selection itself: prompt 06.
- Formatting chapters into Markdown or the context pack: prompt 01.
- Surfaces (CLI flags, MCP tools, the `/transcript` route): prompts 43, 44, 46.

## Tests

- Real fixtures: `tests/fixtures/contexts/youtube-cCPsdFdlshc.json` (18 minutes, no chapters: the main chapters test), `youtube-jNQXAC9IVRw.json` (has en and de tracks on YouTube).
- Translation: record a real YouTube `tlang` caption response (or reuse `providers/youtube/test/fixtures/` where it fits) and real LLM translation responses from a keyless rung with `LIVE=1`; replay them. Assert segment count and timings are preserved, ids verified, a recorded response with a missing id triggers exactly one retry, and the original transcript object is untouched.
- Auto-chapters: run the offline algorithm on the long fixture and assert validity (starts at 0, ascending, minimum length, count in range, covers the duration) and stability (same output on rerun), not exact positions. LLM titling with a recorded real response.
- `POST /chapters` through `chaptersRoutes` mounted on a bare Hono app with replayed responses.
- Live tests (`LIVE=1`): translate a short real video to another language; auto-chapter a real video without chapters.

## Acceptance criteria

- [ ] `npx tsc -p tsconfig.json --noEmit 2>&1 | grep -E 'packages/(translate|chapters)'` prints nothing.
- [ ] `npx vitest run packages/translate packages/chapters` passes; `npx biome check packages/translate packages/chapters` is clean.
- [ ] A real auto-chapter run on the G-Wagon fixture gives chapters a human would accept (paste them in your report).
- [ ] A real translation keeps every timestamp and reads correctly in the target language (spot-check in your report).

## Docs

- `docs/guides/translate-and-chapters.md`: the order of attempts, glossary, the TextTiling approach in plain words, validation rules, examples from real output.
- Keep the translation and `/chapters` rows in `docs/contracts/http-api.md` accurate.

## If credentials, tools or network are missing

The offline chapters algorithm needs nothing. Keyless rungs need no key. Without network, run the replayed tests only, skip live tests with a message, and report what was not verified. Never hand-write a translation or an LLM response.

<!-- COMMON -->

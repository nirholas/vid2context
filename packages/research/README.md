# @vid2context/research

Three tools that let an agent ask about videos without reading whole transcripts. Speech is about 12k tokens per hour, so "what do these five videos say about timing chains?" should cost a few hundred tokens of cited excerpts, not 90k tokens of transcripts.

| Function | MCP tool | HTTP route | Needs an LLM |
|---|---|---|---|
| `research(inputs, query, opts, deps)` | `research_videos` | `POST /api/v1/research` | no |
| `listCaptionLanguages(url, deps)` | `list_caption_languages` | `GET /api/v1/caption-languages?url=` | no |
| `keyMoments(url, opts, deps)` | `get_key_moments` | `GET /api/v1/key-moments?url=&count=` | yes (free-first chain) |

`deps` is `{ registry, ctx, storage? }`. `storage` is a `Storage`, a `(ctx) => Promise<Storage | null>` factory, or `null`; when omitted, the registry's enabled storage provider is used. Saved contexts are read as a cache and new ones are saved, so researching the same videos twice fetches nothing. Runtime-neutral: Node, Workers and the browser.

## research_videos

Input: `{ urls (1 to 10), query, contextSec?, maxExcerpts?, maxTokens?, format? }`. A playlist, channel or feed URL expands through `expandInput`; the total is capped at 10 videos. Contexts are fetched three at a time. A video that fails is listed under `failed` and the rest still answer.

Ranking:

- Each transcript is cut into windows of about 30 seconds, one starting every 15 seconds, so a passage on a window edge lands whole in the next window.
- Windows are scored with BM25 (k1 1.2, b 0.75). Document frequency and average length are taken over every window of every video in the call, so a word all the videos use counts for less.
- Words are lowercased, diacritics folded, English stop words and auto-caption filler (uh, yeah) removed, and a small English stemmer maps plurals, -ing, -ed and -ability forms to one stem. Model codes and numbers (g500, 2018) pass through.
- In a query of several words, a window whose matched words carry less than an average word's share of the best window's coverage (IDF-weighted, best coverage divided by the number of words) is left out, with a note. So "timing chain" does not return "see you next time" (timing and time share a stem) once other passages say both words, while a passage with one distinctive word of a longer query still counts.
- Put a phrase in double quotes for the exact-phrase boost: each quoted phrase found verbatim doubles the window's score. When it is not found anywhere, the result says so and ranks by its words.
- Each excerpt is trimmed to the segments that contain a query word; `contextSec` (default 20) of transcript before and after is added. A window whose context would overlap an excerpt already chosen is merged into it (when it scores at least half as well and the excerpt stays within 30 seconds) or skipped, so no transcript text appears twice.

Limits: `maxExcerpts` per video (default 3, up to 10), `contextSec` 0 to 120, and a global cap of `maxTokens` (default 2000, 200 to 20000) over the rendered result. The best excerpts across all videos are kept first; an excerpt that does not fit loses its context before it is cut, and a note says what was cut.

Every excerpt has `startSec`, `endSec`, `timestamp` (`[m:ss]`), the matched `text`, `context: { before, after, fromSec, toSec }`, the timestamp `url`, its `score` and the query words it `matched`. The result also reports `tokens` (the rendered excerpts) next to `transcriptTokens` (the full transcripts searched).

The MCP tool returns compact Markdown by default (one block per video, the match in bold, each excerpt cited as `[m:ss](url)`); `format: "json"` returns the full result. The HTTP route returns JSON.

When nothing matches, the search does not fall back to an LLM. It says so plainly and lists words the transcripts do use: forms and near spellings of the query words (auto-captions often split or misspell names) and the transcripts' most distinctive words, so the agent can retry with a synonym.

## list_caption_languages

Input `{ url }`. Returns every track the installed captions providers list (`listTracks`: language, name, `creator-captions` or `auto-captions`, the provider) and, for YouTube, `translationTargets`: the languages YouTube can machine-translate a track into, read from `translationLanguages` in the innertube player response. The YouTube provider does not export that reader, so this package has its own (`readTranslationLanguages`, `fetchYouTubePlayer`), and a shared-request fetch wrapper makes the provider's `listTracks` and the reader use one player request. Other sources return tracks only.

## get_key_moments

Input `{ url, count? }` (default 8, up to 30). The transcript is compacted into lines of about 10 seconds tagged with whole-second starts and sent to the LLM chain (`chat` from core, JSON mode with a schema): local rungs first, then free tiers with your key, then keyless hosts. The model returns `{ startSec, title, why }` per moment, most important first.

- Long transcripts are chunked. The chunk size is the smallest context window among the rungs the chain may try, minus room for the instructions and the answer, capped at 24,000 tokens. Each chunk gets a share of the moments by its duration; answers are merged round-robin by importance and returned in video order.
- Every `startSec` is checked against the real segments: snapped to the nearest segment start within 5 seconds, dropped otherwise. Malformed and duplicate moments are dropped too. The result has `dropped`, `droppedMoments` (with reasons) and a note.
- An answer that is not valid JSON is retried once on a different rung.
- The result names the `rung` that answered, `model`, `chunks` and every `attempts` entry across chunks.

## Mounting (items 44 and 46)

```ts
// packages/mcp/src/server.ts (item 44)
import { registerResearchTools } from '@vid2context/research/mcp';
registerResearchTools(server, { registry, ctx });

// packages/server/src/app.ts (item 46)
import { researchRoutes } from '@vid2context/research/http';
app.route('/api/v1', researchRoutes({ registry, makeCtx: opts.makeCtx, storage }));
```

Route errors are thrown as `Vid2ContextError` and handled by the main app's `onError`. MCP failures are tool results with `isError` and the standard JSON error body.

## Tests

`npx vitest run packages/research` replays real data only: the shared `tests/fixtures/contexts/*.json` from a pre-filled `MemoryStorage`, the YouTube player fixtures in `providers/youtube/test/fixtures/`, and keyless LLM answers recorded with `scripts/record-key-moments.ts` (see `test/fixtures/README.md`). `LIVE=1` adds live calls to YouTube and the keyless rungs.

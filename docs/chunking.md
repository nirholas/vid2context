# Token estimates, chunking and sections

Speech runs about 12k tokens per hour, so a 15-episode series of 30-minute videos is about 90k tokens: too much to paste whole into most agents. Agents should read an outline first (sections with token counts), then fetch only the sections they need. The functions here, in `packages/core/src/chunk/` and `packages/core/src/tokens.ts`, are pure and runtime-neutral (no Node imports, no network), and every surface uses them: `get_outline` and `get_section` in MCP, `GET /outline` and `GET /section` over HTTP.

| Function | What it does |
| --- | --- |
| `estimateTokens(text)` | Fast token estimate for budgets |
| `transcriptOutline(context)` | Sections with token counts: chapters, or synthetic five-minute sections |
| `outlineForApi(context)` | The same in the `GET /outline` shape |
| `getSection(context, { fromSec?, toSec?, chapter? })` | One time range or section as a full `VideoContext` |
| `parseTimeArg(value)` | Parses `754`, `12:34` or `1:02:03` |
| `chunkTranscript(context, opts)` | Budget-sized chunks for retrieval or map-reduce |
| `fitToBudget(contexts, maxTokens, opts?)` | Which videos and leading sections fit a budget, and what was left out |

## Token estimates

`estimateTokens` is a heuristic, not a tokenizer: use it for budgets with headroom, never for billing. It splits text the way modern BPE tokenizers do (letter runs, digit groups of up to three, punctuation runs) and gives each piece a cost based on its script:

- ASCII words cost 1 token up to 5 letters, plus 0.15 per extra letter.
- Words with diacritics cost 1.7, plus 0.15 per letter after the fourth.
- Contractions ("don't", "l'eau") add half a token per apostrophe.
- Cyrillic costs 0.37 per letter, Arabic script 0.38, Devanagari and other Indic scripts 0.53, and other alphabets 0.5 (with at least 1 per word).
- Han costs 1.0 per character, kana 0.8 and Hangul 0.73.
- Digit runs cost one token per three digits, plus one when a space comes before them.
- Punctuation runs cost 1 token plus 0.5 per extra character.
- Newline runs and runs of two or more spaces cost 1 token each.

The rates were fitted between OpenAI o200k (GPT-4o and later) and Llama 3. The runtime code has no dependencies.

### Measured error

Error is (estimate minus real) divided by real; positive means the estimate is high, which is the safe side for budgets. Measured on 2026-11-14 with `gpt-tokenizer` 4.1.0 (o200k_base, cl100k_base) and `llama3-tokenizer-js` 1.2.0, on the real transcript fixtures and on real subtitle tracks from Wikimedia Commons (see `packages/core/test/chunk/fixtures/README.md`). The full report is `packages/core/test/chunk/token-accuracy.json`. To rerun it: `npx tsx packages/core/test/chunk/measure-tokens.ts`.

| Script | Sample | o200k | Llama 3 | cl100k |
| --- | --- | ---: | ---: | ---: |
| English | 18-min auto-caption transcript (4,184 o200k tokens) | +7.1% | +2.8% | +2.8% |
| English | same, `text` format with `[m:ss]` timestamps | +4.1% | +1.6% | +1.6% |
| English | video description with URLs | -3.7% | -5.7% | -6.1% |
| English | Apollo 11 subtitles | +2.4% | +0.7% | +0.7% |
| Spanish | Apollo 11 subtitles | -3.7% | -12.3% | -12.3% |
| French | Apollo 11 subtitles | +0.6% | -10.7% | -10.7% |
| Portuguese | Apollo 11 subtitles | -1.0% | -10.8% | -10.8% |
| Italian | Apollo 11 subtitles | -10.1% | -20.6% | -20.6% |
| Russian (Cyrillic) | Apollo 11 subtitles | +6.2% | -2.3% | -25.5% |
| Persian (Arabic script) | Apollo 11 subtitles | 0.0% | +3.7% | -50.1% |
| Hindi (Devanagari) | Apollo 11 subtitles | +10.0% | -15.5% | -59.0% |
| Japanese | Apollo 11 subtitles | -1.9% | +1.1% | -24.5% |
| Chinese, simplified | Apollo 11 subtitles | +1.4% | +1.4% | -24.6% |
| Chinese, traditional | Apollo 11 subtitles | -6.2% | -4.3% | -31.6% |
| Korean (Hangul) | Reagan radio address subtitles | +0.7% | -0.9% | -43.8% |

Over one-minute windows of the English transcript (19 windows, the size of a small chunk), the mean absolute error is 7.8% against o200k (worst 16.7%) and 2.9% against Llama 3 (worst 5.6%).

For comparison, the first heuristic (4 characters per token, 1 token per CJK character) was +18.7% against o200k on the English transcript and +48.6% on Korean.

Bounds pinned by `packages/core/test/chunk/tokens.test.ts`: English transcripts within 10% of o200k and Llama 3, and every measured script within 25%. Known weak spots:

- Italian and other Romance text without many accents runs 10 to 21% low.
- cl100k (GPT-4, GPT-3.5) is much less efficient than o200k outside Latin scripts, so estimates run 25 to 59% low there. Leave extra headroom if you target those older models with non-Latin text.
- Scripts not in the table (Thai, Hebrew, Greek, ...) use the generic rate and have not been measured.

## Chunking

`chunkTranscript(context, { maxTokens, overlapTokens?, by?, targetSec? })` returns `TranscriptChunk[]`:

```ts
{ index, startSec, endSec, text, tokens, chapterIndex?, chapterTitle?, segmentRange: [first, last], overlapSegments }
```

- `by` defaults to `chapters` when the video has chapters, else `tokens`.
- `chapters`: each chapter is chunked on its own. A chapter over budget is split further; small pieces are never merged across chapter boundaries, and overlap never crosses one.
- `tokens`: the whole transcript, filled up to the budget.
- `time`: windows of about `targetSec` (default 300), each split further when over budget. Chunks carry the chapter their first segment is in.
- Cuts happen at the latest sentence end (`. ! ? … 。 ！ ？`) or pause (a gap of 1 s or more) that fits. If there is none (typical for unpunctuated auto-captions), or cutting there would leave the chunk under a quarter of the budget, the cut falls at the last whole segment that fits. Segments are never split.
- With `overlapTokens`, each chunk after the first in its group starts with whole segments repeated from the end of the previous chunk, up to `overlapTokens`. `overlapSegments` says how many. The overlap counts toward `maxTokens`.
- `text` joins segments the way the `text` formatter does, and `tokens` is `estimateTokens(text)`.

These invariants are tested on the real fixtures at budgets of 200, 1000 and 4000: chunks cover every segment in order; start and end times never go backwards; every chunk is within `maxTokens` unless it is a single segment that alone exceeds the budget; and every cut that is not a sentence end or pause happens because the next segment would not fit.

## Outline

`transcriptOutline(context)` returns `{ title, durationSec, totalTokens, sections }`, where each section is `{ index, title, startSec, endSec, tokens, source }`.

- Videos with chapters list them in start order (`source: 'chapters'`). Each segment belongs to the chapter its start falls in, and speech before the first chapter goes to the first chapter.
- Videos without chapters get synthetic sections (`source: 'time'`) of about five minutes, titled by time range. Each cut is at the sentence end or pause nearest the five-minute mark (within 40%), or else the nearest segment boundary. A tail shorter than seven minutes stays in one section.
- Sections are contiguous from the start of the video to its end, and `totalTokens` is the sum of the section tokens.

`outlineForApi(context)` returns the `GET /outline` body from `docs/contracts/http-api.md`: `{ metadata, chapters: (Chapter & { tokens })[], totalTokens }`. Synthetic sections appear as chapters; `metadata.chapters` stays empty for those videos, so a client can tell the two cases apart.

Real output for `tests/fixtures/contexts/youtube-cCPsdFdlshc.json` (18 minutes, auto-captions, no chapters):

```json
{
  "title": "Best & Worst G-Wagon Years: Reliability, Interiors & Engines Ranked!",
  "durationSec": 1085.559,
  "totalTokens": 4484,
  "sections": [
    { "index": 0, "title": "0:00 to 5:00", "startSec": 0, "endSec": 300.8, "tokens": 1199, "source": "time" },
    { "index": 1, "title": "5:00 to 10:02", "startSec": 300.8, "endSec": 602.24, "tokens": 1271, "source": "time" },
    { "index": 2, "title": "10:02 to 15:01", "startSec": 602.24, "endSec": 901.519, "tokens": 1289, "source": "time" },
    { "index": 3, "title": "15:01 to 18:05", "startSec": 901.519, "endSec": 1085.559, "tokens": 725, "source": "time" }
  ]
}
```

## Sections

`getSection(context, { fromSec?, toSec?, chapter? })` returns a `VideoContext`, so every formatter renders it unchanged:

- A time range keeps every segment that overlaps `[fromSec, toSec)`. Either end may be left out.
- `chapter` takes an outline section index (counting from 0, so it works for synthetic sections too) or a title. Titles match case-insensitively: exact first, then prefix, then substring. With no match, it throws `bad-request` with a hint listing the sections. A chapter keeps the segments that start inside it, the same ones its outline token count covers. Passing `fromSec` or `toSec` as well narrows the chapter further.
- `metadata.chapters` is trimmed and clamped to the range, and `metadata.extra.section` is set to `{ fromSec, toSec, chapterTitle? }`. The input is not modified, and the raw segments are sliced, never rewritten.
- An empty range, or a start after the end of the video, throws `bad-request`.

`parseTimeArg(value)` accepts what `from` and `to` allow in `docs/contracts/http-api.md`: seconds (`754`, `75.5`), `m:ss` (`12:34`, `90:00`) and `h:mm:ss` (`1:02:03`). Seconds after a colon need two digits, so `12:5` is rejected. Invalid input throws `bad-request`.

## Budget planner

`fitToBudget(contexts, maxTokens, { perVideoOverhead? })` returns:

```ts
{
  items: { videoId, whole, sections?: { startSec, endSec, tokens }[] }[],
  totalTokens,
  omitted: { videoId, startSec, endSec, tokens }[],
}
```

1. Videos are included whole, in input order, while they fit. A video too large to fit is skipped, and later, smaller videos can still fit whole.
2. The remaining budget is shared among the other videos in proportion to their length. Each video takes its leading outline sections first. A section that does not fit whole is split on sentence ends or pauses and its leading part is taken. Pieces of one section are reported as one range.
3. Budget left over from rounding goes back to those videos, in input order.
4. `perVideoOverhead` reserves tokens for each included video's header (title, link, chapter list). A video that ends up with no transcript gives its reservation back.

Guarantees, tested at many budgets: `totalTokens` never exceeds `maxTokens`; `items` has one entry per input, in order; and for each partial video the included and omitted ranges tile its full span with no gaps or overlaps. Use `omitted` to tell the reading model what is missing.

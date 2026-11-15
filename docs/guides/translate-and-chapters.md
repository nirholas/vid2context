# Translation and auto-chapters

Two layers that sit next to the raw transcript and never replace it:

- `@vid2context/translate`: the transcript in another language, with every segment and timestamp kept.
- `@vid2context/chapters`: chapters for a video that has none, so an agent can fetch one section instead of the whole transcript.

## Translation

```ts
import { translateContext } from '@vid2context/translate';

const res = await translateContext(registry, context, { language: 'de', glossary: ['W463'] }, ctx);
res.transcript; // new Transcript: language 'de', same segment timings
res.via;        // 'source' | 'platform' | 'llm'
res.report;     // { chunks, retried, failed, untranslatedSegments }
```

### Order of attempts

1. **Already in the language.** The source transcript is returned as is (`via: 'source'`).
2. **The platform.** The pipeline runs again in captions mode (no audio download) with `language` set. On YouTube that gives a creator or auto track in the language, or YouTube's own machine translation (`tlang`). It is accepted when the returned language matches (`via: 'platform'`, `producer` is the caption provider id). A creator track is a human translation, so it keeps `translated` unset; a `tlang` track has `translated: true`.
3. **The LLM chain.** Local rungs first, then free tiers with your key, then keyless hosts, then paid ones (`via: 'llm'`, `producer` is the rung id).

`platform: false` skips step 2. `llm: false` stops after step 2 with `no-transcript` (what the HTTP API does without `translate=1`).

### How LLM translation keeps timestamps

Segments are cut into chunks of about 1500 tokens (`chunkTokens`). Each chunk goes to the model as a JSON array of `{ id, text }` and must come back as `{"segments":[{ id, text }]}` with exactly the same ids. The answer is checked: count, missing ids, unexpected ids, repeats, empty texts.

- A bad answer is retried once. The retry shows the model its own answer and what was wrong, for example `Expected 30 segments, got 12. Missing ids: 12, 13, 14, ...`.
- Some models answer with the input unchanged: the ids are right but nothing is translated. When a chunk has at least three sentence-like segments (three or more words) and more than half come back identical to the source, the answer counts as untranslated (attempt reason `untranslated`). Feedback does not fix such a rung, so the one retry goes to the next rung instead, and the echoing rung is skipped for the remaining chunks. Short lines, names and sound tags such as `(baaaaaaaaaaahhh!!)` may stay the same without triggering this. On 2026-11-15 Kilo's keyless `nemotron-3.5-lightning` did this for "Me at the zoo" to French, and `nemotron-3-ultra` then translated it: `All right, so here we are, in front of the elephants` became `Très bien, nous voici devant les éléphants`.
- If the retry fails too, that chunk keeps its original text and the report lists it in `failed`. The rest of the transcript is still translated.
- `startSec`, `endSec` and `speaker` are copied from the source segments, so the translation lines up with the video exactly.

The transcript text is fenced as untrusted data (`fenceUntrusted` from core), so instructions spoken in a video are not followed.

### Glossary

Terms the model must keep exactly as written: your `glossary` list, then the channel name, then capitalized terms from the title and description that repeat. Because titles are often in title case, a word only counts when the description also capitalizes it mid-sentence, or when it looks like a code or brand (a digit, an inner capital, `G-Wagon`). At most 30 terms.

For the G-Wagon video with `glossary: ['W463']` this gives `W463; Alliance Motorworks; G-Wagon; Joe`.

### Example (real output)

The first segments of the G-Wagon video, English to German by OVH's keyless `gpt-oss-120b`:

| Start | Source | Translation |
|---|---|---|
| 0:00 | so you're going to buy G wagon which | also willst du einen G-Wagon kaufen, welcher |
| 0:02 | year is best for you well in this video | Jahr ist das beste für dich, nun in diesem Video |
| 0:29 | is the G wagon specialist and help me | ist der G-Wagon-Spezialist und hilft mir |
| 0:51 | G500 the second one is a to uh 2012 G55 | G500, das zweite ist ein, äh, 2012 G55 |

Smaller models can be weaker: in the same run Llama 3.3 70B once copied a glossary name into a line where it was not spoken. Segment count and timings were still right.

## Auto-chapters

```ts
import { autoChapters, withAutoChapters } from '@vid2context/chapters';

const res = await autoChapters(registry, context, { summaries: true }, ctx);
res.chapters; // [{ title, startSec, endSec, summary? }]
res.producer; // the rung id, or 'chapters/texttiling' when fully offline
const stored = withAutoChapters(context, res); // metadata.extra.chapterSource = 'auto'
```

Only videos without chapters are handled; pass `force: true` to replace platform chapters. `llm: false` stays fully offline.

### The offline algorithm (TextTiling)

No model and no network, and the same transcript always gives the same chapters.

1. Keep the content words: stopwords are removed (English, German, Spanish, French and Portuguese lists, with spoken fillers like "gonna" and "yeah"), English words are lightly stemmed, and words that appear in most of the video are dropped because they say nothing about topic changes.
2. Cut the words into small groups of 20 ("pseudo-sentences").
3. At each gap between groups, compare the words of about two minutes before the gap with the two minutes after it. Similar words mean the same topic continues.
4. Smooth that similarity curve and score each dip by how far the curve climbs back up on both sides. A deep dip is a topic change.
5. Take the deepest dips, keep chapters spread out, aim for about one chapter per 5 minutes, and move each boundary to the start of the transcript segment where the new part begins.

Offline titles are the three most distinctive words of each chapter (frequent in that chapter, rare in the others). They are rough; the LLM step makes them readable.

### The LLM step

The model gets the offline boundaries and each section's transcript lines. It writes a short title per chapter (and a summary when `summaries` is set) and may move each boundary within 45 seconds (`windowSec`). A moved start must stay inside its window and is snapped to a real segment start. If the answer has the wrong number of chapters, empty titles, or breaks a rule below, the offline boundaries are kept, with the LLM titles when they are usable, otherwise with the offline titles. The `notes` field says what happened.

### Validation rules

Every chapter list, from any source, must pass `checkChapters`:

- the first chapter starts at 0;
- starts are strictly ascending and inside the video;
- every chapter, the last included, lasts at least 60 seconds (`minChapterSec`); a single chapter covering a shorter video is fine;
- the count fits the duration, about one chapter per 3 to 8 minutes (`minAverageSec`, `maxAverageSec`); for 18 minutes that is 2 to 7;
- every title is a non-empty single line.

`endSec` is filled in: each chapter ends where the next starts, and the last ends at the video's duration.

### Example (real output)

"Best & Worst G-Wagon Years" (18 minutes, no chapters). Offline only:

| Start | Title |
|---|---|
| 0:00 | Truck, drink and door |
| 6:37 | Phone, g500 and seats |
| 9:02 | Difference, forward and motor |
| 13:15 | Coolers, extra and truck |

With the LLM step (OVH `gpt-oss-120b`, two boundaries moved):

| Start | Title |
|---|---|
| 0:00 | Intro and 2000 G500 Engine/Interior |
| 5:54 | G55 AMG Overview: Engine, Interior, and Tech |
| 9:20 | 2015 G550: New V8, 7-Speed, Interior |
| 13:15 | 4.0L Turbo Era: Performance and Buyer Advice |

Model titles are cleaned: a spaced dash becomes a colon, surrounding quotes and a trailing period are removed.

## HTTP

- `POST /api/v1/chapters` with `{ "url": "..." }` (optional `force`, `llm`, `summaries`, `lang`) returns `{ chapters, producer, rung, ... }`. The route is `chaptersRoutes(deps)` from `@vid2context/chapters/http`, mounted by the server.
- `GET /api/v1/transcript?url=...&lang=de&translate=1` is served by the server package, calling `translateContext`.

See [docs/contracts/http-api.md](../contracts/http-api.md) for the exact shapes.

## Recording fixtures

`LIVE=1 node_modules/.bin/tsx packages/translate/scripts/record.ts` and `LIVE=1 node_modules/.bin/tsx packages/chapters/scripts/record.ts` call the real keyless rungs and rewrite the fixtures. Keyless hosts allow about one or two requests per minute per IP, so the scripts wait between calls.

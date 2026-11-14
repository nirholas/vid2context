# @vid2context/skips

Finds the sponsor reads, self-promotion, subscribe reminders, intros and outros in YouTube videos, using the free, crowdsourced [SponsorBlock](https://sponsor.ajay.app) database, and builds a transcript layer without them. Cited briefs then stop quoting ad copy ("this video is brought to you by...") as if it were a claim about the topic.

The raw transcript is never changed. `applySkips` returns a new transcript whose producer ends in `+skips`; the stored transcript stays as it was.

## Use

```ts
import { applySkips, getSkipSegments } from '@vid2context/skips';

const lookup = await getSkipSegments(context.metadata.ref, ctx);
// lookup.segments: spans to skip, lookup.highlight: the community highlight point,
// lookup.fullVideo: set when the whole video is labelled sponsored.
const { transcript, removed, coveredSec } = applySkips(context.transcript, lookup.segments);
```

- `getSkipSegments(ref, ctx, { categories?, minVotes?, timeoutMs? })` returns `{ videoId, segments, highlight?, fullVideo?, chapters, looked }`. Non-YouTube refs, a 404 from the API and `VID2CONTEXT_SPONSORBLOCK=0` all give `segments: []`. It returns an object rather than a bare array because the highlight and the whole-video flag must come back separately from the spans.
- `applySkips(transcript, segments, { mode?, minOverlap? })` returns `{ transcript, removed, coveredSec }`.
  - `drop` (default) removes lines that have at least `minOverlap` (default 0.5) of their duration inside skip spans.
  - `mark` keeps every line unchanged and lists the overlapping line indexes in `removed[].indexes`, so a formatter can label them. `Segment.speaker` is never used for this; it names people.
  - Only `skip` and `mute` spans remove lines. A highlight, a whole-video label or a chapter removes nothing.
- `skipQueryOption(transcript, ctx, skip)` applies a `skip=sponsor,selfpromo` option in one call (see below).

### How lookups work

The request carries only the first 4 hex characters of `sha256(videoId)` (`GET /api/skipSegments/<prefix>`). SponsorBlock answers with every video sharing that prefix, usually 100 to 200, and the exact video is picked out locally, so the server never learns which video was asked for. Hashing uses WebCrypto and the request uses `ctx.fetch`, so this runs on Node, Workers and in the browser.

- Votes: negative votes are always dropped; `minVotes` (default 0) drops more, except segments a SponsorBlock VIP locked.
- Overlaps: the better segment wins (more votes, then locked, then the more specific category, sponsor first). A weaker segment that is half or more covered is dropped; one that only touches at an edge is trimmed, so no second is counted twice.
- Action types: `skip` and `mute` are spans to skip (a `mute` span's speech is the labelled content). `poi` is returned as `highlight`. `full` (start and end 0) means the whole video is sponsored, self-promotion or exclusive access: it is reported as `fullVideo`, never used to drop the transcript. `chapter` segments come back in `chapters` with their titles.
- Timeouts are 5 seconds. Network failures and 5xx answers become `Vid2ContextError('upstream')`, a timeout becomes `timeout`, a 429 becomes `rate-limited`, each with a hint. `skipQueryOption` catches these, logs a warning and returns the raw transcript: skipping ads never blocks a transcript.

## Categories

Checked live against the API on 2026-11-14.

| Category | Meaning | Default |
|---|---|---|
| `sponsor` | paid promotion | yes |
| `selfpromo` | unpaid or own promotion: merch, Patreon, other channels | yes |
| `interaction` | subscribe, like and comment reminders | yes |
| `intro` | intro animation or pause with no content | yes |
| `outro` | end cards and credits | yes |
| `preview` | recap or preview of what is coming | yes |
| `filler` | tangents and jokes not needed for the main content (aggressive) | yes |
| `hook` | a teaser or greeting before the intro | no |
| `music_offtopic` | non-music parts of music videos | no |
| `poi_highlight` | the point most viewers skip to; returned as `highlight` | no |
| `exclusive_access` | whole-video label: showcases a product the creator got access to | no |
| `chapter` | community chapters with titles | no |

## Environment

| Variable | Effect |
|---|---|
| `VID2CONTEXT_SPONSORBLOCK=0` | turn lookups off (no request is made) |
| `SPONSORBLOCK_API_URL` | base URL of a self-hosted mirror, default `https://sponsor.ajay.app` (a trailing `/api` is accepted) |
| `VID2CONTEXT_SKIP_CATEGORIES` | default categories, comma-separated, for example `sponsor,selfpromo`; unknown names are ignored with a warning |

All are read from `ctx.env`.

## Surfaces

MCP (item 44 wires it; `storage` is optional and lets a saved transcript fill in the coverage numbers):

```ts
import { registerSkipsTools } from '@vid2context/skips/mcp';
registerSkipsTools(server, { registry, ctx, storage });
```

Tool `get_skip_segments { url, categories? }` returns the segments with `[m:ss]` ranges, timestamp URLs, the transcript lines, word share and first words each covers, `coveredSec`, `highlight`, `fullVideo` and the attribution. It reads the transcript in `captions` mode (from storage when saved), so it never downloads audio just to compute coverage.

HTTP (item 46 mounts it):

```ts
import { skipsRoutes } from '@vid2context/skips/http';
app.route('/api/v1', skipsRoutes({ registry, makeCtx, storage }));
```

`GET /api/v1/skips?url=&categories=sponsor,selfpromo` answers `{ videoId, segments, coveredSec, source: 'sponsorblock', attribution }`, plus `coveredShare`, `highlight`, `fullVideo`, `chapters` and `note` when they apply. Errors propagate to the main app's `onError`.

The `skip=` option on `GET /transcript`, one line in item 46's route:

```ts
import { ATTRIBUTION_HEADER, SPONSORBLOCK_ATTRIBUTION, skipQueryOption } from '@vid2context/skips';
const transcript = await skipQueryOption(context.transcript, ctx, c.req.query('skip') ?? '');
// When transcript.producer ends in '+skips', set c.header(ATTRIBUTION_HEADER, SPONSORBLOCK_ATTRIBUTION).
```

`skip` accepts a category list, `1`/`true`/`default` for the default categories, and empty/`0`/`none` for no skipping. Unknown names throw `bad-request`.

## License and attribution

The SponsorBlock database is licensed [CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/). Every MCP and HTTP result that uses it carries:

> Segment data: SponsorBlock (sponsor.ajay.app), CC BY-NC-SA 4.0

The data is non-commercial: a paid hosted vid2context plan must not depend on it. Keep it a free, optional filter, or turn it off with `VID2CONTEXT_SPONSORBLOCK=0` on commercial deployments. This package's code is Apache-2.0 like the rest of vid2context; the SponsorBlock server code (AGPL-3.0) is not used, only its public API.

## Not covered

- Videos on other platforms: SponsorBlock covers YouTube only. Detecting ads in other videos with an LLM is possible later and is not built.
- Rendering: formatters (item 01) render whatever transcript they are given, including a `+skips` layer.

## Tests

`npx vitest run packages/skips` replays real API responses from `test/fixtures/` (see its README). `LIVE=1 npx vitest run packages/skips/test/live.test.ts` calls the real API.

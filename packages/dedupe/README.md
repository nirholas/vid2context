# @vid2context/dedupe

Finds reuploads and clips in a set of videos, so a brief counts each original once. Briefs flag consensus when two or more independent videos agree; a clip of a show agreeing with the show is not consensus, and neither is the same video uploaded four times.

```ts
import { findDuplicates, independentSources } from '@vid2context/dedupe';

const { groups, related, representativeOf } = findDuplicates(contexts);
// groups: [{ kind: 'clip', original: 'youtube:full', members: [{ videoId: 'youtube:full' },
//          { videoId: 'youtube:clip', offsetSec: 751, coveredRange: { startSec: 751, endSec: 932 }, evidence }] }]

const sources = independentSources(contexts); // one VideoContext per original, in input order
```

Pure TypeScript with no network calls and no Node built-ins, so it runs on Node, Workers and in the browser. It reads transcripts only (`VideoContext.transcript.segments`), plus metadata as a tie-breaker.

## Method

1. **Normalize** each transcript (`src/normalize.ts`): lowercase, drop `[Music]` style annotations and the `>>` speaker marker, numbers as digits ("twenty five" and "25" both become `25`, "$5" becomes `5 dollars`), punctuation removed, apostrophes dropped (`that's` becomes `thats`), a few spoken variants folded (`gonna` to `going to`, `alright` to `all right`, `okay` to `ok`), fillers dropped (`um`, `uh`, `oh`, `hmm` and similar). Each word keeps a time interpolated inside its caption segment.
2. **Shingle**: every run of 5 consecutive words becomes a 52-bit hash, kept with its position and time.
3. **Candidate search** (`src/minhash.ts`): MinHash with 128 seeded hash functions (a fixed seed, so every run gives the same signatures) and LSH banding (64 bands of 2 rows). Signatures are computed per window of two consecutive 50-shingle blocks, stride one block, rather than per transcript: whole-transcript MinHash estimates Jaccard similarity, which is about 3/40 for a 3-minute clip of a 40-minute video even when every clip word is in the original, so it would never propose clips. A clip's windows overlap a window of the original by at least three quarters. Only pairs that share an LSH bucket in some window are compared.
4. **Exact alignment** (`src/align.ts`) of each candidate pair: every shingle of the shorter video is looked up in the longer one (a shingle repeated more than 8 times inside one transcript is treated as a stock phrase and ignored); the longest chain of matches that moves forward in both transcripts is kept (longest increasing subsequence), which is what "in time order" means; the chain is cut into runs wherever it jumps more than 12 shingles on either side; runs with fewer than 3 matches are dropped as coincidences.
5. **Gap tolerance**: one misheard word breaks five shingles in a row, so inside a run the words between matches count as covered. Both transcripts' start and end are anchors too: when both begin within 12 shingles of the first shared run, the words before it count as covered, but never more words than the run itself has, so one short shared phrase cannot claim a whole short video. The **overlap** of a pair is the covered share of the shorter transcript's words.
6. **Classify** each pair, then group:
   - `reupload`: overlap above 0.8 and durations within 10 percent (or within 5 seconds, so a 19-second video with a 4-second channel bumper still counts).
   - `clip`: not similar in length, and overlap above 0.6. The offset is the median of (time in the original minus time in the clip) over matched shingles; `coveredRange` is the span of the original the matched runs cover.
   - `related`: neither, but one shared run of at least 25 words. Reported separately in `related` with the shared spans in both videos; related videos stay independent.
   - otherwise distinct.
7. **Groups**: reuploads are joined transitively (if A is a reupload of B and B of C, all three are one group). Each clip points at the longest video it is a clip of, so a clip of a clip lands in the group of the full episode; when the clip does not align with the full episode directly, the offsets along the path are added and the member's `evidence.method` is `composed`. `representativeOf` maps every input to the original it counts as.

### Metadata, as tie-breaker only

Metadata never classifies a pair. It is used in two places:

- **Close calls**: when the transcript overlap is within 0.05 below the reupload or clip threshold and the titles are similar (word Jaccard of at least 0.5, ignoring words like "reupload", "official", "HD") or both videos are on the same channel, the pair is promoted and its `evidence.method` says `shingles+metadata`.
- **Which video is the original** of a reupload group: the earliest `publishedAt`; then the most views (`metadata.extra.viewCount`); then the one with creator captions; then the longer; then input order. For clips, the long video is the original.

## Thresholds and why

All are options of `findDuplicates(contexts, opts)` (see `DedupeOptions` in `src/types.ts`).

| Option | Default | Why |
| --- | --- | --- |
| `shingleSize` | 5 | Five words in a row are specific enough that unrelated videos almost never share them, and short enough to survive frequent caption errors. |
| `numHashes`, `bands` | 128, 64 | Two rows per band: a window pair with Jaccard 0.3 becomes a candidate with probability 0.998. False candidates only cost one exact comparison. |
| `blockShingles` | 50 | Windows of about 100 shingles (40 seconds of speech) are short enough for clips under a minute to overlap one by three quarters. |
| `maxGap` | 12 | Bridges a misheard word or two (each breaks 5 shingles) plus an inserted or dropped word. |
| `minRunMatches` | 3 | A run of 3 in-order matches is 7 shared words; isolated matches of stock phrases are dropped. |
| `reuploadOverlap` | 0.8 | Measured below. |
| `durationTolerance`, `durationSlackSec` | 0.1, 5 | Reuploads keep the length; a clip or a re-edit changes it. The slack covers bumpers on very short videos. |
| `clipOverlap` | 0.6 | Measured below. Clips often add a channel intro or outro that the original lacks; 0.6 leaves room for that. |
| `relatedMinWords` | 25 | About ten seconds of identical speech: longer than shared catchphrases, shorter than a quoted passage. |
| `metadataMargin`, `titleSimilarity` | 0.05, 0.5 | Small enough that metadata only breaks ties. |
| `minWords` | 12 | Fewer words cannot be judged; such videos are listed in `skipped` and stand alone. |

### Measured on the real fixtures

Every pair of the eight real fixtures (the reuploads, the episode and clips below, and the two shared contexts) was aligned with the defaults. "Exact" is the share of the shorter transcript's shingles found anywhere in the other with no tolerance at all; "overlap" is the score `findDuplicates` uses.

| Pair | Transcripts | Exact | Overlap | Result |
| --- | --- | --- | --- | --- |
| Me at the zoo: original vs RetroYTVideos reupload | creator captions vs auto-captions | 0.559 | 1.000 | reupload |
| Me at the zoo: original vs 2021 reupload | creator captions vs auto-captions | 0.471 | 1.000 | reupload |
| Me at the zoo: the two reuploads | auto vs auto | 0.556 | 1.000 | reupload |
| Lex Fridman #118 vs "The Snuggle is Real" (36 s) | local Whisper, separate runs | 1.000 | 1.000 | clip at 1416.24 s (true about 1416.2) |
| Lex Fridman #118 vs "Richard Feynman is misunderstood" (4:49) | local Whisper, separate runs | 0.899 | 1.000 | clip at 311.85 s (true about 311.8) |
| Lex Fridman #118 vs "Topology is amazing and useful" (5:16) | local Whisper, separate runs | 0.832 | 0.983 | clip at 1121.48 s (true 1123.1) |
| All 22 other pairs (different videos) | mixed | 0.000 | 0.000 | distinct, no run at all |

What this says about the thresholds:

- Exact shingle overlap alone is not enough: three transcripts of the same 19 seconds of audio share only 47 to 56 percent of their shingles, because one misheard word breaks five shingles. Even two Whisper runs over the same audio share only 83 to 90 percent, since the model segments and punctuates a 5-minute excerpt differently from the same passage inside a 2-hour file. Gap bridging and edge anchoring lift every real pair to 0.98 or more.
- Unrelated videos score exactly 0 (not one run of 3 in-order matches), so there is a wide gap between the classes. The defaults sit low in that gap on purpose: 0.8 for reuploads and 0.6 for clips leave room for the cases these fixtures do not cover (weaker auto-captions, a clip with an added intro, outro or commentary) while a chance match of unrelated speech would still need dozens of in-order five-word runs.
- The clip offset is within 2 seconds of the true offset on all three clips. The remaining error is caption timing: the topology clip's first line starts 1.6 seconds into its segment in the episode. The true offsets were found by matching clip sentences to episode sentences by hand (see `test/fixtures/README.md`).

## Performance

Measured on an AMD EPYC 7B12 (32 threads, single-threaded run) with Node 24, on copies of real fixtures under distinct ids (`test/performance.test.ts`):

| Input | Time | Candidate pairs | Aligned pairs |
| --- | --- | --- | --- |
| 200 copies of an 18-minute transcript (60 hours, every pair a duplicate) | 7.0 s | 19,900 | 199 |
| 100 copies of a 2h08m episode (214 hours) | 8.6 s | 4,950 | 99 |
| 94 copies of the episode and of each of its three clips (376 videos, 209 hours) | 10.8 s | 43,992 | 654 |

Most of the time goes to MinHash signatures (one per 100-shingle window, so cost grows linearly with total speech). Pairs already in one reupload cluster, and cluster pairs already linked as clip and source, are not aligned again; without that second rule the last row aligns 26,880 pairs and takes 28.6 s. These are worst cases where everything matches everything. A collection of distinct videos makes few LSH candidates, so 200 one-hour transcripts cost about the same as the 214-hour row, about 8 seconds. The tests allow 60 to 120 seconds per case so slow laptops and CI do not flake.

## Using it in briefs (item 32)

Count agreement per original, not per video:

```ts
const { representativeOf } = findDuplicates(contexts);
const sources = new Set(claimGroup.map((claim) => representativeOf[claim.videoId] ?? claim.videoId));
const consensus = sources.size >= 2;
```

`independentSources(contexts)` returns one context per original, in input order, for callers that simply want to drop copies before reading. Prefer `representativeOf` when you still want to cite the clip a viewer is likely to have watched: a clip can carry commentary the original lacks (its overlap can be as low as 0.6), so keep its claims, just do not count them as a second source.

## HTTP and MCP

- `src/http.ts`: `dedupeRoutes(deps)`, a Hono sub-app with `POST /duplicates` (mounted under `/api/v1` by `packages/server`). Body `{ inputs?: string[], collectionId?: string, options?: DedupeOptions }`. Playlists and channels in `inputs` are expanded; contexts come from the library when saved, otherwise through the pipeline.
- `src/mcp.ts`: `registerDedupeTools(server, deps)` registers `find_duplicates { urls?, collection? }`.

Both return the `findDuplicates` result plus `videos` (title, channel, duration and link per video), `failed` (inputs that could not be loaded; the rest are still compared) and, on clip members, `startsAt` (`[m:ss]`) and `startsAtUrl` (a timestamp link into the original). At most 500 videos per request.

## Limitations

- Transcripts only. Re-dubbed or translated reuploads, music without lyrics, and videos without speech are not detected. Audio or visual fingerprinting would catch those; it is out of scope because transcripts cover the case that matters here (talk, reviews, podcasts, lectures).
- Two uploads with very poor auto-captions can fall below the thresholds; they then appear in `related` with their shared spans rather than as a group.
- A clip that reorders the original's passages only counts the passages in the original's order.
- Compilations of several sources cover less than 0.6 of themselves from any one source, so they show up as `related` to each source, not as clips.
- English normalization (number words, fillers) only; other languages still work on punctuation and case folding, with less tolerance.

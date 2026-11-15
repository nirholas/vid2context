# Evaluations

`packages/evals` measures how good vid2context's transcripts and citations are, with numbers instead of impressions: word error rate per speech-to-text rung, auto-caption and cleanup quality, citation accuracy, retrieval quality, latency and cost. Everything runs on real public videos and real rungs.

The trick that keeps it honest and free: YouTube videos with creator-uploaded captions come with a human-written reference transcript. Scoring a rung's output against that reference costs nothing and needs no labeling.

## Running

```sh
LIVE=1 npm run eval -- --suite stt --limit 3
LIVE=1 npm run eval -- --suite all
LIVE=1 npm run eval -- --suite stt --rungs stt/ovh/whisper-large-v3-turbo,groq
LIVE=1 npm run eval -- --suite captions --check
```

| Flag | Meaning |
|---|---|
| `--suite <name>` | `stt`, `captions`, `cleanup`, `citations`, `search`, or `all` (default `stt`) |
| `--rungs <ids>` | rung ids, services or providers to score, each pinned on its own with the chain option `only`. Paid rungs run only when named here and their key is set. |
| `--limit <n>` | only the first n dataset items (datasets are ordered so the first three are varied and short) |
| `--dataset <file>` | a different dataset file (a name in `packages/evals/datasets/` or a path) |
| `--out <dir>` | where results go (default `packages/evals/results/`) |
| `--json` | print the result JSON instead of the Markdown report |
| `--check` | exit 1 when a rung breaks `packages/evals/thresholds.json` |
| `--record` | save references fetched during the run into `datasets/refs/` (only for entries marked `storeReference`, that is public domain or CC); others go to the cache |
| `--live` | same as `LIVE=1` |

The runner refuses to start without `LIVE=1` or `--live`: it calls real services, uses your free quotas and needs the network, and it should never look like it produced numbers when it did not. The metric code is unit-tested offline with `npx vitest run packages/evals`.

Each run writes `packages/evals/results/<YYYY-MM-DD>-<suite>.json` (every per-item score, the rung, its attempts, a short sample of the hypothesis, and an environment summary without secrets) and a Markdown report next to it, and prints the report to stdout. Progress and warnings go to stderr.

Rung selection is free first. Without `--rungs`, every enabled local, free-tier and keyless rung is scored on its own, so the keyless OVH Whisper rung works with zero setup. Rungs that are not enabled are listed as skipped with the env var that would enable them; they never count as failures. Paid rungs are skipped unless named.

Audio and fetched references are cached under `.vid2context/cache/evals/` (or `$VID2CONTEXT_HOME/cache/evals/`), so a rerun downloads nothing it already has.

## Suites

### stt

For each video in `datasets/stt.json`: get the creator-caption reference, download the audio once through whichever installed source can supply it (the yt-dlp provider for YouTube), then transcribe it with each selected rung through core's `transcribeLong`. That is the same path the product uses, so rungs with short limits (OVH keyless accepts 60 seconds per request) receive split audio, and rate limits are waited out rather than failed.

Per rung it reports WER and CER (pooled: total errors over total reference words or characters), substitutions, deletions and insertions, the median word start-time difference against the reference, p50 and p90 latency (the sum of `attempts[].ms` of the successful speech-to-text calls), the real-time factor (latency over audio length) and cost.

### captions

For each video in `datasets/captions.json`, YouTube's auto-captions are scored against the creator captions of the same video: WER, CER, timing, and punctuation and capitalization F1. The creator track comes through the pipeline; the auto track is read straight from the player's track list (`autoReference` in `src/suites/common.ts`, through the YouTube provider's exported `getPlayer` and `fetchTrack`), because the pipeline always prefers a creator track when one exists.

### cleanup

Its own suite (`src/suites/cleanup.ts`), on the same videos (`captions.json` by default). Every variant starts from the same raw auto-captions and is scored against the creator captions:

| Variant | What runs |
|---|---|
| `raw` | the auto-caption track as served (baseline) |
| `clean:rules` | core `cleanTranscript` rule-based steps: caption normalization, rolling-duplicate folding, sentence restoration |
| `clean:fillers` | the same plus filler removal |
| `clean:llm` | the rule-based steps plus the LLM punctuation pass (`punctuateWithLlm`) on the default free-first chain; with `--rungs`, one `clean:llm:<rung id>` row per named LLM rung, each pinned with `only` |

Per variant: WER and CER (cleanup must not change what was said, so these should stay at the raw level), punctuation and capitalization F1 (what cleanup is for), the change against `raw` in percentage points, timing, and for the LLM pass its latency and how many chunks were applied, rejected (the model changed words, so the original text was kept) or failed. The raw track is never replaced.

### citations

For each question in `datasets/citations.json`, over the collection's recorded transcripts, two producers answer through the free-first LLM chain: `ask` (`@vid2context/ask`, a grounded answer with `[n]` citations) and `brief` (`@vid2context/insights`, a cited brief for the question). Every citation they return is checked independently with `checkCitation`. Per producer the report gives citation accuracy (citations whose quote occurs within 30 s of their time, over all returned), the expected-place hit rate (questions where at least one citation lands within 30 s of a labeled answer), the share of citations the producer rejected itself (unverified brief claims, `[n]` refs that match no source) and LLM latency.

The questions and their quotes were labeled by reading the recorded G-Wagon transcript (`tests/fixtures/contexts/youtube-cCPsdFdlshc.json`); a unit test checks that every labeled quote really occurs inside its range.

### search

The collection is indexed in memory with `@vid2context/search`, and every query in `datasets/search.json` runs in keyword mode (BM25) and, when an embedding rung is enabled, hybrid mode (BM25 fused with vectors). Per mode: precision@5, recall@5, MRR and the engine's total time per query. Precision@5 is capped by the number of labeled ranges: a query with one labeled range scores at most 20%.

### Chapters

`boundaryAgreement` scores predicted chapter starts against reference starts within plus or minus N seconds (precision, recall, F1, one-to-one matching, the boundary at 0 ignored). It is ready for auto-chapters (prompt 35) once that package exists.

## Metrics

### Normalization

Applied to both sides before WER and CER, in this order:

1. Unicode NFKC, lowercase, curly apostrophes made straight.
2. Drop bracketed and parenthesized tags (`[Music]`, `[Applause]`, `(laughs)`), music notes, and speaker markers (`>>`) at a line start.
3. English only: expand contractions (`don't` to `do not`, `gonna` to `going to`).
4. Numbers: strip thousands separators (`1,000` to `1000`). In English, `%` becomes `percent` and integers 0 to 9999 are spelled out (`21` to `twenty one`), so digits and words agree. Other languages keep their digits.
5. Apostrophes inside a word are dropped (`it's` to `its`, `l'eau` to `leau`). Every other character that is not a letter, digit or combining mark, in any script, becomes a space.
6. English fillers (`um`, `uh`, `er`, `erm`, `ah`, `hmm`, `mm`, `mhm`) are removed unless `fillers: true`. Creator captions usually omit them and speech-to-text often keeps them; neither is a recognition error.

CER uses the normalized text with spaces removed, so it means the same for languages written without spaces (Japanese, Chinese, Thai). Both WER and CER can exceed 100% when a rung inserts many words, which usually means it looped; the report adds a note with a sample when insertions exceed the reference length.

### Alignment and timing

WER, timing and punctuation all come from a Levenshtein alignment that keeps substitutions, deletions and insertions apart (ties: match or substitution, then deletion, then insertion). Segments have start and end times but not per-word times, so each word gets a start interpolated by its position in its segment. Timing error is the median and p90 of the absolute start difference over exactly matched words.

### Punctuation and capitalization F1

Words are aligned on their letters. For each exactly matched word, the mark that ends it (`.`, `,`, `?`, `!` or none; `;` and `:` count as `,`) and whether it starts upper case are compared with the reference. The first word is skipped for capitalization.

### Citation accuracy

A citation passes when its quote, normalized as above with fillers kept and at least three words long, occurs as a contiguous word run of the transcript starting within plus or minus N seconds (default 30) of the cited time. Failures say why: `not-found`, `wrong-time` (with where the quote really is), `quote-too-short`, `no-transcript`.

### Retrieval

A hit is relevant when it overlaps an expected range of the same video. precision@k, recall@k (expected ranges covered by a top-k hit) and MRR.

### Cost

Local, free-tier and keyless rungs cost 0. Paid rungs are priced from the table in `src/metrics/cost.ts` (audio minutes or tokens), which only lists vendor-published prices; a paid rung that is not listed reports `unpriced` instead of a guess.

## References

A reference is a real human transcript downloaded once and stored as JSON (`RecordedRef` in `src/refs.ts`): `<platform>-<id>.<origin>.<language>.json`. `packages/evals/datasets/refs/README.md` lists every committed file and where it came from. The stt suite looks for a reference in this order:

1. `referenceFile` named in the dataset entry (used for the local Apollo 11 clip, whose resolved id depends on file timestamps).
2. A committed file in `datasets/refs/`, then the local cache (`.vid2context/cache/evals/refs/`).
3. `referenceUrl`: a subtitle file the publisher hosts. The 14 NASA items point at the SRT NASA publishes next to each video in its Image and Video Library (`images-assets.nasa.gov`); the audio comes from the same library. Neither depends on YouTube.
4. YouTube creator captions through the pipeline (`getVideoContext` with `mode: 'captions'` and `allowAuto: false`), so a translated or auto track can never be mistaken for a reference.

Only public-domain (NASA) and CC-licensed (TED, TEDx) references are committed: entries marked `storeReference: true`, which `--record` writes into `datasets/refs/`. Videos under the standard YouTube license are listed too, but their captions are fetched at run time and cached locally, never redistributed in this repository.

When YouTube rate-limits caption downloads from your IP (HTTP 429), references for YouTube items that are not committed or cached cannot be fetched; the report names the cause per item (`captions-blocked`). The NASA library items and the Apollo clip are not affected, which is why they come first in `stt.json`.

## Adding a dataset entry

Add an object to the suite's file in `packages/evals/datasets/`:

```json
{
  "id": "nasa-sea-level",
  "url": "https://www.youtube.com/watch?v=WadD54Ywvz4",
  "title": "Why is Sea Level Rising? We Asked a NASA Scientist",
  "channel": "NASA",
  "language": "en",
  "durationSec": 98,
  "why": "Climate science vocabulary spoken by a scientist, not a narrator.",
  "tags": ["en", "interview", "jargon"],
  "license": "NASA video: ...",
  "reference": "creator-captions"
}
```

Check that the video has a creator track in `language` (the YouTube captions provider's `listTracks` shows `creator-captions` versus `auto-captions`), keep it between 1 and 6 minutes, say in `why` what it adds, and record the license honestly. For a public-domain or CC video add `"storeReference": true`, run with `--record` once and commit the new file in `datasets/refs/` with a line in its README. The loader rejects malformed entries with a message naming the field.

For media outside YouTube, point `url` at the media file and `referenceUrl` at the publisher's own SRT or WebVTT file (https only), as the NASA library entries do. For a published human transcript that is not a subtitle file, set `"reference": "human-transcript"` and `referenceFile` to a file you write in `datasets/refs/` (with its `source` URL and a README line).

## Regression checks

`packages/evals/thresholds.json` holds per-suite, per-rung limits (`maxWer`, `maxCer`, `maxP90LatencyMs`, `maxTimingMedianSec`, `minPunctuationF1`). `--check` exits 1 when a scored rung breaks one. Rungs with no successful items are not checked, so a missing key or an outage is not a regression. Local CI (prompt 38) decides whether to run it.

## Results

### 2026-11-14: search and citations

Run on this repository's VM with only free and keyless rungs (`policy free`, no paid keys). Raw results: `packages/evals/results/2026-11-14-search.json` and `2026-11-14-citations.json`, with Markdown reports next to them.

**search**: `datasets/search.json`, 15 labeled queries over part 1 of the G-Wagon series (one 18-minute video, 521 auto-caption segments).

| Mode | Queries | Precision@5 | Recall@5 | MRR | p50 latency | p90 latency |
|---|---|---|---|---|---|---|
| keyword (BM25) | 15 | 24.2% | 100.0% | 0.967 | 3 ms | 8 ms |
| hybrid (BM25 + Cloudflare `@cf/baai/bge-m3`) | 15 | 22.7% | 100.0% | 0.922 | 242 ms | 290 ms |

Every labeled range was in the top 5 for both modes. On one video, hybrid ranked the right range lower than keyword alone for `m278-engine` and `g63-power`, so vectors did not help on this collection. A multi-video collection is needed before the comparison says much.

**citations**: `datasets/citations.json`, 8 questions over the same video. Both producers were answered by `llm/cloudflare/@cf/meta/llama-3.3-70b-instruct-fp8-fast` (free tier).

| Producer | Questions | Citation accuracy | Expected place hit | Self-rejected | p50 LLM latency | p90 LLM latency |
|---|---|---|---|---|---|---|
| ask | 8 | 100.0% (14 / 14) | 100.0% | 0.0% | 2.6 s | 4.5 s |
| brief | 8 | 96.2% (50 / 52) | 87.5% | 5.5% | 23.5 s | 45.5 s |

Reading these numbers: `ask` quotes are transcript excerpts it chooses from the numbered sources, not text the model writes, so its citation accuracy is high by construction; the meaningful number is that all 8 questions got a citation on the labeled place. `brief` quotes are written by the model and verified by insights with an 80% fuzzy word overlap; 2 of the 50 claims insights accepted fail this suite's exact-quote check (`g55-oil` and `add-tech`), and `add-tech` produced 15 cited claims, none on the labeled CarPlay passage. Those are findings for prompt 32 (brief), not fixed here.

### Not yet measured

The `stt`, `captions` and `cleanup` suites need creator-caption references from YouTube. During this session YouTube answered every caption download from this VM with HTTP 429 (automated-traffic block, through both the innertube client and yt-dlp), so no WER table has been produced yet. The pipeline itself was verified end to end on "Me at the zoo" (whose creator captions are already recorded in the shared fixtures): audio through yt-dlp, three free and keyless rungs, scoring and report. That smoke run is not a results table: one 19-second clip is too small to compare rungs.

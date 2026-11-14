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
| `--record` | save creator captions fetched during the run into `datasets/refs/` instead of the cache |
| `--live` | same as `LIVE=1` |

The runner refuses to start without `LIVE=1` or `--live`: it calls real services, uses your free quotas and needs the network, and it should never look like it produced numbers when it did not. The metric code is unit-tested offline with `npx vitest run packages/evals`.

Each run writes `packages/evals/results/<YYYY-MM-DD>-<suite>.json` (every per-item score, the rung, its attempts, a short sample of the hypothesis, and an environment summary without secrets) and a Markdown report next to it, and prints the report to stdout. Progress and warnings go to stderr.

Rung selection is free first. Without `--rungs`, every enabled local, free-tier and keyless rung is scored on its own, so the keyless OVH Whisper rung works with zero setup. Rungs that are not enabled are listed as skipped with the env var that would enable them; they never count as failures. Paid rungs are skipped unless named.

Audio and fetched references are cached under `.vid2context/cache/evals/` (or `$VID2CONTEXT_HOME/cache/evals/`), so a rerun downloads nothing it already has.

## Suites

### stt

For each video in `datasets/stt.json`: get the creator-caption reference, download the audio once through whichever installed source can supply it (the yt-dlp provider for YouTube), then transcribe it with each selected rung through core's `transcribeLong`. That is the same path the product uses, so rungs with short limits (OVH keyless accepts 60 seconds per request) receive split audio, and rate limits are waited out rather than failed.

Per rung it reports WER and CER (pooled: total errors over total reference words or characters), substitutions, deletions and insertions, the median word start-time difference against the reference, p50 and p90 latency (the sum of `attempts[].ms` of the successful speech-to-text calls), the real-time factor (latency over audio length) and cost.

### captions and cleanup

For each video in `datasets/captions.json`, YouTube's auto-captions are scored against the creator captions of the same video: WER, CER, timing, and punctuation and capitalization F1. The `cleanup` suite adds a second row per video with core's `cleanTranscript` (the rule-based steps, no LLM) applied to the auto-captions, so the effect of cleanup on every metric is visible side by side. The raw track is never replaced.

### citations and search

The datasets exist (`citations.json`, `search.json`, labeled on the recorded G-Wagon transcript and verified by a unit test), and so do the metrics (`checkCitation`, `citationAccuracy`, `precisionAtK`, `recallAtK`, `reciprocalRank`). The runner suites need a producer of cited answers (prompt 32's briefs or prompt 34's ask) and the search engine (prompt 40). Until those packages export what the suites call, the runner says so and skips these suites.

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

A reference is a real caption track downloaded once and stored as JSON (`RecordedRef` in `src/refs.ts`): `<platform>-<id>.<origin>.<language>.json`.

- Creator captions are fetched through the pipeline (`getVideoContext` with `mode: 'captions'` and `allowAuto: false`), so a translated or auto track can never be mistaken for a reference.
- Only public-domain (NASA) and CC-licensed (TED, TEDx) references are committed in `datasets/refs/`. Videos under the standard YouTube license are listed in the datasets too, but their captions are fetched at run time and cached locally, not redistributed in this repository.
- Auto-caption references (for `captions` and `cleanup`) must be recorded: no captions provider lets a caller ask for the auto track when a creator track exists. Adding an `origin` option to `CaptionOptions` would let `--record` capture them too.

When YouTube rate-limits caption downloads from your IP (HTTP 429), references that are not committed or cached cannot be fetched. The report names the cause per item (`captions-blocked`).

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

Check that the video has a creator track in `language` (the YouTube captions provider's `listTracks` shows `creator-captions` versus `auto-captions`), keep it between 1 and 6 minutes, say in `why` what it adds, and record the license honestly. For a public-domain or CC video, run with `--record` once and commit the new file in `datasets/refs/` with a line in its README. The loader rejects malformed entries with a message naming the field.

## Regression checks

`packages/evals/thresholds.json` holds per-suite, per-rung limits (`maxWer`, `maxCer`, `maxP90LatencyMs`, `maxTimingMedianSec`, `minPunctuationF1`). `--check` exits 1 when a scored rung breaks one. Rungs with no successful items are not checked, so a missing key or an outage is not a regression. Local CI (prompt 38) decides whether to run it.

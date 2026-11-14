# @vid2context/evals

Accuracy, citation, retrieval, latency and cost evaluation for vid2context, on real public videos and real rungs. Full documentation: [docs/evals.md](../../docs/evals.md).

```sh
LIVE=1 npm run eval -- --suite stt --limit 3      # WER per enabled speech-to-text rung
LIVE=1 npm run eval -- --suite captions           # YouTube auto-captions vs creator captions
LIVE=1 npm run eval -- --suite cleanup            # the same, plus core cleanup
LIVE=1 npm run eval -- --suite citations          # cited answers (ask) and briefs (insights)
LIVE=1 npm run eval -- --suite search             # keyword and hybrid transcript search
LIVE=1 npm run eval -- --suite stt --rungs stt/ovh/whisper-large-v3-turbo --check
npx vitest run packages/evals                     # metric tests, offline
```

Results land in `results/<YYYY-MM-DD>-<suite>.json` and `.md`. Without `LIVE=1` (or `--live`) the runner exits with code 2 and evaluates nothing.

The metrics are exported for other packages' tests:

```ts
import { wordErrorRate, timingError, punctuationF1, checkCitation, retrievalScore } from '@vid2context/evals';

wordErrorRate(creatorText, sttText, { language: 'en' }); // { rate, substitutions, deletions, insertions, ... }
```

| Path | What |
|---|---|
| `datasets/` | `stt.json`, `captions.json`, `citations.json`, `search.json`, and recorded references in `refs/` |
| `src/metrics/` | normalization, alignment, WER and CER, timing, punctuation F1, chapters, citations, retrieval, cost |
| `src/suites/` | the stt, captions, cleanup, citations and search suites |
| `src/run.ts` | the `npm run eval` entry point |
| `thresholds.json` | regression limits for `--check` |

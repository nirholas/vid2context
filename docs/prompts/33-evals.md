# 33. Evaluation harness: accuracy, citations, latency and cost

| | |
|---|---|
| Track | I. Deploy and quality |
| You own | `packages/evals/` |
| Shared edits allowed | root `package.json`: add an `eval` script only |
| Commit scope | `evals` |
| Runs alongside | 49 other prompts in the same folder; depends only on the foundation |

vid2context turns any video into context for AI agents: transcripts, metadata, chapters and cited briefs, free-first, as a CLI, MCP server, HTTP API and web app. It picks among many free and keyless speech-to-text and LLM rungs, cleans captions, and promises citations that point at the right second of the right video. Enterprise users will ask "how accurate is it, and which rung should I trust?". This prompt builds the harness that answers with numbers: word error rate per speech-to-text rung against real ground truth, citation accuracy for briefs and answers, retrieval quality, latency and cost. The trick that keeps it honest and free: YouTube videos with creator-uploaded captions give a real human reference transcript to score against.

## Read first

1. `CLAUDE.md` and `AGENTS.md`, then `docs/ARCHITECTURE.md`.
2. `packages/core/src/types.ts`, `packages/core/src/provider.ts`, `packages/core/src/pipeline.ts` (`getVideoContext`, `transcribe`, attempts), `packages/core/src/chain.ts` (`runChain`, `only` option for pinning one rung), and `packages/core/src/testing.ts`.
3. `docs/providers.md` (every rung and its env var) and `tests/fixtures/README.md` (shared real fixtures: `tests/fixtures/media/apollo11-small-step.mp3`, `tests/fixtures/contexts/*.json`).
4. `docs/prompts/SHARED-CONTRACTS.md` section 8 (shared files), section 9 (data directory `.vid2context/cache`).

## Goal

`npm run eval -- --suite <name> [--rungs <ids>]` runs a real evaluation against real public videos and real rungs, and writes a dated JSON result plus a Markdown report. The metric code is unit-tested on real transcript pairs. The first real results table is published in `docs/evals.md`.

## Requirements

### Datasets (`packages/evals/datasets/`)

- JSON files listing real public videos with the ground truth each suite needs. Each entry: input URL, why it was chosen (accent, music, jargon, length), license or terms note, and the reference source.
- `stt.json`: 10 or more short (1 to 6 minute) videos that have creator-uploaded captions in a known language, chosen for variety (clean speech, accents, background music, technical vocabulary, at least two non-English). The creator captions are the reference.
- `captions.json`: videos with both creator captions and YouTube auto-captions, to score auto-captions and the caption cleanup (prompt 02) against the creator text.
- `citations.json`: a small set of questions over a real collection (start with the G-Wagon series fixture `youtube-cCPsdFdlshc.json` plus more parts you record), used to score briefs (prompt 32) and ask (prompt 34) when those packages exist.
- `search.json`: labeled queries with expected time ranges you verify by reading the transcripts, for retrieval scoring (prompt 40) when present.
- Record reference transcripts once (real caption downloads through the pipeline) into `packages/evals/datasets/refs/` so scoring does not depend on YouTube availability. Document each file.

### Metrics (`src/metrics/`)

- WER and CER with a documented normalization (lowercase, strip punctuation, normalize numbers and whitespace, optional filler removal), via Levenshtein alignment at word and character level; report substitutions, deletions and insertions separately.
- Timestamp alignment error: for aligned words or segments, the median and p90 absolute start-time difference.
- Punctuation and capitalization F1 for cleanup output versus creator captions.
- Chapter boundary agreement (precision and recall within plus or minus N seconds) for auto-chapters when `packages/chapters` exists.
- Citation accuracy: the fraction of citations whose quote appears in the transcript within plus or minus N seconds of the cited time (reuse `verifyCitations` from prompt 32 if it has landed, otherwise implement the same check locally).
- Retrieval: precision@k, recall@k and MRR.
- Latency (from `attempts[].ms`) and cost (usage tokens or audio seconds times a documented price table for paid rungs; zero for free, keyless and local).

### Runner (`src/run.ts`, `npm run eval`)

- Flags: `--suite stt|captions|cleanup|citations|search|all`, `--rungs <comma-separated rung ids>` (pin each rung with chain option `only`), `--limit`, `--out`, `--json`.
- Uses the real pipeline and real rungs only. Live network is required: the runner refuses to start without `LIVE=1` or an explicit `--live` and says why.
- Caches downloaded audio and references under `.vid2context/cache/evals/` so reruns are cheap and polite.
- Writes `packages/evals/results/<YYYY-MM-DD>-<suite>.json` (raw per-item scores, rung, attempts, environment summary without secrets) and a Markdown report with one table per suite (rung, items, WER, CER, p50 and p90 latency, cost).
- Regression thresholds in `packages/evals/thresholds.json`; `--check` exits nonzero when a pinned rung regresses beyond them, so prompt 38's `npm run ci` can enforce it opt-in.
- Rungs that are not enabled (missing key) are skipped with the env var name, never failed.

### Suites that depend on other prompts

- `cleanup`, `citations`, `search` and chapter agreement need packages from prompts 02, 32, 34, 40 and 35. Build the harness and the suites whose dependencies exist; before finishing, check again for `packages/core/src/clean`, `packages/insights`, `packages/ask`, `packages/search`, `packages/chapters`, wire what exists, and list what does not in your report.

## Prefer free and local

Default rung selection is whatever the free-first chain enables: local rungs if configured, free tiers when their keys are set, and the keyless OVH Whisper rung, which works with zero setup. Paid rungs run only when explicitly named in `--rungs` and their key is set.

## Out of scope

- Fixing accuracy problems you find: report them (with numbers) for the owning prompt.
- CI wiring: prompt 38 (local CI) decides whether to run `--check`.
- The search engine, briefs and ask implementations themselves (prompts 40, 32, 34).

## Tests

- Metric unit tests on real transcript pairs: the creator captions versus the auto-captions of the same real video (record both, store in `packages/evals/test/fixtures/` with a README line). Assert WER is within a sane range, that identical texts score 0, and that the substitution, deletion and insertion counts add up to the alignment.
- Normalization tests on real caption lines (numbers, contractions, bracketed tags such as `[Music]`).
- Alignment error tests using real segment timings from the two fixture transcripts.
- Report generation: render a Markdown report from a real results JSON you produced.
- No network in unit tests. The runner itself is exercised by a `LIVE=1` test on one short video and the keyless OVH rung.

## Acceptance criteria

- [ ] `npx tsc -p tsconfig.json --noEmit 2>&1 | grep -E 'packages/evals'` prints nothing.
- [ ] `npx vitest run packages/evals` passes; `npx biome check packages/evals` is clean.
- [ ] `LIVE=1 npm run eval -- --suite stt --limit 3` runs end to end with the keyless rung and writes a JSON result and a Markdown report.
- [ ] `docs/evals.md` contains the first real results table you produced, with the date, dataset size and rungs.
- [ ] Running without `LIVE=1` exits with a clear message instead of pretending.

## Docs

- `docs/evals.md`: what each suite measures, how references are obtained, normalization rules, how to add a dataset entry, how to run, and the first real results.
- `packages/evals/README.md`: quick usage.

## If credentials, tools or network are missing

Use the keyless OVH rung and any local rung. Rungs without keys are reported as skipped. If the network is unavailable, build and unit-test the metrics on recorded real transcript pairs, do not produce a results table, and say clearly in the report that no live evaluation was run.

<!-- COMMON -->

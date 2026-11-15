# 02. Caption and transcript cleanup

| | |
|---|---|
| Track | A. Core bones |
| You own | `packages/core/src/clean/` |
| Shared edits allowed | `packages/core/src/pipeline.ts` (apply the repetition-loop guard to speech-to-text output only, and record it in `attempts`); one `export *` line in `packages/core/src/index.ts` |
| Commit scope | `clean` |
| Runs alongside | 49 other prompts in the same folder; depends only on the foundation |

vid2context turns any video into context for AI agents: transcripts, metadata, chapters and cited briefs, free-first, as a CLI, MCP server, HTTP API and web app. Two kinds of raw text reach agents today and both read badly. YouTube auto-captions arrive as unpunctuated, rolling windows that repeat words across cues (see the real `cCPsdFdlshc` asr fixture). Whisper-style speech-to-text sometimes loops: the keyless OVH rung returned "really, really, really..." dozens of times in a live test, and that loop is in a committed fixture. Cleaner text reads better and wastes fewer tokens. This prompt builds the cleanup layer as pure, runtime-neutral functions that return new values and a report, and hooks the one safety fix that must always run (the repetition guard) into the pipeline. The raw transcript is never changed in place: cleaned output is an added layer.

## Read first

1. `CLAUDE.md` and `AGENTS.md` (operating rules and commands), then `docs/ARCHITECTURE.md`.
2. `packages/core/src/types.ts` (`Segment`, `Transcript`, `Attempt`), `packages/core/src/provider.ts`, and `packages/core/src/testing.ts` (`replayFetch`, `testContext`).
3. `packages/core/src/pipeline.ts` (`transcribe`, `getVideoContext`, `chat`) and `packages/core/src/segments.ts` (`decodeEntities`, `segmentsToText`).
4. `providers/youtube/src/timedtext.ts` (`parseSrv3`, `parseSrv1`, exported from the provider) and the fixtures in `providers/youtube/test/fixtures/` (`timedtext-cCPsdFdlshc-en-asr.srv3.xml` is real rolling asr).
5. `providers/stt-openai-compatible/test/fixtures/ovh-whisper-large-v3-turbo.verbose.json` and its `README.md` (the real repetition loop).
6. `tests/fixtures/README.md` and `tests/fixtures/contexts/youtube-cCPsdFdlshc.json` (521 real auto-caption segments).
7. `docs/prompts/SHARED-CONTRACTS.md`, sections 7 (fixtures) and 8 (shared files).

## Goal

`cleanTranscript(transcript, opts)` returns `{ transcript, report }`: a new transcript with rolling duplicates removed, Whisper loops collapsed, entities and tags normalized, sentences and paragraphs restored for unpunctuated text, and an optional LLM punctuation pass that is verified never to change the words. The pipeline runs the repetition guard on every speech-to-text result and says so in `attempts`.

## Requirements

### Shape and purity

- Every function takes values and returns new values. Never mutate the input `Transcript` or its `segments` array (assert this in tests with a deep-frozen input).
- Every function returns or contributes to a `CleanReport`: counts of segments merged, removed, flagged and rewritten, plus a bounded list of examples (`{ atSec, before, after, rule }`, at most 20) so a human can audit the change.
- Export everything from `packages/core/src/clean/index.ts`, and add `export * from './clean/index.ts';` to `packages/core/src/index.ts` (re-read the file first). Prefix exported names so they cannot collide with other prompts' core exports (for example `cleanTranscript`, `dedupeRollingCaptions`, `guardRepetition`).

### Functions

- `dedupeRollingCaptions(segments)`: YouTube asr srv3 tracks overlap: a cue often repeats the tail of the previous cue, or the same words appear in consecutive windows with shifted times. Detect the longest suffix of the previous segment that is a prefix of the next (on normalized words) and drop it from the next; drop segments that become empty; keep the earliest start time for merged words. Test it on the real `cCPsdFdlshc` asr fixture.
- `guardRepetition(segments, opts?)`: detect an n-gram (n from 1 to 6) repeated more than `k` times in a row (default `k = 4`) inside a segment or across adjacent segments, and collapse it to at most two occurrences followed by nothing else; detect a segment that is mostly one token (over 70 percent); mark the collapsed segment with `confidence` lowered (for example to 0.2) and report it. Normal speech repetition such as "very very good" or "no, no, no" must survive (thresholds tuned on real data, documented). Also flag, never silently delete, the known Whisper hallucination lines that appear on silence at the end of audio ("Thanks for watching", "Subtitles by", "Please subscribe" and similar) when they sit in a low-information tail segment.
- `normalizeCaptionText(segments, opts?)`: decode entities with `decodeEntities`, collapse whitespace, normalize curly quotes only when asked, and handle bracketed tags (`[Music]`, `[Applause]`, `[Laughter]`, `(inaudible)`): keep them as tags by default, or remove them with `opts.tags = 'remove'`.
- `restoreSentences(segments)`: rule-based sentence boundaries and capitalization for unpunctuated text: capitalize after a boundary and the pronoun "I", end sentences at long pauses (gap of 0.8 s or more) or at discourse markers when a segment ends, never invent words. Leave text that already has punctuation alone (detect by punctuation density).
- `groupParagraphs(segments, opts?)`: paragraphs by pauses (1.5 s or more) and length (about 120 words), returned as `{ startSec, endSec, text }[]` for formatters and the pack.
- `removeFillers(segments)`: off by default; removes "um", "uh", "erm" and similar standalone fillers only, never words like "like" or "so".
- `punctuateWithLlm(transcript, registry, ctx, opts?)`: chunk the text (about 1500 words per chunk with a few words of overlap), ask the core `chat` chain (`packages/core/src/pipeline.ts`) to add punctuation and capitalization only, and verify each returned chunk: after lowercasing and stripping punctuation, the word sequence must equal the input word sequence. A chunk that fails verification keeps the original text and is counted in the report. Map punctuated text back onto segment boundaries by word index, so timings stay exact.
- `cleanTranscript(transcript, opts)`: composes the above in a fixed, documented order (normalize, dedupe rolling for `auto-captions`, guard repetition for `stt` and `video-model`, sentences for unpunctuated text, optional fillers, optional LLM pass) and returns `{ transcript, report }`. The returned transcript keeps `origin`, `producer` and `ref`.

### Pipeline hook (shared edit)

- In `packages/core/src/pipeline.ts`, right after a speech-to-text transcript is produced (the `transcribe` result), run `guardRepetition` and, when it changed anything, push one attempt: `{ id: 'clean/repetition-guard', stage: 'stt', outcome: 'ok', detail: 'collapsed N segments' }`. Re-read the file immediately before editing: prompts 04, 10, 21, 22 and 42 also make small edits there. Keep your edit to a few lines and do not reformat the file.
- Do not run any other cleanup automatically. The rest is opt-in for surfaces.

## Prefer free and local

All cleanup except `punctuateWithLlm` is local and free. The LLM pass uses the normal rung chain, so local rungs come first, then free tiers, then keyless lanes; with no rung configured it fails with the chain's `no-provider` error and the hint, and `cleanTranscript` without the LLM option works fully offline.

## Out of scope

- Output formats (Markdown paragraphs, SRT, VTT, the pack): prompt 01. They may use `groupParagraphs` later; do not edit `packages/core/src/format/`.
- Chunking and token budgets: prompt 03.
- Long-audio stitching and overlap dedupe between chunks: prompt 04.
- Translation and auto-chapters: prompt 35.

## Tests

Put tests in `packages/core/test/clean/`.

- Rolling dedupe: parse `providers/youtube/test/fixtures/timedtext-cCPsdFdlshc-en-asr.srv3.xml` with the provider's exported `parseSrv3` (import from `@vid2context/provider-youtube`), run `dedupeRollingCaptions`, and assert that no adjacent pair shares a repeated suffix/prefix of 3 or more words, that the total word count drops, and that every remaining word appears in source order.
- Repetition guard: load the real OVH verbose_json fixture, map its segments, run `guardRepetition`, and assert the loop collapses to at most two occurrences and the report lists it. Use real transcript lines that contain natural repetition from `tests/fixtures/contexts/youtube-cCPsdFdlshc.json` and assert they are untouched.
- Purity: deep-freeze the input transcript and assert nothing throws and the input is unchanged.
- Sentences: on the real auto-caption fixture, assert sentence-initial capitals appear, no words are added or removed, and already punctuated creator captions (`youtube-jNQXAC9IVRw.json`) come back unchanged.
- LLM pass: record one real response from a keyless rung (OVH or Pollinations) with `LIVE=1` into `packages/core/test/fixtures/clean/` (document it in that folder's `README.md`), then replay it through `replayFetch` in a unit test and assert word-sequence verification passes; also replay a recorded response that changed words (record by asking the model to rephrase, or keep a real response that drifted) and assert that chunk is rejected and the original kept.
- Pipeline hook: run `transcribe` with a `testContext` whose fetch replays the real OVH loop fixture and assert the `clean/repetition-guard` attempt appears and the segments are collapsed.

## Acceptance criteria

- [ ] `npx tsc -p tsconfig.json --noEmit 2>&1 | grep -E 'packages/core/src/(clean|pipeline)'` prints nothing.
- [ ] `npx vitest run packages/core/test/clean` passes, and the existing core tests still pass (`npx vitest run packages/core`).
- [ ] `npx biome check packages/core/src/clean packages/core/test/clean` is clean.
- [ ] On the real `cCPsdFdlshc` context, `cleanTranscript` reduces the estimated token count (report the before and after numbers) while every original word that is not a rolling duplicate is still present.
- [ ] Running a real local mp3 (`tests/fixtures/media/apollo11-small-step.mp3`) through the keyless STT path with `LIVE=1` shows no regression: the guard leaves a clean transcript unchanged.

## Docs

- Create `docs/cleanup.md`: what each function does, the default order, thresholds and why, and a short real before/after example from each fixture.

## If credentials, tools or network are missing

Everything except the LLM pass and the live checks works offline on committed fixtures. If no keyless rung is reachable, ship `punctuateWithLlm` only if you could record at least one real response; otherwise leave it out, keep the rest, and say so in your report.

## Repo rules (binding, same as AGENTS.md)

- Never use the em-dash or en-dash characters: not in code, comments, docs, UI copy or commit messages. Use commas, colons, periods or parentheses. No emojis.
- No mocks, fake data, placeholders, TODOs, stub functions or "coming soon" text. If a piece cannot be built for real now, leave it out and say so in your final report.
- Tests use real data only: fixtures recorded from the real service, replayed through `replayFetch` and `testContext` from `@vid2context/core/testing`, or live calls gated by `LIVE=1` (`describe.skipIf(!process.env.LIVE)`). A unit test must never reach the network. Every fixture gets a line in its folder's `README.md` saying where and when it was recorded.
- Core code and providers never read `process.env` or the global `fetch`: use the `ctx` passed to every call. Log through `ctx.log` (stderr). stdout is program output and the MCP stdio channel.
- Prefer plain `fetch` over vendor SDKs. `packages/core` and every provider that declares the `workers` or `browser` runtime must not import Node built-ins.
- Every error a user can see is a `Vid2ContextError` with a stable `code` and a `hint` that says how to recover.
- Free first: local, then free tiers with the user's own key, then keyless hosts, and paid services last, only when their key is set. Every model id is overridable by env. New env vars go into `.env.example` and `docs/providers.md` in the same commit.
- Keep raw transcripts. Cleaned text, summaries, translations and briefs are added layers, never replacements.
- TypeScript, ESM, explicit `.ts` import extensions, Biome formatting (`npx biome check --write <your paths>`).

## Working in a shared folder

You are one of 50 agents working at the same time in this folder, each owning different directories.

- Create and edit files only inside the directories this prompt says you own, plus the shared edits listed in its header. Keep shared edits small and additive, and re-read a shared file immediately before every edit: another agent may have changed it a minute ago. `docs/prompts/SHARED-CONTRACTS.md` section 8 lists who may edit which shared file.
- If the foundation code differs from what this prompt describes, the code wins: read it and adapt. If something you need from another prompt has not landed yet, build everything else first and check again before you finish. If it is still missing, leave that piece out and list it in your report. Never stub it.
- Dependencies go only into your own package's `package.json`. Install through the shared lock so parallel installs cannot corrupt `node_modules`: `mkdir -p .vid2context/locks && flock .vid2context/locks/npm npm install -w <your package dir> <name>@<version>`. Never hand-edit `package-lock.json`; if it conflicts, rerun the install through the lock. Never edit `packages/registry/src/generated/`; run `npm run gen` instead.
- Other agents' unfinished work can break the repo-wide `npm run typecheck` and `npm test`. Judge your own paths: `npx tsc -p tsconfig.json --noEmit 2>&1 | grep -E '<your dirs>'` prints nothing, `npx vitest run <your dirs>` passes, `npx biome check <your dirs>` is clean. Do not fix other agents' files; mention breakage you saw in your report.
- Never run commands that touch other agents' work: `git add -A`, `git add .`, `git commit -a`, `git stash`, `git reset`, `git checkout -- <path>`, `git restore`, `git clean`, `git rebase`, `git push`.
- Servers you start for testing: pick a random port between 20000 and 29999, and stop them when you are done.

## Committing

The owner asks you to commit your own work as described here. Commit each coherent piece as soon as it works, not only at the end.

1. `git status --short` and check that every path you will commit is yours.
2. `flock .vid2context/locks/git git add <explicit paths>` (needed for new files).
3. Commit only your paths, which leaves anything other agents staged untouched:
   `flock .vid2context/locks/git git commit -m "<type>(<scope>): <what changed and why it matters>" -m "<body: what and why, in plain language>" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" -- <explicit paths>`
   (use the Co-Authored-By trailer your harness specifies if it names a different model).
4. `git show --stat HEAD` and confirm only your files are in the commit.

Types: feat, fix, refactor, perf, test, docs, chore. Never use subjects like "update" or "wip". Do not push. Never amend or rewrite a commit you did not make.

## Final report

Finish with a short report to the owner: what you built (paths), what you verified live and how, what you could not verify and why (missing key, tool or network), every shared-file edit you made, what the integration pass needs to wire up, and any breakage you noticed outside your directories.

# 30. Gemini: video understanding and audio transcription

| | |
|---|---|
| Track | F. Intelligence |
| You own | `providers/video-gemini/` |
| Shared edits allowed | `docs/providers.md` and `.env.example` (your rows and variables only) |
| Commit scope | `gemini` |
| Runs alongside | 49 other prompts in the same folder; depends only on the foundation |

vid2context turns any video into context for AI agents: transcripts, metadata, chapters and cited briefs, free-first, as a CLI, MCP server, HTTP API and web app. Captions and speech-to-text only capture what is said. Many videos carry the important part on screen: spec sheets in a car review, slides in a talk, code in a tutorial, prices in a chart. The pipeline already has a `video` mode that hands the whole video to a multimodal rung and gets back a transcript plus `VisualNote`s, but no rung implements it. Gemini can watch a public YouTube video directly from its URL on the free AI Studio tier, which makes this the cheapest way to get on-screen content. This prompt adds the Gemini video rung and, using the same API, a Gemini audio transcription rung (absorbing roadmap item 21).

## Read first

1. `CLAUDE.md` and `AGENTS.md`, then `docs/ARCHITECTURE.md` (the pipeline's `video` mode).
2. `packages/core/src/types.ts` (`VisualNote`, `Transcript` with origin `video-model`, `Segment`), `packages/core/src/provider.ts` (`VideoRung`, `VideoUnderstandingResult`, `SttRung`, `rungs(env)`), `packages/core/src/pipeline.ts` (how `mode: 'video'` calls video rungs and uses their transcript and visual notes), `packages/core/src/keys.ts`, `packages/core/src/testing.ts`.
3. `providers/stt-openai-compatible/` as a reference rung provider.
4. `docs/contracts/providers.md`, `docs/providers.md` (the "Planned" video row), `tests/fixtures/README.md`.
5. `docs/prompts/SHARED-CONTRACTS.md`, sections 7, 8 and 9.

## Goal

`npm run cli -- <youtube url> --mode video` returns a `VideoContext` whose transcript has origin `video-model` with validated timestamps, and whose `visual` notes list the slides, on-screen text, code and charts with times; and a Gemini speech-to-text rung joins the speech-to-text chain.

## Requirements

### Package

- `@vid2context/provider-video-gemini`, default-exporting a `VideoProvider` (id `video-gemini`) and an `SttProvider` (id `stt-gemini`), both building rungs from `rungs(env)`. Runtimes `node`, `workers`, `browser` for URL and inline paths; the Files API upload path is Node only (keep it in a module the edge paths never import, or gate it on `ctx.runtime` with a dynamic import).
- Auth lanes: AI Studio `GEMINI_API_KEY` with `GEMINI_FALLBACK_KEYS` pools (tier `free`), and Vertex AI (`GOOGLE_CLOUD_PROJECT`, `GOOGLE_CLOUD_LOCATION`, token from `GOOGLE_ACCESS_TOKEN`, or on Node from the GCE metadata server when `VID2CONTEXT_GCE_METADATA=1`) as tier `paid`, only if verified live from the owner's GCP VM.
- Models: `GEMINI_VIDEO_MODEL` (default the current free-tier Flash model that accepts video; verify today) and `GEMINI_STT_MODEL` (default a Flash-Lite model if it transcribes well). Rung ids `video/gemini/<model>`, `stt/gemini/<model>`.

### Video rung

- `supports(ref)`: public YouTube videos (direct URL as `file_data.file_uri`), and any ref with downloadable media on Node (upload through the Files API with resumable upload, poll until `ACTIVE`, delete after use), or inline bytes when under the inline size limit.
- Request: `generateContent` with the video part, `generationConfig.responseMimeType: 'application/json'` and a `responseSchema` for `{ language, segments: [{ start, end, text, speaker? }], visual: [{ at, kind: 'slide'|'code'|'chart'|'ocr'|'description', text }] }` (times as seconds, or `MM:SS` strings converted by you; pick what the model returns most reliably and document it). The prompt asks for a verbatim transcript and for on-screen text copied exactly, not paraphrased. `opts.focus` (from `VideoRung.understand`) adds a focus instruction ("spec sheets and prices").
- Long videos: `mediaResolution` low (and a lower sampling fps where the API allows) above a duration threshold, to stay inside the token limit; document the threshold and the token cost per minute you measured.
- Validation: drop segments with times beyond the video duration, enforce ascending non-overlapping times (repair small overlaps, drop nonsense), reject the whole result (throw `upstream` so the chain moves on) if fewer than a minimal fraction of the duration is covered or text is empty. Mark transcript origin `video-model`, producer the rung id, model the model id.
- Map visual notes to `VisualNote` with `producer` set; merge consecutive identical notes.

### Speech-to-text rung

- Takes `AudioInput` (inline bytes under the limit; Files API on Node above it; `url` inputs fetched then sent), asks for timestamped segments via the same JSON schema approach, validates times against the audio duration, capabilities `segments`, `language-detect`, and `diarization` only if the speaker labels prove reliable in your tests (otherwise leave it out). `maxBytes` set from the inline and Files API limits.
- Quality and priority below Groq Whisper (Whisper timestamps are more precise); document measured differences on the shared Apollo clip.

### Errors

- Safety or recitation blocks, missing candidates, `RESOURCE_EXHAUSTED` (rate-limited with retry info), `PERMISSION_DENIED` (auth), private or unavailable YouTube videos (`unavailable`, with a hint that only public videos work by URL) all become `Vid2ContextError`s with hints.

## Prefer free and local

AI Studio's free tier is the default lane. Paid Vertex only with credentials and paid allowed. Mention in the guide that video mode sends the video to Google, unlike captions mode.

## Out of scope

- Frame sampling, OCR and other vision models: prompt 31. Native Gemini chat rungs: prompt 26. Rendering visual notes: prompt 01.

## Tests

- Record real responses into `providers/video-gemini/test/fixtures/` (README per file; scrub keys): a video understanding response for a short public YouTube video with clear on-screen text (pick one, record its id and why), an audio transcription of `tests/fixtures/media/apollo11-small-step.mp3`, a Files API upload sequence if you implement it, and one real error (unavailable video or rate limit).
- Unit tests with `replayFetch`: request building per input kind, schema, time parsing, validation and repair (feed the recorded response and also a copy of the real response with the duration lowered in the test input, to exercise out-of-range dropping), visual note mapping, error mapping, rung construction from env.
- LIVE tests (with a key): video mode end to end through `getVideoContext` with `mode: 'video'`, and the STT rung through `transcribe`.

## Acceptance criteria

- [ ] `npx tsc -p tsconfig.json --noEmit 2>&1 | grep -E 'providers/video-gemini'` prints nothing.
- [ ] `npx vitest run providers/video-gemini` passes; `npx biome check providers/video-gemini` is clean.
- [ ] With `GEMINI_API_KEY`, `npm run cli -- <your test video> --mode video --format json` shows a `video-model` transcript and visual notes whose times you spot-checked against the video.
- [ ] The workers registry does not pull in the Files API Node module.

## Docs

- `docs/guides/gemini-video.md`: what video mode captures, privacy note, cost and limits measured, how to focus it, Vertex setup.
- Replace the "Planned" video row in `docs/providers.md`; add `GEMINI_VIDEO_MODEL`, `GEMINI_STT_MODEL` and Vertex variables to `.env.example` (check whether prompt 26 already added shared Google variables, and do not duplicate them).

## If credentials, tools or network are missing

Without `GEMINI_API_KEY` you cannot record anything: do not write responses from the docs. Ship nothing you could not verify, report that a free AI Studio key is needed, and describe exactly what remains.

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

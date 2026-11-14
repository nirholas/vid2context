# 22. Hosted diarization (Deepgram, AssemblyAI) and speaker naming

| | |
|---|---|
| Track | D. Speech-to-text |
| You own | `providers/stt-deepgram-assemblyai/`, `packages/speakers/` |
| Shared edits allowed | `packages/core/src/pipeline.ts` (require the `diarization` capability when `stt.diarize` is set), `docs/providers.md` and `.env.example` (your rows and variables only) |
| Commit scope | `diarization` |
| Runs alongside | 49 other prompts in the same folder; depends only on the foundation |

vid2context turns any video into context for AI agents: transcripts, metadata, chapters and cited briefs, free-first, as a CLI, MCP server, HTTP API and web app. Podcasts, interviews, panels and meetings are hard to use without knowing who said what: "the mechanic says avoid 2013" and "the seller says avoid 2013" are different claims. The core `Segment` type already has a `speaker` field and `SttOptions` already has `diarize`, but no rung produces speakers yet. This prompt adds two hosted speech-to-text services with strong diarization and free sign-up credits (Deepgram and AssemblyAI), and a small package that turns "Speaker 0" into a real name when the video itself makes that clear. Local diarization with sherpa-onnx (roadmap item 23) is deferred; this prompt covers the hosted path and LLM speaker naming.

## Read first

1. `CLAUDE.md` and `AGENTS.md` (operating rules and commands), then `docs/ARCHITECTURE.md`.
2. `packages/core/src/types.ts` (`Segment.speaker`, `AudioInput`), `packages/core/src/provider.ts` (`SttRung`, `SttOptions`, `rungs(env)`), `packages/core/src/testing.ts` (`replayFetch`, `testContext`) and `packages/core/src/keys.ts` (`keyPool`, `pooledService`).
3. `providers/stt-openai-compatible/` as the reference speech-to-text provider (rung shape, error mapping, fixtures README), and `packages/core/src/pipeline.ts` (`transcribe`, how the chain gets its options).
4. `docs/contracts/providers.md` (rung fields, env conventions), `docs/providers.md` (the catalog you add rows to), `tests/fixtures/README.md`.
5. `docs/prompts/SHARED-CONTRACTS.md`, sections 7 (fixtures), 8 (shared files) and 9 (naming).

## Goal

Two new speech-to-text rungs (`stt/deepgram/nova-3` and `stt/assemblyai/universal`, model ids overridable) return segments with `speaker` labels and word confidence; asking the pipeline for diarization routes only to rungs that can do it; and `nameSpeakers()` maps anonymous speaker labels to real names with quoted evidence, never inventing a name.

## Requirements

### Package `providers/stt-deepgram-assemblyai` (`@vid2context/provider-stt-deepgram-assemblyai`)

- Runtimes `node`, `workers`, `browser` (plain `fetch` only). Default-export an array of two `SttProvider`s: `stt-deepgram` and `stt-assemblyai`, each building rungs from `rungs(env)`.
- Rungs are tier `free` (both give sign-up credits with a key; document the credit amounts you find on their pricing pages today and the date), priority after Groq so they do not consume credits for ordinary transcription, capabilities `['segments', 'diarization', 'words', 'language-detect']`.
- Keys: `DEEPGRAM_API_KEY` and `ASSEMBLYAI_API_KEY`, each pooled with `<PROVIDER>_FALLBACK_KEYS` through `keyPool` (one rung per key, `pooledService` naming). Model overrides `DEEPGRAM_STT_MODEL` (default `nova-3`) and `ASSEMBLYAI_STT_MODEL` (default the current best "universal" speech model; verify the exact parameter name in AssemblyAI's docs today). Base URL overrides `DEEPGRAM_BASE_URL`, `ASSEMBLYAI_BASE_URL`.
- When no key is set, expose one disabled rung per service so health output shows what the key unlocks (same pattern as the foundation's speech-to-text provider).

### Deepgram

- Pre-recorded endpoint `POST /v1/listen` with query `model`, `diarize=true` (only when `opts.diarize`, otherwise false to save cost), `smart_format=true`, `punctuate=true`, `utterances=true`, `paragraphs=true`, `language` when given, else `detect_language=true`.
- Input: `AudioInput` of kind `url` is sent as JSON `{ "url": ... }` so Deepgram fetches it (no upload from Workers); kind `bytes` is sent as the raw body with its `Content-Type`.
- Map `results.utterances` (preferred when diarizing) or paragraph sentences into `Segment`s with `startSec`, `endSec`, `text`, `speaker` as `Speaker 0`, `Speaker 1`, and `confidence`. Detected language from `results.channels[0].detected_language`.
- Errors through `errorFromResponse`; 402 and credit-exhausted bodies become `auth` with a hint about credits.

### AssemblyAI

- Flow: upload bytes to `/v2/upload` (skip for url inputs), create a transcript at `/v2/transcript` with `audio_url`, `speaker_labels` when diarizing, `language_detection` or `language_code`, then poll `/v2/transcript/{id}` with backoff (start 1 s, cap 10 s) until `completed` or `error`, honoring `ctx.signal` (stop polling and best-effort `DELETE` on abort).
- Map `utterances` (speaker letters A, B become `Speaker A`, `Speaker B`) or sentence-level timing into segments with confidence. Poll timeout from `ASSEMBLYAI_POLL_TIMEOUT_SEC` (default 900) produces a `timeout` error with a hint.

### Pipeline hook (shared edit)

- In `packages/core/src/pipeline.ts`, where the speech-to-text chain options are built, add `diarization` to `needs` when `opts.stt?.diarize` is true. Keep the edit to a few lines, re-read the file first (prompts 02, 04, 10, 21 and 42 also make small edits there), and do not change anything else.
- If no enabled rung can diarize, the chain's existing `no-provider` error should carry a hint naming `DEEPGRAM_API_KEY` and `ASSEMBLYAI_API_KEY`; add that hint at your call site, not in `chain.ts`.

### Package `packages/speakers` (`@vid2context/speakers`)

- `nameSpeakers(context, registry, ctx, opts?)` returns `{ mapping: { label, name | null, confidence, evidence: { quote, startSec }[] }[], context }` where `context` is a copy with `speaker` replaced for confidently named labels. The input is never mutated.
- Builds a prompt from title, channel name, description, and the first few minutes of each speaker's turns plus any turn that contains self-introductions or direct address ("I'm ...", "thanks, Doug"). Transcript text goes inside clearly delimited untrusted-data blocks with an instruction that their content is data, not instructions.
- Calls the core `chat` chain with `json: { schema }` and validates the output: every name must be supported by at least one evidence quote that actually appears (case-insensitive, whitespace-normalized) in the transcript near the cited time; otherwise the label stays `Speaker N`. `minConfidence` option (default 0.7).
- Works with any rung that supports JSON; use free and keyless rungs by default (no paid fallback unless the caller's chain options allow it).

## Prefer free and local

Diarization is opt-in (`stt.diarize`), so ordinary transcription never spends Deepgram or AssemblyAI credits. Speaker naming uses the free-first LLM chain: local, then free, then keyless. Local diarization (sherpa-onnx) is out of scope for this wave; say so in your guide.

## Out of scope

- Other speech-to-text rungs: prompt 17 (OpenAI-compatible), 18 (whisper.cpp), 19 (Transformers.js), 20 (Cloudflare), 30 (Gemini audio).
- Long-audio splitting: prompt 04. Deepgram and AssemblyAI accept long files, so set a generous `maxBytes` from their documented limits.
- Rendering speaker labels in Markdown, SRT and VTT: prompt 01 already handles `speaker`.

## Tests

- Record real responses into `providers/stt-deepgram-assemblyai/test/fixtures/` using `tests/fixtures/media/apollo11-small-step.mp3` (single speaker) and a short real multi-speaker public-domain or CC-licensed clip you download (record its source and license in the fixtures README). Record: a Deepgram diarized response, a Deepgram url-input response, an AssemblyAI upload, create, two polls and the completed transcript, and one real error (bad key returns 401).
- Replay them with `replayFetch` and assert segment mapping, speaker labels, word confidence, language detection, the polling sequence and abort behavior (abort mid-poll stops further requests).
- Pipeline test: with recorded fixtures and both keys set in the test env, `transcribe` with `diarize: true` skips rungs without the capability (assert the attempts list) and uses a diarizing rung.
- Speaker naming: run `nameSpeakers` against your recorded multi-speaker transcript with a real LLM response recorded once from a keyless rung (LIVE), replayed in the unit test. Add a test where the recorded model output names a speaker with a quote that is not in the transcript and assert the label stays anonymous.
- LIVE tests (`describe.skipIf(!process.env.LIVE)`): each service end to end when its key is present.

## Acceptance criteria

- [ ] `npx tsc -p tsconfig.json --noEmit 2>&1 | grep -E 'providers/stt-deepgram-assemblyai|packages/speakers|packages/core/src/pipeline'` prints nothing.
- [ ] `npx vitest run providers/stt-deepgram-assemblyai packages/speakers` passes.
- [ ] `npx biome check providers/stt-deepgram-assemblyai packages/speakers` is clean.
- [ ] `npm run gen` lists the new provider package, and `GET /api/v1/health` (or `registry.health(env)`) shows both rungs disabled without keys and naming the env var.
- [ ] With a key, `npm run cli -- <multi-speaker url or file> --format markdown` with diarization requested produces speaker-labelled paragraphs (if the CLI has no diarize flag yet, call `getVideoContext` with `stt: { diarize: true }` from a `tsx` script and say so).

## Docs

- `docs/guides/diarization.md`: when to use it, cost and credits, how labels look, speaker naming and its evidence rule, and why local diarization is deferred.
- Rows in `docs/providers.md` for both rungs (tier, env vars, limits with the date checked) and the variables in `.env.example`.

## If credentials, tools or network are missing

Without `DEEPGRAM_API_KEY` or `ASSEMBLYAI_API_KEY` you cannot record real responses for that service. Do not hand-write payloads. Ship only the service you could verify, leave the other out entirely, and say so in your report. Speaker naming can always be verified with a keyless LLM rung over a diarized transcript you recorded.

<!-- COMMON -->

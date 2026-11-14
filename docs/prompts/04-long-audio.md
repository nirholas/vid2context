# 04. Long audio: split, transcribe in parallel, stitch, resume

| | |
|---|---|
| Track | A. Core bones |
| You own | `packages/core/src/longform/` |
| Shared edits allowed | `packages/core/src/audio-split.ts` and `packages/core/src/storage-ext.ts` (create from SHARED-CONTRACTS 1.3 and 1.1 if missing); `packages/core/src/pipeline.ts` (use longform when audio exceeds every enabled rung's `maxBytes`; additive `splitters?: AudioSplitter[]` option); one `export *` line per new module in `packages/core/src/index.ts` |
| Commit scope | `longform` |
| Runs alongside | 49 other prompts in the same folder; depends only on the foundation |

vid2context turns any video into context for AI agents: transcripts, metadata, chapters and cited briefs, free-first, as a CLI, MCP server, HTTP API and web app. When a video has no captions, vid2context downloads the audio and runs a free-first speech-to-text chain. Hosted Whisper endpoints cap uploads (Groq at 25 MB), and today the pipeline simply skips rungs whose `maxBytes` is too small, so a 3-hour podcast or lecture fails. This prompt builds the long-audio orchestrator: split audio into chunks that fit, transcribe them in parallel across rungs so one rate limit does not stall the job, stitch the results with exact timestamps, and resume after a crash. It must run on Node and on Cloudflare Workers, so the built-in splitters are pure TypeScript.

## Read first

1. `CLAUDE.md` and `AGENTS.md`, then `docs/ARCHITECTURE.md` (pipeline section).
2. `packages/core/src/types.ts` (`AudioInput`, `Segment`, `Transcript`, `Attempt`), `packages/core/src/provider.ts` (`SttRung`, `maxBytes`, `ChainOptions`), `packages/core/src/testing.ts`.
3. `packages/core/src/pipeline.ts` (`transcribe`, `fetchAudio`, `getVideoContext`), `packages/core/src/chain.ts` (`runChain`, `rankRungs`, cooldowns), `packages/core/src/storage.ts`.
4. `docs/contracts/providers.md` (rung and storage contracts).
5. `docs/prompts/SHARED-CONTRACTS.md`, sections 1.1 (`storage-ext.ts`), 1.3 (`audio-split.ts`), 7 and 8.
6. `tests/fixtures/README.md` (`tests/fixtures/media/apollo11-small-step.mp3`, 24 s, mono 16 kHz, 48 kbps, public domain) and `providers/stt-openai-compatible/test/fixtures/README.md`.

## Goal

`transcribeLong(registry, ref, audio, opts, ctx)` turns audio of any length into one `Transcript` with correct global timestamps, using every enabled speech-to-text rung in parallel, checkpointing each finished chunk so a rerun skips it. `getVideoContext` uses it automatically when the audio is larger than every enabled rung accepts.

## Requirements

### Shared contract files

- `packages/core/src/audio-split.ts` and `packages/core/src/storage-ext.ts`: if missing, create them exactly as SHARED-CONTRACTS sections 1.3 and 1.1 show, following its procedure (commit each on its own right away). Use them as is.

### Built-in splitters (runtime-neutral, implementing `AudioSplitter`)

- `mp3FramesSplitter` (id `mp3-frames`): skip ID3v2 tags (size from the synchsafe header), detect and skip a Xing/Info/VBRI header frame, walk MPEG-1/2/2.5 Layer III frame headers (bitrate and sample-rate tables, padding bit, frame length formula), cut only on frame boundaries, compute time from frame counts (1152 or 576 samples per frame), handle VBR and free-format errors (resync on the next valid header), and keep each chunk at most `maxBytes`. Prefer cuts near `targetSec`; MP3 frame splitting cannot detect silence cheaply, so state that in the docs.
- `wavPcmSplitter` (id `wav-pcm`): parse RIFF chunks (`fmt `, `data`, skip unknown chunks such as `LIST`), slice PCM on sample-frame boundaries, write a correct 44-byte header per chunk. Optionally pick cut points at the lowest-energy window near `targetSec` (cheap RMS over 20 ms frames): WAV can do real silence detection, so do it.
- Overlap: each chunk after the first starts `overlapSec` (default 2 s) before the previous chunk's end; record `overlapSec` on the chunk.
- Other containers (m4a, aac, opus, ogg, webm, mp4): no built-in splitter. Prompt 12 builds an ffmpeg-based `AudioSplitter` for Node; it arrives through the `splitters` option. Without a capable splitter, fail with `Vid2ContextError('too-large')` and a hint naming the fix (install the yt-dlp and ffmpeg providers so audio arrives as small mono MP3, or pass an ffmpeg splitter).
- `AudioInput` of kind `url`: fetch with `ctx.fetch` into bytes with a size cap (`VID2CONTEXT_MAX_AUDIO_MB`, default 1024) before splitting.

### Orchestrator `transcribeLong`

- Plan: rank enabled STT rungs with `rankRungs(registry.sttRungs(ctx.env), chain, ctx.env)`; choose the chunk byte limit from the smallest `maxBytes` among the top rungs that will be used (rungs without `maxBytes` accept any size), with a 5 percent margin; target about 10 minutes per chunk.
- Run chunks with bounded concurrency (`opts.concurrency`, default 3). Spread chunks across rungs so one rung's rate limit does not stall everything: each chunk calls `runChain` with an `only`/order that starts at a different rung (round-robin over the ranked list) and falls back along the rest. Cooldowns from `chain.ts` apply naturally.
- Offset every segment by the chunk's `startSec`. Stitch overlaps: align words in the overlap window of chunk N and chunk N+1 (normalized words, longest common run), drop the duplicate words from the later chunk, and cut at the midpoint of the aligned run. If alignment fails, cut at the overlap midpoint by time and report it.
- Merge `attempts` from every chunk (prefix detail with `chunk i/n`), and return `{ transcript, attempts, chunks: n }`. `transcript.producer` names the rung that produced most chunks; `transcript.model` likewise; `language` is the majority language.
- Progress: an optional `onProgress({ done, total, message })` callback, matching the job progress shape in `docs/contracts/http-api.md`.
- Abort: honour `ctx.signal`; stop scheduling new chunks and reject with the abort reason.

### Resume

- Checkpoint each finished chunk's segments in a `KvStore`: `hasKv(storage) ? storage : new MemoryKv()`, key `longform:<refId>:<audioSha256>:<chunkIndex>` (sha256 via `crypto.subtle`), TTL 7 days. A rerun with the same audio skips finished chunks and reports them as `outcome: 'ok', reason: 'resumed'` attempts.

### Pipeline hook (shared edit)

- Add `splitters?: AudioSplitter[]` to `GetContextOptions` and to the `transcribe` options. In `transcribe` (or right before it is called), when the audio is bytes and larger than every enabled rung's `maxBytes` that the chain would use, call `transcribeLong` with the built-in splitters plus `opts.splitters`. Re-read `pipeline.ts` right before editing (prompts 02, 10, 21, 22 and 42 edit it too); keep the change small and do not reformat.

## Prefer free and local

Splitting is local. Parallel transcription uses the normal free-first chain: local rungs first, then free tiers (Groq), then the keyless OVH lane. Note in the docs that OVH keyless allows about 2 requests per minute per IP, so a long file on keyless alone is slow but works; adding a free Groq key makes it fast.

## Out of scope

- The ffmpeg splitter and audio normalization (prompt 12, `packages/ffmpeg`).
- Speech-to-text rungs themselves (prompts 17 to 20, 22).
- The jobs system and SSE progress (prompt 42); you only expose `onProgress`.
- Caption cleanup (prompt 02); its repetition guard runs on your stitched output in the pipeline.

## Tests

Put tests in `packages/core/test/longform/`, fixtures in `packages/core/test/fixtures/longform/` with a `README.md`.

- MP3 splitter on the real `tests/fixtures/media/apollo11-small-step.mp3` with a small `maxBytes` (for example 40 KB): assert every chunk starts with a valid frame header, durations sum to the file duration within one frame, byte sizes are within the cap, overlaps are as configured.
- A longer real public-domain recording for stitching (a LibriVox or NASA mp3 of a few MB at most; record source and license in the fixtures README), split into 3 or 4 chunks; record the real OVH keyless response for each chunk once with `LIVE=1`, then replay them through `replayFetch` and assert stitched timestamps are monotonic, no duplicated words at the seams, and the text matches a single-pass transcript in word overlap (report the measured similarity).
- WAV splitter: convert the apollo clip to WAV once with ffmpeg (document the command), commit it, and assert header correctness and silence-aware cut points.
- Resume: run with a `MemoryKv`, abort after the first chunk (via `AbortController`), rerun, and assert only the remaining chunks hit the network (count `replayFetch.calls`).
- Unsupported container without a splitter: assert the `too-large` error and hint.

## Acceptance criteria

- [ ] `npx tsc -p tsconfig.json --noEmit 2>&1 | grep -E 'packages/core/src/(longform|pipeline|audio-split|storage-ext)'` prints nothing.
- [ ] `npx vitest run packages/core/test/longform` passes, and `npx vitest run packages/core` still passes.
- [ ] `npx biome check packages/core/src/longform packages/core/test/longform` is clean.
- [ ] With `LIVE=1`, a real 30-minute or longer public-domain MP3 transcribes end to end through the keyless chain (or a free key if present); report duration, chunk count, wall time and rungs used.

## Docs

- Create `docs/long-audio.md`: when longform kicks in, splitters and their limits, concurrency and rung spreading, stitching, resume keys, and real timings from your live run.

## If credentials, tools or network are missing

Splitters and stitching tests run offline on committed fixtures. If no STT rung is reachable to record per-chunk responses, ship the splitters and the orchestrator only with tests you could back by real recordings; report the live run as not done.

<!-- COMMON -->

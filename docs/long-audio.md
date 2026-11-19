# Long audio

Hosted speech-to-text services cap what one request may carry: Groq and OpenAI take 25 MB, and the keyless OVH lane takes 60 seconds of audio. The long-audio orchestrator in [packages/core/src/longform/](../packages/core/src/longform/) splits audio into chunks that fit, transcribes them in parallel across rungs, stitches the results with exact timestamps, and saves each finished chunk so a rerun after a crash skips it. It is pure TypeScript and runs on Node, Workers and in the browser.

```ts
import { transcribeLong } from '@vid2context/core';
const { transcript, attempts, chunks, seams } = await transcribeLong(registry, ref, audio, { onProgress }, ctx);
```

## When it kicks in

`transcribe()` (and so `getVideoContext`) hands audio to `transcribeLong` in three cases:

1. The audio is bytes and breaks a declared limit of every rung the chain would use: larger than its `maxBytes`, or, when the audio's length is known (`durationSec`), longer than its `maxDurationSec`. The keyless OVH rung declares 10 MB and 60 s, so on keyless alone a file of known length over 60 s is split before anything is sent.
2. The single-pass request failed and every rung refused it as too large (HTTP 413). This is how a file of unknown length over 60 s reaches the orchestrator on the keyless lane. The duration limit stated in the 413 message ("max duration allowed ... is 60 seconds") is passed on, so no second request is spent rediscovering it.
3. The single-pass answer holds a decoder loop (see [Decoder loops](#decoder-loops)): the audio is transcribed again in two overlapping chunks.

Audio given as a URL is downloaded with `ctx.fetch`, capped by `VID2CONTEXT_MAX_AUDIO_MB` (default 512 on Node, 64 on Workers), before splitting.

## Splitters

A splitter implements `AudioSplitter` from [packages/core/src/audio-split.ts](../packages/core/src/audio-split.ts). Splitters passed in `splitters` are tried first, then the built-in ones, then the registry's (`Registry.splitters`). The Node registry (`createRegistry()` from `@vid2context/registry/node`, which the CLI, HTTP server and MCP server use) adds `ffmpeg-silence` from `@vid2context/ffmpeg` there, so on Node every container is covered whenever ffmpeg and ffprobe are installed: X posts arrive as m4a, which no built-in splitter can cut.

| Splitter | Containers | How it cuts |
|---|---|---|
| `mp3-frames` | MP3 (MPEG-1, 2 and 2.5 Layer III, CBR or VBR) | Skips ID3v2 tags, the Xing/Info/VBRI frame and an ID3v1 trailer; walks frame headers and cuts only on frame boundaries, so each chunk is a valid MP3. Time comes from frame counts (1152 or 576 samples per frame), exact for VBR. Damaged bytes and free-format frames are skipped by resyncing on the next confirmed header. It cannot hear silence without decoding, so cuts land near the even split point; the overlap and the stitcher cover a word on the cut. |
| `wav-pcm` | WAV: 8, 16, 24, 32-bit integer PCM and 32-bit float, any channel count | Reads `fmt ` and `data`, skips `LIST` and other chunks, writes a fresh 44-byte header per chunk and cuts on sample frames. It measures loudness (RMS over 20 ms blocks) and moves each cut to the quietest block within about 10 percent of the chunk length of the even split point. |

Other containers (m4a, aac, opus, ogg, webm, mp4) have no built-in splitter. On Node the registry's `ffmpeg-silence` splitter cuts them (it re-encodes each chunk as 16 kHz mono MP3 and cuts at silences). Without ffmpeg (Workers, the browser, or Node with no ffmpeg found), `transcribeLong` fails with `too-large` and the hint: install the yt-dlp and ffmpeg providers so audio arrives as small mono MP3, or pass an ffmpeg splitter in `splitters`.

Chunks are even in length: the planner divides the audio into the fewest chunks that respect both the byte limit and the target length (about 10 minutes, `targetSec`), and never lets one exceed `maxBytes`. Each chunk after the first starts `overlapSec` (default 2 s) before the previous one ends, rounded to whole frames or blocks.

## Rungs, concurrency and limits

- The chunk byte limit is the smallest `maxBytes` among the rungs that start chunks, less 5 percent. A rung may also declare `maxDurationSec` (an optional `SttRung` field; OVH keyless declares 60); chunks then stay under 95 percent of it.
- `concurrency` (default 3) chunks run at once. Chunk `i` starts at rung `i mod k`, where `k` is the number of top-ranked rungs used to start chunks (at most `concurrency`), and falls back along the rest of the ranked list. One rung's rate limit then does not stall every chunk, and the chain's cooldowns apply as usual.
- When every rung for a chunk is rate limited or cooling down, the chunk waits (10 s steps) and retries instead of failing, up to `rateLimitWaitMs` (default 10 minutes). The 429s are kept in `attempts`, but the cooldown skips of each waiting round are not: one `rate-limit-wait` attempt says how long the chunk waited in total. Only cooldowns that end on their own count (a rate limit, a 5xx, a timeout; see `cooldownReason` in chain.ts): a rung cooling down after a rejected key would come back rejected, so the chunk does not wait for it.
- Chunks are planned for the top-ranked rungs. When those fail in ways a smaller piece cannot fix (a rejected key, a cooldown) and the only rungs left declare a shorter `maxDurationSec` than the chunk, the chunk is split again under the shortest of those caps. A bad key on a first-ranked rung then costs one request, not the job.
- When every rung refuses a chunk as too large, the orchestrator learns the limit (from the error message, or half the chunk), splits that chunk again and stitches its pieces. Later chunks longer than the learned limit are split before they are sent.

The free-first order still holds: local rungs first, then free tiers (Groq), then the keyless OVH lane. OVH keyless allows about 2 requests per minute per IP and 60 s per request, so a long file on keyless alone is slow but finishes: about one minute of audio per 30 s of wall time once the rate limit is the bottleneck. Adding a free Groq key (`GROQ_API_KEY`) makes it fast: 25 MB covers well over an hour of 32 kbps mono MP3 per request.

## Stitching

Each chunk's segments are offset by the chunk's start time. At each seam:

1. Every word gets a time: the rung's own word times when it attaches them to segments (`words: [{ startSec, endSec }]`, shifted to the global timeline along with the segment), else the segment's span divided by character count.
2. The words near the overlap in both chunks are compared after normalization (lowercase, letters and digits only). The longest common run of at least two words marks the duplicate; chunk N keeps its words up to the middle of that run and chunk N+1 keeps the rest. Seam reason: `aligned`.
3. If either side has no words inside the overlap (the cut fell in a pause, or the model heard nothing there), nothing is duplicated and both sides keep every word. Seam reason: `silence`.
4. Otherwise both sides are cut at the middle of the overlap by time, and a warning is logged. Seam reason: `time-cut`.

Segments that keep all their words keep their original text and times. Only the segments at a seam are trimmed. Each seam is reported as an attempt with id `longform/stitch`, and in `seams` on the result.

The stitched transcript then goes through the repetition guard ([cleanup.md](cleanup.md)), the same one the single-request path runs, for loops that run across a seam and sign-off lines invented on silence at the end.

## Decoder loops

Whisper-style decoders sometimes get stuck and write one phrase over and over ("issuance of issuance of ..." for 45 seconds), and the real speech under the loop is lost. Cutting the loop back afterwards hides the junk but not the gap, so each piece is checked as it arrives (`hasDecoderLoop`: the repetition guard would cut text out) and a looped piece is sent again:

1. To the other rungs, one at a time, skipping every rung whose answer for this piece already looped (`repetition-loop` attempts name them).
2. Split in two overlapping parts at new cut points (`loop-resplit`). A loop is tied to the exact audio the decoder heard, so the halves usually come back clean. Each half is checked the same way but never split again for a loop, so a stubborn loop costs a few requests, not a cascade. Pieces under 8 s (`MIN_LOOP_SPLIT_SEC`) are not split.
3. When every retry still loops, the first answer is kept with the loop cut back, and a `clean/repetition-guard` attempt with reason `loop-kept` says that the speech under it is missing.

The single-request path does the same at its level: a looped answer for the whole file sends the file through `transcribeLong` in two chunks (`splitLoops: false`, so those chunks try the other rungs and are then kept). Audio no splitter can cut falls back to cutting the loop back, as before. Set `splitLoops: false` on `transcribeLong` to turn step 2 off.

## Attempts and progress

Attempts from every chunk are merged and prefixed `chunk i/n` (`chunk i/n part j/m` for pieces of a re-split chunk). The splitter adds a `split` attempt, a re-split adds a `resplit` attempt, and a loop adds `repetition-loop`, `loop-resplit` and, when nothing escaped it, `loop-kept` attempts. `transcript.producer` and `model` name the rung that produced the most chunks, and `language` is the majority language. `onProgress({ done, total, message })` follows the job progress shape in [contracts/http-api.md](contracts/http-api.md). `ctx.signal` stops new chunks from being scheduled, and the call rejects with the abort reason.

## Resume

Each finished chunk is saved in a `KvStore` (the `kv` option; else `storage` when it implements `KvStore`; else a process-local `MemoryKv`) under:

```
longform:<refId>:<sha256 of the audio bytes>:<chunkIndex>
```

for 7 days. A rerun with the same audio and the same chunk plan reads finished chunks back (a saved chunk is used only when its start and length match) and reports them as `outcome: 'ok', reason: 'resumed'` attempts. With a persistent store (SQLite, D1), a crashed three-hour job resumes where it stopped.

## Measured

Recorded tests (`packages/core/test/longform/`, real OVH keyless responses):

- 58 s LibriVox clip in 3 chunks of about 21 s: both seams were `silence` (cuts in pauses), timestamps monotonic, nothing duplicated, and 0.885 word similarity (2 x LCS / total words) to a single-pass transcript of the same clip. The gap is Whisper's: it skipped the 10-second LibriVox disclaimer when it heard chunk 1 alone.
- 90 s clip: one request refused with 413 (60 s cap), re-split into 45 s and 47 s pieces, which overlap on "to the decisive campaign which freed" and stitch as `aligned` with one copy kept. With the cap declared on the rung, the same two pieces are planned up front: 2 requests, none refused.
- 58 s clip where chunk 2 first answers with the recorded OVH loop: chunk 2 (21.3 s) is split into halves of 10.7 s and 12.6 s that overlap by 2 s, which OVH transcribes cleanly ("Campaigns of the Civil War", "commanding the I Corps at Gettysburg"), so the final transcript holds the real speech and no loop. 5 requests in all.

Live run on 2026-11-14 (`LIVE=1 npx vitest run packages/core/test/longform/live.test.ts`), no keys set, so the keyless OVH lane only:

| | |
|---|---|
| Audio | LibriVox, "Chancellorsville and Gettysburg" chapter 7 (CC0), 35:37, 64 kbps MP3, 17 MB, fetched by URL |
| Plan | 4 chunks of about 9 minutes, concurrency 3 |
| What happened | The first chunks were refused with 413 (60 s cap), so every chunk was re-split into pieces of at most 57 s: 40 successful requests in all, waiting through 429s between them |
| Wall time | 2,877 s (48 min), about 1.35 s of wall time per second of audio |
| Rungs used | `stt/ovh/whisper-large-v3-turbo` only |
| Seams | 39 in all: 36 `aligned`, 1 `silence`, 2 `time-cut` |
| Output | 287 segments, 6,047 words, last segment ending at 35:25, timestamps monotonic |

Keyless works but it is slow, because the 60-second cap and the 2 requests per minute make the IP's rate limit the bottleneck (other jobs from the same IP share it). If a rung declares `maxDurationSec: 60`, the first wave of 413s is skipped. A free Groq key would send each 9-minute chunk in a single request.

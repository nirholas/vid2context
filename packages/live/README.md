# @vid2context/live

Transcribe a live stream while it is still running. Point it at a live YouTube video or any HLS (`.m3u8`) stream and it yields timed transcript lines about every 30 seconds, for as long as the stream runs, until `maxMinutes` pass, or until you cancel. When the stream ends it returns the whole transcript.

**Node only.** Chunks are cut with ffmpeg (through `@vid2context/ffmpeg`: `FFMPEG_PATH`, then `PATH`, then `~/.local/bin`). The main entry has no Node imports; the ffmpeg extractor lives in `@vid2context/live/node`.

```ts
import { createNodeContext, createRegistry } from '@vid2context/registry/node';
import { createFfmpegExtractor, formatLiveLine, watchLive } from '@vid2context/live/node';

const ctx = createNodeContext();
const deps = { registry: createRegistry(), ctx, extractAudio: createFfmpegExtractor({ env: ctx.env }) };
for await (const e of watchLive('https://www.youtube.com/watch?v=M3HKLzjvKPc', { maxMinutes: 10 }, deps)) {
  if (e.type === 'segment') console.log(formatLiveLine(e)); // [449:45:12 | 17:05:31Z] text
  if (e.type === 'status') console.error(e.message);
  if (e.type === 'done') console.error(`${e.reason}: ${e.transcript.segments.length} segments`);
}
```

## Events

| Event | Fields |
|---|---|
| `segment` | `segment` (`startSec`, `endSec`, `text`) in stream time; `at`, the wall-clock time (ISO 8601) when the stream carries `EXT-X-PROGRAM-DATE-TIME`; `resumeSequence` |
| `status` | `code` and `message`: `started`, `keyless-only`, `rung` (which rung transcribed a span, and any rung that was cooling down or failed first), `stt-retry`, `skipped`, `missed`, `resume-gap`, `playlist-error`, `refreshed`, `ended`, `stopping` |
| `done` | `transcript` (a core `Transcript`, origin `stt`), `reason` (`ended`, `max-minutes`, `cancelled`, `lost`), `resumeSequence` |

Options: `maxMinutes` (default: until the stream ends), `chunkSec` (30), `overlapSec` (2), `maxLagSec` (120), `catchUpChunks` (3), `language`, `signal`, `fromSequence`, `chain` (rung policy, `only`, `skip`).

Stream time is the media sequence number times the segment duration. On YouTube that is the time since the broadcast began (sequence 0 is the start), so it stays the same across restarts. Lines are formatted `[stream time | UTC]`.

## How it works

1. **Resolve.** A YouTube video goes through the innertube player (ANDROID client), whose response carries `streamingData.hlsManifestUrl` while the video is live (verified on NASA's ISS streams, 2026-11-14). The master playlist is reduced to its cheapest audio: an audio-only rendition when there is one, else the lowest-bandwidth variant whose `CODECS` include an audio codec. Any URL that serves an HLS playlist is used directly. A video that is not live, a playlist that already has `EXT-X-ENDLIST`, or an encrypted stream is refused with a hint pointing at the normal pipeline (`get_transcript`, `GET /api/v1/transcript`, `vid2context <url>`). For inputs another source understands (for example yt-dlp's catch-all), that source's metadata decides whether the video is live.
2. **Poll.** A producer reloads the media playlist every target duration (half of it when nothing changed, RFC 8216 6.3.4), downloads new segments in `EXT-X-MEDIA-SEQUENCE` order, and never fetches a sequence twice. Segments that left the playlist before they could be fetched are reported as `missed`. `EXT-X-ENDLIST` ends the watch. YouTube's signed URLs expire after about six hours; they are re-resolved before that, or on a 403/404.
3. **Chunk.** The consumer cuts `chunkSec` windows; each repeats the last `overlapSec` of the previous one so a word cut at the boundary is heard whole once. ffmpeg cuts the exact span out of the concatenated segments as 16 kHz mono WAV.
4. **Transcribe.** Each chunk goes through the core `transcribe`, so the free-first speech-to-text chain, cooldowns and attempts apply exactly as in the normal pipeline. Segment times are shifted to stream time.
5. **Dedupe.** Words at the start of a chunk that repeat the end of what was already emitted are dropped (a word-level match that tolerates a garbled first word and a cut last word; when nothing matches, segments that lie entirely inside the overlap are dropped instead).
6. **Backpressure.** Polling and transcription run concurrently, so a slow request never makes the poller miss segments (YouTube's live playlist holds only about 30 seconds). When transcription is two chunks or more behind, the next request takes up to `catchUpChunks` chunks at once, so a rate-limited rung needs fewer requests. When it is more than `maxLagSec` behind, the buffer skips ahead to the live edge and a `skipped` status names the span, so memory stays bounded (about `maxLagSec` of the lowest-bitrate media, under 2 MB at the default).
7. **Resume.** Every event carries `resumeSequence`. Pass it back as `fromSequence` after a restart; if those segments already left the playlist, a `resume-gap` status says how much was lost.

## Which speech-to-text rungs keep up

A stream needs one request per `chunkSec` (two per minute at the default) and about 32 seconds of audio per 30 seconds of stream (the overlap adds about 7 %).

| Rung | Keeps up? | Cost of a long stream |
|---|---|---|
| Local (`LOCAL_STT_BASE_URL`, whisper.cpp) | Yes, when the model runs faster than real time on your machine (whisper.cpp small is about 5x real time on a CPU VM, base.en about 25x). Lowest latency, nothing leaves the machine. | Free. |
| Groq free tier (`GROQ_API_KEY`) | Yes. Base limits are 20 requests per minute and 7,200 audio seconds per hour, so one stream (about 3,840 audio seconds per hour) fits. 2,000 requests per day is about 16 hours of streams. | Free. |
| Cloudflare Workers AI (`CLOUDFLARE_ACCOUNT_ID` + `CLOUDFLARE_API_TOKEN`) | Yes. | Free up to 10,000 neurons a day; at about 47 neurons per audio minute that is roughly 3 hours of stream a day. |
| OVH keyless (no key) | Only barely, and not for long: it allows about 2 requests per minute per IP, exactly the default chunk rate, so the first retry or overlap pushes it over. The watcher then reports the 429 and the cooldown in `status` events and merges chunks to catch up, at the cost of latency. | Free. Use it for a few minutes; set a free Groq key or a local rung for anything longer. |
| Paid (OpenAI, DeepInfra, Together) | Yes. Used only when their key is set and no free rung answered. | Billed per audio minute: about 64 audio minutes per stream hour. DeepInfra lists about $0.0002 per minute (about $0.013 per stream hour); check each provider's current price. |

The watcher emits a `keyless-only` status at the start when the keyless rung is the best one available.

## Surfaces

- MCP: `registerLiveTools(server, { registry, ctx, extractAudio })` adds `watch_live { url, maxMinutes? }` (default 10 minutes, capped at 60). New lines and statuses go out as progress notifications when the client sends a progress token; the result is the full transcript with `[stream time | UTC]` stamps.
- HTTP: `liveRoutes({ registry, makeCtx, extractAudio })` is a Hono sub-app with `GET /live?url=&maxMinutes=` (default 10, capped at 240), plus optional `lang` and `fromSequence`. It answers `text/event-stream` with `segment`, `status`, `done` and `error` events, each one JSON object. Closing the connection stops the watcher.

Both factories need the Node extractor, so mount them from Node entry points (the stdio MCP server, `packages/server/src/node.ts`).

## Limits

- Live HLS only. DASH-only streams, encrypted (AES-128, SAMPLE-AES) and DRM streams are refused. Recording the stream to disk is out of scope.
- YouTube's own live captions are not used (they are not reliably reachable). No diarization (see `@vid2context/speakers`).
- YouTube blocks many datacenter IPs; run locally or behind a tunnel if the player answers `blocked`.
- Live inputs other than YouTube and direct `.m3u8` URLs need a resolver that returns the stream's HLS URL; the yt-dlp provider does not export one yet.
- Whisper hallucinates on silence (a silent stream can produce "Thank you."). Speech-to-text output keeps whatever the core chain returns.

## Tests

`npx vitest run packages/live` replays real recordings (see [test/fixtures/README.md](test/fixtures/README.md)) through real ffmpeg; tests that need ffmpeg skip without it. `LIVE=1` adds a two-minute run against a real live stream (`VID2CONTEXT_LIVE_TEST_URL` overrides the default). Re-record with the scripts in `scripts/`.

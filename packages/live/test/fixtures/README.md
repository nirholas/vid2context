# Live-stream fixtures

Everything here is real data, recorded on 2026-11-14 from this repo's VM. Tests replay it through `replayFetch` (`@vid2context/core/testing`) and real ffmpeg, so unit tests never touch the network.

## nasa-iss/

NASA's "Live Video from the International Space Station (Official NASA Stream)" on YouTube (`M3HKLzjvKPc`), live at the time. NASA video is in the public domain (US government work). Recorded with `npx tsx packages/live/scripts/record-nasa.ts M3HKLzjvKPc` at about 17:05 UTC.

| File | Request | What it is |
|---|---|---|
| `player-M3HKLzjvKPc.json` | `POST /youtubei/v1/player`, ANDROID client 20.10.38 | Trimmed to `playabilityStatus.status`, a few `videoDetails` fields (`isLive: true`) and `streamingData.expiresInSeconds` and `hlsManifestUrl`. Every other field (formats with signed URLs, tracking) was dropped. |
| `master.m3u8` | GET `hlsManifestUrl` | Master playlist: six muxed variants (144p HE-AAC up to 720p60) and a WebVTT subtitles rendition |
| `media-1.m3u8` | GET the 144p variant (itag 91), the cheapest one with audio | Media playlist, `EXT-X-MEDIA-SEQUENCE:323503`, seven 5.005 s segments |
| `media-2.m3u8` | The same URL about 10 s later | `EXT-X-MEDIA-SEQUENCE:323505`, ending at 323511 |
| `seg-323509.mpegts`, `seg-323510.mpegts`, `seg-323511.mpegts` | GET each segment URL (YouTube answers with a 302 to a cache host) | Three consecutive MPEG-TS segments, 5.005 s each, HE-AAC stereo audio plus 256x144 video, 69,560 bytes each. 323509 is the last segment of `media-1.m3u8`; the other two are the ones `media-2.m3u8` adds |

The ISS feed was silent while recording (ffmpeg `volumedetect`: mean -90 dB), which is common between crew events, and no public-domain live stream with speech was on air. Whisper answers silence with the familiar " Thank you.", which is what the recorded responses contain.

Redaction: YouTube embeds the requesting machine's IP address in every manifest, playlist and segment URL (`/ip/<address>/`). The recorder replaced it with `0.0.0.0` in every file. Nothing else personal is in these URLs; the signatures expired six hours after recording.

## apollo-hls/

A live HLS stream with speech, produced locally from the shared public-domain clip `tests/fixtures/media/apollo11-small-step.mp3` (Neil Armstrong, NASA) by ffmpeg's own HLS muxer: `npx tsx packages/live/scripts/record-apollo-hls.ts` runs `ffmpeg -re -i apollo11-small-step.mp3 -c:a aac -b:a 32k -ac 1 -ar 16000 -f hls -hls_time 4 -hls_playlist_type event -hls_flags program_date_time ...` and keeps every state of the playlist as ffmpeg rewrites it in real time.

| File | What it is |
|---|---|
| `playlist-1.m3u8` to `playlist-6.m3u8` | The event playlist as it grew, one 4 s segment at a time, with ffmpeg's `EXT-X-PROGRAM-DATE-TIME` lines (zone written `+0000`) |
| `playlist-7.m3u8` | The final state: seven segments (24.2 s) and `EXT-X-ENDLIST` |
| `seg-0.mpegts` to `seg-6.mpegts` | The MPEG-TS segments (AAC, 16 kHz mono), named `seg-N.ts` in the playlists |

Tests serve these at `http://localhost:8000/apollo/`, the way any static file server would serve the folder.

## stt/

Responses from OVH AI Endpoints (keyless, `whisper-large-v3-turbo`, `POST /v1/audio/transcriptions`, `response_format=verbose_json`) for the exact chunk audio each test scenario sends, recorded in order with `LIVE=1 npx tsx packages/live/scripts/record-stt.ts`. Calls were spaced 32 s apart (the keyless tier allows about 2 per minute per IP). Only the `content-type`, `retry-after` and `x-ratelimit-*` headers were kept.

| File | Scenario (see `test/scenarios.ts`) | Responses |
|---|---|---|
| `nasa-ratelimit.json` | `nasa-sequence` with a quota already spent by an earlier run | 429 `API rate limit exceeded` with `retry-after: 46`, then 200 " Thank you." |
| `nasa-sequence.json` | 15 s chunk over segments 323509 to 323511 | 200 |
| `nasa-backpressure.json` | 5 s chunks, `maxLagSec` 6: segment 323509, then 323511 after the skip | 200, 200 |
| `nasa-resume.json` | `fromSequence` 323510, one 10 s chunk | 200 |
| `apollo-overlap.json` | 10 s chunks with 2 s overlap: 0 to 10 s, 8 to 20 s, 18 to 24.2 s | 200, 200, 200 |
| `apollo-whole.json` | default 30 s chunks: the whole 24.2 s after `EXT-X-ENDLIST` | 200 |

# 12. Local files, direct media URLs and ffmpeg tooling

| | |
|---|---|
| Track | C. Other sources |
| You own | `packages/ffmpeg/`, `providers/media-file/` (exists; extend it), `providers/media-url/` (new) |
| Shared edits allowed | `packages/core/src/audio-split.ts` (create from SHARED-CONTRACTS 1.3 if missing) and its `export *` line in `packages/core/src/index.ts`; your own rows in `docs/providers.md` and variables in `.env.example` |
| Commit scope | `media` |
| Runs alongside | 49 other prompts in the same folder; depends only on the foundation |

vid2context turns any video into context for AI agents: transcripts, metadata, chapters and cited briefs, free-first, as a CLI, MCP server, HTTP API and web app. Not every video lives on a platform: people have recordings on disk, direct `.mp3` links from a CMS, HLS streams from a conference site, and screen recordings with embedded subtitles. Today `providers/media-file` reads local files and hands raw bytes to speech-to-text, which fails for large video files and ignores the metadata, chapters and subtitles the container already carries. This prompt adds one Node package that wraps ffmpeg and ffprobe for every other package to reuse, makes local files first-class, and adds a provider for direct media URLs that also runs on Workers and in the browser.

## Read first

1. `CLAUDE.md` and `AGENTS.md` (operating rules and commands), then `docs/ARCHITECTURE.md`.
2. `packages/core/src/types.ts` (`AudioInput`, `VideoRef`, `VideoMetadata`, `Transcript`), `packages/core/src/provider.ts` (`SourceProvider`, `CaptionsProvider`), and `packages/core/src/testing.ts`.
3. `providers/media-file/src/index.ts` (matching rules, `MIME_BY_EXT`, the sha256 ref id) and its tests; `docs/contracts/providers.md` (source and captions rules, ref id format).
4. `packages/core/src/pipeline.ts` (`fetchAudio`, how `maxBytes` skips rungs) and `docs/providers.md`.
5. `docs/prompts/SHARED-CONTRACTS.md`, sections 1.3 (`audio-split.ts`), 7 (fixtures, including `tests/fixtures/media/apollo11-small-step.mp3`) and 8 (shared files), and section 9 (the `.vid2context/` data directory).

## Goal

`@vid2context/ffmpeg` gives every Node package one safe, tested way to locate ffmpeg, probe media, extract and normalize audio, split on silence, extract subtitles and extract frames. Local files resolve to full metadata, use sidecar or embedded subtitles as captions, and send compact 16 kHz mono audio to speech-to-text. Direct media URLs work on Node, Workers and the browser, and HLS and DASH streams work on Node.

## Requirements

### `packages/ffmpeg` (`@vid2context/ffmpeg`, Node only)

- Locate binaries: `FFMPEG_PATH` and `FFPROBE_PATH` env, then `PATH`, then `~/.local/bin` (on the owner's VM ffmpeg is at `/home/user/.local/bin/ffmpeg`). Report the version found (`ffmpeg -version`).
- Optional managed download of static builds into `.vid2context/bin/` (or `VID2CONTEXT_HOME/bin`) for Linux x64 and arm64 and macOS, with checksum verification and a file lock in `.vid2context/locks/` so parallel processes do not download twice. Verify the download source and its checksum format live before relying on it; document that common static builds are GPL-licensed. If no trustworthy source with checksums exists for a platform, do not download there: fail with a hint to install ffmpeg.
- `probe(file, ctx?)`: duration, container, streams (codec, type, language, channels, sample rate), tags (title, artist, date, comment), and chapters, from `ffprobe -print_format json -show_format -show_streams -show_chapters`.
- `extractAudio(file, { format: 'mp3' | 'flac' | 'wav', sampleRate = 16000, channels = 1, bitrate })` returning bytes plus duration. Defaults: mp3 at 32 kbps for uploads to hosted rungs (about 14 MB per hour, under Groq's 25 MB for about 1.7 hours), flac for local speech-to-text.
- `splitOnSilence` implementing `AudioSplitter` from `packages/core/src/audio-split.ts` (id `ffmpeg-silence`): run `silencedetect`, cut near `targetSec` at the nearest silence, honour `maxBytes` and `overlapSec`, return chunks with correct `startSec` and `overlapSec`. If `audio-split.ts` does not exist, create it exactly as SHARED-CONTRACTS 1.3 shows and follow that section's procedure.
- `extractSubtitles(file, streamIndex?)`: text subtitle streams (subrip, mov_text, webvtt, ass) to WebVTT text.
- `extractFrames(file, { everySec?, sceneThreshold?, maxFrames, width })`: JPEG frames with timestamps, for prompt 31 (visual notes) to reuse later.
- Process safety: spawn without a shell, pass arguments as an array, refuse inputs that start with `-`, put `--` or `-i` before paths, enforce timeouts, kill the child on `ctx.signal` abort, cap captured stderr, clean temp files in `finally`. Map failures to `Vid2ContextError` (`unavailable` for unreadable media, `upstream` for ffmpeg crashes) with hints.

### `providers/media-file` (extend)

- Keep matching and the ref id exactly as the foundation defines (sha256 of absolute path, size and mtime).
- Metadata from `probe`: title tag or basename, duration, container chapters as `Chapter[]`, language from the audio stream when tagged, `extra.streams`.
- Video files get audio extracted (mp3 16 kHz mono) before speech-to-text instead of uploading the raw video; audio files that are already small and in a supported format pass through.
- New captions provider `media-file-captions`: sidecar files next to the media (`talk.srt`, `talk.vtt`, `talk.en.srt`) as `creator-captions` with the language from the file name, then embedded text subtitle streams. Parse SRT and VTT robustly (BOM, CRLF, cue settings, multi-line cues).
- When ffmpeg is missing, keep working for audio files (raw bytes, as today) and say in the attempt detail that video files need ffmpeg.

### `providers/media-url` (new)

- Provider id `media-url`, runtimes `node`, `workers`, `browser`. `match` accepts http(s) URLs whose path ends in a media extension (`.mp3 .m4a .aac .wav .flac .ogg .opus .mp4 .m4v .webm .mov .mkv`), ignoring query strings. Platform `media`, nativeId a sha256 of the canonical URL.
- Metadata: file name as title, size and type from a `HEAD` request (fall back to a ranged `GET bytes=0-0`), duration when the response or a probe gives it.
- Audio: fetch through `ctx.fetch` with a size cap (`VID2CONTEXT_MAX_MEDIA_MB`, default 200), content-type check, abort on signal. Video URLs on Node go through ffmpeg extraction; on Workers and the browser, only audio-sized files are accepted, with a clear `too-large` hint otherwise.
- A second provider `media-stream` (runtime `node`) for HLS `.m3u8` and DASH `.mpd`: ffmpeg reads the stream directly and extracts audio; metadata from the playlist and `probe`.

## Prefer free and local

Everything here is local and free: ffmpeg runs on the user's machine. Prefer the system ffmpeg; download a managed build only when none is found and the user has not disabled it (`VID2CONTEXT_FFMPEG_DOWNLOAD=0`).

## Out of scope

- The long-audio orchestrator and the pure-JS mp3 and wav splitters: prompt 04 (long audio). You provide the ffmpeg splitter it can take.
- yt-dlp downloads for platform URLs: prompt 11 (yt-dlp). It shells out to ffmpeg itself.
- Frame reading with OCR or vision models: prompt 31 (visual notes).
- Upload handling in the HTTP API: prompt 46.

## Tests

- Media fixtures must be real. Use the shared `tests/fixtures/media/apollo11-small-step.mp3`. Add a few small public-domain or CC0 files to `packages/ffmpeg/test/fixtures/` (each under 1 MB, source and license in the README): a short video (for example a NASA public-domain clip), a file muxed with ffmpeg from that real video plus a real public-domain subtitle file (document the exact command), and one with container chapters (document how they were added).
- Unit tests that need ffmpeg skip with a clear message when it is absent; they run on this VM.
- Assert: probe durations within 0.1 s of ffprobe's own value, normalized audio is 16 kHz mono with the expected codec, silence splitting yields chunks under `maxBytes` whose durations sum to the source (minus overlaps), subtitles extract to valid WebVTT, frames come with increasing timestamps, abort kills the process (no leftover child).
- `media-url`: record a real `HEAD` response and a real small body from a public-domain mp3 URL into fixtures and replay them; a size-cap test using a recorded `content-length` header.
- LIVE: a real public HLS test stream (for example Apple's public HLS examples) through `media-stream`, and a real direct mp3 URL through the full pipeline with the keyless OVH Whisper rung.

## Acceptance criteria

- [ ] `npx tsc -p tsconfig.json --noEmit 2>&1 | grep -E 'packages/ffmpeg|providers/media-(file|url)'` prints nothing.
- [ ] `npx vitest run packages/ffmpeg providers/media-file providers/media-url` passes.
- [ ] `npx biome check packages/ffmpeg providers/media-file providers/media-url` is clean.
- [ ] `npm run gen` lists `media-url` in the node, workers and browser registries and `media-stream` only in node.
- [ ] `npm run cli -- ./path/to/real-video.mp4` returns a transcript produced from extracted audio, and a file with a sidecar `.srt` returns `creator-captions` without calling speech-to-text (check `attempts`).
- [ ] A real HLS URL returns a transcript (LIVE), or the report says why it could not be checked.

## Docs

- `docs/guides/local-files.md`: supported inputs, sidecar naming, embedded subtitles, ffmpeg discovery and the managed download, size limits, HLS and DASH.
- Your rows in `docs/providers.md` (`media-file-captions`, `media-url`, `media-stream`) and your variables in `.env.example` (`FFMPEG_PATH`, `FFPROBE_PATH`, `VID2CONTEXT_FFMPEG_DOWNLOAD`, `VID2CONTEXT_MAX_MEDIA_MB`).

## If credentials, tools or network are missing

No keys are needed. If ffmpeg is missing, install-free tests still run (matching, SRT and VTT parsing, URL provider replays) and ffmpeg tests skip with a message; say so in the report. If the network is down, skip the LIVE tests and list them as unverified. Never generate synthetic tones as stand-ins for real media.

<!-- COMMON -->

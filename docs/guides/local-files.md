# Local files, direct media URLs and streams

vid2context reads more than platform links: recordings on disk, direct links to `.mp3` or `.mp4` files, and HLS or DASH streams. This guide covers what works, how subtitles that come with a file are used, and how ffmpeg is found.

```sh
npm run cli -- ./talk.mp4
npm run cli -- ~/Recordings/interview.m4a --timestamps
npm run cli -- https://upload.wikimedia.org/wikipedia/commons/5/5a/Discovery_-_Nice_to_be_in_orbit.mp3
npm run cli -- https://devstreaming-cdn.apple.com/videos/streaming/examples/bipbop_16x9/bipbop_16x9_variant.m3u8
```

## Supported inputs

| Input | Provider | Runtimes | Notes |
|---|---|---|---|
| A local path (`./talk.mp4`, `/abs/path.mkv`, `~/a.mp3`) or `file://` URL | `media-file` | Node | Extensions: `.mp3 .mpga .mpeg .m4a .aac .wav .flac .ogg .oga .opus .weba .webm .mp4 .m4v .mov .mkv .avi`. A path that starts with `./`, `/` or `~/` matches whatever its extension. |
| An http(s) link whose path ends in a media extension | `media-url` | Node, Workers, browser | `.mp3 .m4a .aac .wav .flac .ogg .opus .mp4 .m4v .webm .mov .mkv`; query strings are ignored for matching. |
| An HLS `.m3u8` or DASH `.mpd` URL | `media-stream` | Node | On-demand streams only; live streams are refused. |

Ref ids: local files are `file:<sha256 of path, size and mtime>`, so editing the file gives a new id and never serves a stale cache. URLs are `media:<sha256 of the URL without its fragment>`.

## What you get

For local files with ffmpeg installed, metadata comes from the container: the title tag (or the file name), artist (as the channel), date, comment, duration, container chapters, and the spoken language when the audio stream is tagged. `extra.streams` lists the streams.

Audio for speech-to-text:

- Video files: the first audio track is extracted as 16 kHz mono mp3 at 32 kbps, about 14 MB per hour. That keeps roughly 1.7 hours under the 25 MB upload limit of Groq and OpenAI; longer audio is split by the long-audio orchestrator.
- Audio files up to 25 MB in a format speech-to-text accepts (`mp3 m4a wav flac ogg opus`) go through untouched. Larger or other formats are re-encoded like video.

## Subtitles that come with a file

Before transcribing, `media-file-captions` looks for subtitles. When it finds usable ones, the transcript is `creator-captions` and no speech-to-text runs (check `attempts`: there is no `audio` or `stt` stage).

Sidecar files sit next to the media and share its name:

| File next to `talk.mp4` | Language |
|---|---|
| `talk.srt`, `talk.vtt` | the audio stream's tag, else `und` |
| `talk.en.srt`, `talk.eng.vtt` | `en` |
| `talk.pt-BR.srt` | `pt-BR` |
| `talk.en.forced.srt` | listed, never used as the transcript (forced tracks hold only foreign-language lines) |
| `talk.final.srt` | ignored: it may belong to `talk.final.mp4` |

Modifiers `sdh`, `cc` and `default` are allowed in the name. Parsing handles a UTF-8 BOM, CRLF line endings, missing cue numbers, cue settings, multi-line cues, MM:SS timings, HTML-style tags, ASS override codes and WebVTT voice tags (kept as the speaker).

Embedded subtitle streams (mkv `subrip` or `ass`, mp4 `mov_text`, `webvtt`) are read with ffmpeg when there is no sidecar. Image-based subtitles (DVD, Blu-ray PGS) hold pictures, not text, and are skipped.

Order: sidecars before embedded streams, untagged sidecars first. With `--lang xx`, tracks in that language come first, then untagged ones; if only other languages exist, speech-to-text runs instead. The transcript's `model` field names the track used, for example `sidecar:talk.en.srt` or `embedded:2`.

## ffmpeg

`@vid2context/ffmpeg` finds ffmpeg and ffprobe in this order:

1. `FFMPEG_PATH` and `FFPROBE_PATH`. An explicit path that does not exist is an error, never silently replaced. ffprobe next to `FFMPEG_PATH` is found automatically.
2. `PATH`.
3. `~/.local/bin`.
4. The managed copy in `.vid2context/bin/` (or `$VID2CONTEXT_HOME/bin`).
5. A managed download, only when a video or stream actually needs ffmpeg, and only if `VID2CONTEXT_FFMPEG_DOWNLOAD` is not `0`. Reading metadata never triggers it.

Without ffmpeg, audio files still work (raw bytes, filesystem metadata) and sidecar subtitles still work. Video files and streams fail with a hint to install ffmpeg.

### Managed download

On Linux x64 and arm64, vid2context downloads the newest release-branch static build from [BtbN/FFmpeg-Builds](https://github.com/BtbN/FFmpeg-Builds/releases) (about 150 MB), checks it against the release's `checksums.sha256`, and installs `ffmpeg` and `ffprobe` into `.vid2context/bin/` with a provenance file `ffmpeg.json`. A lock in `.vid2context/locks/` makes parallel processes wait for one download instead of each starting their own.

These builds are GPL-licensed (they include x264 and x265). If that matters for how you distribute vid2context, install ffmpeg yourself and set `VID2CONTEXT_FFMPEG_DOWNLOAD=0`.

There is no managed download on macOS or Windows: no source with a published checksum was found (evermeet.cx, the usual macOS build, publishes GPG signatures only). Install with `brew install ffmpeg` or `winget install ffmpeg`.

### Static builds and network input

Some static builds, including the johnvansickle.com builds, crash (SIGSEGV) when they open an http(s) URL, because their statically linked C library cannot resolve DNS unless `nscd` is running. Local files are unaffected. Streams need ffmpeg to fetch the playlist itself, so with such a build, install ffmpeg from your package manager or point `FFMPEG_PATH` and `FFPROBE_PATH` at another build (the managed BtbN build works). vid2context reports this crash with that hint.

### Safety

ffmpeg runs without a shell, with arguments as an array. Inputs that start with `-` are refused, relative paths are made absolute (so `concat:` and other protocol names are never read from a path), every run has a timeout, an aborted request kills the process, and temp files are removed when done. For URL inputs ffmpeg may only use the `http`, `https`, `tls`, `tcp` and `crypto` protocols, so a hostile playlist cannot make it read local files.

## Size limits

| Limit | Default | Change it with |
|---|---|---|
| Direct media URL download | 200 MB (1 MB = 1,048,576 bytes) | `VID2CONTEXT_MAX_MEDIA_MB` |
| Video URL on Workers or in the browser (no ffmpeg there) | 25 MB | not configurable: run on Node with ffmpeg instead |
| Audio file passed through without re-encoding | 25 MB | not configurable |

The URL cap is checked against `content-length` (from `HEAD`, or a one-byte ranged `GET` when `HEAD` is refused) before downloading, and again while streaming, so a server that lies about the size is still stopped. Responses that are clearly not media (an HTML page) are refused with a hint to link the file itself.

## Direct video URLs

On Node, a video URL (`.mp4`, `.webm`, ...) is downloaded through the same capped fetch into a temp file, and ffmpeg extracts the audio locally. On Workers and in the browser there is no ffmpeg, so only video files up to 25 MB are accepted and sent to speech-to-text as they are.

## HLS and DASH

`media-stream` fetches the playlist for metadata: total duration (segment durations for HLS, `mediaPresentationDuration` for DASH), live or on-demand, variant count, audio renditions and subtitle languages. For a multivariant HLS playlist, audio comes from the default audio rendition's own playlist when it has one, otherwise from the smallest variant (an audio-only variant when there is one), so ffmpeg fetches as little as possible. Live streams are refused; for live transcription see `watch_live` in [providers.md](../providers.md).

Verified live on 2026-11-14: Apple's public bipbop example (30 minutes of audio extracted in 16 seconds) and the Tears of Steel HLS demo (CC BY 3.0) transcribed through the keyless OVH rung.

## For other packages

`@vid2context/ffmpeg` is Node only. Never import it from core or from a provider that declares the `workers` or `browser` runtime.

| Export | Use |
|---|---|
| `locateFfmpeg(ctx, { download })`, `tryLocateFfmpeg(ctx)`, `findTools(env)` | find the binaries and the version |
| `probe(input, ctx)` | duration, container, streams, tags, chapters |
| `extractAudio(input, { format, sampleRate, channels, bitrate, startSec, durationSec, maxBytes }, ctx)` | normalised speech audio (`mp3`, `flac` or `wav`) |
| `splitOnSilence` | the `ffmpeg-silence` `AudioSplitter` for the long-audio orchestrator: cuts near `targetSec` at silences, or at the quietest moment in noisy recordings, every chunk under `maxBytes` |
| `extractSubtitles(input, streamIndex?, ctx)` | a text subtitle stream as WebVTT |
| `extractFrames(input, { everySec, sceneThreshold, maxFrames, width }, ctx)` | JPEG frames with their timestamps |

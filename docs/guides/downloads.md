# Download videos and audio

vid2context can save a video as **mp4, webm or mkv**, or just its audio as **mp3, m4a, opus, flac or wav**. It works on YouTube and the other sites yt-dlp supports, and converts local files. It is the same engine everywhere: the CLI, the MCP server, the HTTP API and the web app's Download section.

Only download media you have the rights to: your own uploads, public-domain or Creative Commons works, or videos the site lets you download. YouTube's terms forbid downloading except through YouTube's own download button.

## Quick start

```sh
npx vid2context download https://www.youtube.com/watch?v=aqz-KE-bpKQ        # mp4 up to 1080p
npx vid2context download aqz-KE-bpKQ --audio                                # mp3, best quality
npx vid2context download aqz-KE-bpKQ --audio mp3 --quality 320             # 320 kbps
npx vid2context download aqz-KE-bpKQ --audio m4a                            # original AAC, no re-encode
npx vid2context download aqz-KE-bpKQ --video webm --quality 720 -d ~/Videos
npx vid2context download aqz-KE-bpKQ --info                                 # qualities and sizes only
```

The first run installs yt-dlp into `.vid2context/bin/` (checksum-verified, see [ytdlp.md](ytdlp.md)). Downloads also need **ffmpeg**, to merge picture and sound and to convert audio: `apt install ffmpeg`, `brew install ffmpeg` or `winget install ffmpeg`, or set `FFMPEG_PATH`. `vid2context doctor` checks both.

## Formats and quality

| Format | What you get | Notes |
|---|---|---|
| `mp4` (default video) | H.264 + stereo AAC up to 1080p | Plays everywhere. Above 1080p YouTube only has VP9 and AV1, which go into the mp4 as they are |
| `webm` | VP9 + Opus | Smaller at the same quality; no cover art (yt-dlp cannot embed it in WebM) |
| `mkv` | the best streams in any codec | Often AV1; the most quality per byte, the least compatible |
| `mp3` (default audio) | MP3, `best` VBR (about 245 kbps) or 320 to 64 kbps | Always re-encoded |
| `m4a` | the original AAC stream | No re-encode, so no quality loss and fast |
| `opus` | the original Opus stream | No re-encode |
| `flac`, `wav` | lossless containers | Decoded from the site's lossy stream: larger, not better |

`--quality` for video is the largest picture size (the smaller side in pixels): `best`, `2160`, `1440`, `1080` (default), `720`, `480`, `360`, `240`, `144`. You get the largest the video has at or below that. For mp3 it is the bitrate. Other audio formats keep the source quality.

Two choices that matter and are made for you:

- **Stereo sound.** Some videos also offer 5.1 AAC or AC-3 tracks. Players, phones and editors often handle those badly, so vid2context picks the stereo track.
- **Compatible picture.** mp4 prefers H.264 up to the requested size, even where a newer codec exists at the same size.

`--info` (CLI), `get_media_options` (MCP), `GET /downloads/options` (HTTP) and the web app show every quality with its codecs and an estimated size. Sizes are exact when the site reports them, otherwise bitrate times duration.

## What goes into the file

By default every file gets the title, channel and date as tags, the thumbnail as cover art (JPEG), and the chapter markers. Turn them off with `--no-metadata`, `--no-thumbnail` and `--no-chapters`. `--subs en,de` embeds subtitle tracks into a video, from the creator's captions or YouTube's automatic ones.

Files are named `Title [id].ext`, made safe for every filesystem. A file that already exists is kept, and the new one gets ` (2)`, unless you pass `--force`.

## Keep only a part

```sh
vid2context download aqz-KE-bpKQ --audio m4a --from 1:00 --to 2:30
vid2context download <talk-url> --chapter "Q&A"          # by title: exact, prefix, then substring
vid2context download <talk-url> --chapter 3 --video      # by 0-based index (see --info)
```

Times take seconds (`90`), `m:ss`, `h:mm:ss` or `1m30s`. A trimmed file is named after the part, like `Title (1m00s-2m30s) [id].m4a` or `Title - Q&A [id].mp4`, and gets no chapter markers.

Video cuts land on the nearest keyframe before `--from`, which is usually a second or two early. `--exact-cuts` re-encodes around the cut so the video starts exactly there (slower).

vid2context first asks yt-dlp to fetch only that part. That needs ffmpeg to read the stream over https, and some static builds (johnvansickle.com, for example) crash when they do, see [local-files.md](local-files.md). In that case vid2context downloads the whole video and trims it locally, and says so in a note.

## Cut sponsor segments (YouTube)

```sh
vid2context download <url> --sponsorblock                  # sponsor, selfpromo, interaction
vid2context download <url> --sponsorblock sponsor,intro,outro
```

This uses the community [SponsorBlock](https://sponsor.ajay.app) database. The categories are sponsor, selfpromo, interaction, intro, outro, preview, filler and music_offtopic.

## Playlists and channels

A playlist, channel or feed URL downloads every video, up to `--limit` (default `VID2CONTEXT_MAX_PLAYLIST_ITEMS`, 500). One failed video does not stop the rest. Failures are listed on stderr, and the exit code is non-zero.

```sh
vid2context download "https://www.youtube.com/playlist?list=..." --audio opus --limit 20
```

## Local files

```sh
vid2context download ./lecture.mkv --audio opus
vid2context download ./screen-recording.mov --video mp4 --quality 720
```

Streams the target container can hold are copied, so most conversions are a fast remux. Other codecs, a smaller picture size or an mp3 bitrate mean a re-encode.

## MCP

The local stdio server (`npx vid2context-mcp`) adds two tools:

- `get_media_options { url }`: qualities, formats, sizes, chapters and subtitle languages.
- `download_media { url, kind?, format?, quality?, from?, to?, chapter?, subtitles?, removeSegments?, dir?, limit?, ... }`: saves the files and returns their paths. Default folder: `VID2CONTEXT_DOWNLOAD_DIR`, else `~/Downloads/vid2context`. It reports progress to clients that ask for it.

The remote MCP server (Streamable HTTP, for ChatGPT and Claude.ai) does not offer them, because they write files on the machine the server runs on.

## HTTP API and web app

Downloads run as background jobs, so long videos never hit the request timeout:

```sh
curl -X POST localhost:8787/api/v1/downloads -H 'content-type: application/json' \
  -d '{"url":"https://www.youtube.com/watch?v=jNQXAC9IVRw","format":"mp3","quality":"192"}'
# 202 {"id":"...","status":"queued",...}
curl localhost:8787/api/v1/downloads/<id>          # progress: phase, percent, speed, ETA
curl -OJ localhost:8787/api/v1/downloads/<id>/file # the file once status is "done"
```

`GET /downloads/:id/file` supports `Range` requests, and `?inline=1` lets a browser play the file. Finished files are deleted after `VID2CONTEXT_DOWNLOAD_TTL_MIN` (30) minutes, or when the server restarts. Every route is listed in [contracts/http-api.md](../contracts/http-api.md#downloads-vid2contextdownloads).

The web app shows a Download section on every result page, and a Download page in the sidebar, whenever the API it talks to has downloads enabled.

### Captions only

The web app's Captions page (sidebar, or `/app/?view=captions&url=<link>`, also linked from every result) saves a video's subtitles without the rest of the context and without downloading any media. It lists every caption track (`GET /caption-languages`), one row per language, labelled with the track a download returns (creator captions before auto-captions). Each track can be previewed and saved as SRT, WebVTT, plain text (optionally with timestamps) or JSON, along with any other subtitle format the server's formatters offer. "Save all" puts every track in one .zip, and a track that the platform refuses (YouTube often rate-limits caption requests from servers) is listed rather than failing the whole archive. "Translate" saves captions in a language the video has no track for: the platform's own translation first, then an LLM on the server that keeps every timestamp. A playlist or channel link saves one language (or each video's own) for up to 100 videos in one .zip, fetched one at a time.

Every request is `GET /transcript?mode=captions`, so a video without captions is reported, never transcribed. The page links to the run page for that, where the audio can be transcribed on the server, in the browser, or from a file.

### Public servers

With `VID2CONTEXT_PUBLIC=1`, downloads are **off** unless the operator sets `VID2CONTEXT_DOWNLOADS=1`. A public server that serves media spends a lot of bandwidth, invites abuse, and takes on the terms-of-service question for every user. When on, a public server also defaults to at most 1024 MB per file (`VID2CONTEXT_MAX_DOWNLOAD_MB`) and 120 minutes per kept part (`VID2CONTEXT_MAX_DOWNLOAD_MIN`), and it never reads local paths. Workers deployments cannot run yt-dlp, so there `/downloads/status` says why downloads are unavailable.

## Settings

| Env var | Default | Meaning |
|---|---|---|
| `VID2CONTEXT_DOWNLOADS` | on locally, off when public | `1` allows downloads on a public server, `0` turns them off everywhere |
| `VID2CONTEXT_DOWNLOAD_DIR` | current directory (CLI), `~/Downloads/vid2context` (MCP) | where files are saved |
| `VID2CONTEXT_MAX_DOWNLOAD_MB` | 0 (no limit); 1024 when public | largest file |
| `VID2CONTEXT_MAX_DOWNLOAD_MIN` | 0 (no limit); 120 when public | longest kept part |
| `VID2CONTEXT_DOWNLOAD_TTL_MIN` | 30 | HTTP: minutes a finished file stays downloadable |
| `VID2CONTEXT_DOWNLOAD_CONCURRENCY` | 2 | HTTP: downloads at once (separate from `YTDLP_CONCURRENCY`, so downloads never block metadata calls) |
| `VID2CONTEXT_MAX_DOWNLOAD_JOBS` | 50 | HTTP: jobs kept before new ones are refused |
| `VID2CONTEXT_DOWNLOAD_TIMEOUT_SEC` | 7200 | longest one download may run, retries included |
| `VID2CONTEXT_DOWNLOAD_STALL_SEC` | 120; 60 when public | seconds without progress before yt-dlp or ffmpeg is killed and restarted |
| `VID2CONTEXT_DOWNLOAD_STALL_RETRIES` | 2 | restarts after a stall |
| `VID2CONTEXT_DOWNLOAD_MIN_FREE_MB` | 256; 1024 when public | disk that must stay free after the estimated download |

The yt-dlp settings (`YTDLP_COOKIES_FILE`, `YTDLP_COOKIES_FROM_BROWSER`, `YTDLP_PATH`, ...) apply to downloads too. Cookies are how you download videos that need a signed-in account.

## When something goes wrong

The engine recovers on its own from the three failures seen most often, and says so in a note on the result:

- **HTTP 403 from the media server.** Stream URLs expired or were refused, so it extracts the page again and retries.
- **Subtitles answer 429.** YouTube rate-limits subtitle downloads per IP, so it saves the video without them.
- **ffmpeg crashes fetching a part.** It downloads the whole video and trims locally (see above).

Other errors carry a code and a hint, for example `unsupported-input` for a live stream, which can be downloaded once it has ended.

## Stall protection

Every yt-dlp and ffmpeg process runs under a watchdog:

- **No progress.** A process that prints no progress for `VID2CONTEXT_DOWNLOAD_STALL_SEC` seconds (a hung connection, a stuck muxer) is killed, with its whole process group, and restarted up to `VID2CONTEXT_DOWNLOAD_STALL_RETRIES` times. Each restart is noted on the result.
- **One deadline.** `VID2CONTEXT_DOWNLOAD_TIMEOUT_SEC` is the budget for the whole download. Retries and the local trim share it, so a bad source can no longer run for several times the limit.
- **Disk space.** Before a download starts, the estimated size (from the quality list) is checked against the free space of the temp folder (about twice the size for a video, which is merged from two streams) and of the download folder, plus `VID2CONTEXT_DOWNLOAD_MIN_FREE_MB`. A download that would not fit is refused with `too-large`.
- **Size caps while streaming.** With `VID2CONTEXT_MAX_DOWNLOAD_MB` set, a download whose estimate is clearly over the limit is refused up front, and one that grows past it while running (bytes reported by yt-dlp or ffmpeg, or the work folder polled every second) is stopped at once instead of after it finished.
- **Cancel.** Canceling a job (`DELETE /downloads/:id`, Ctrl+C, an MCP cancel) kills the child processes and waits for them to exit before their temp folder is removed.

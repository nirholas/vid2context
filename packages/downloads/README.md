# @vid2context/downloads

Save a video as mp4, webm or mkv, or its audio as mp3, m4a, opus, flac or wav, from YouTube and the other sites yt-dlp supports, or convert a local file. On top of that, a media toolkit: captions and subtitles only (from the transcript pipeline, any source, or yt-dlp), frame grabs, animated GIF/WebP clips, and batches of URLs, playlists and channels with an optional single .zip, every download under a stall watchdog. This one engine backs `vid2context download` and `vid2context captions`, the download MCP tools, `/api/v1/downloads` and the web app's Download section. The user guide is [docs/guides/downloads.md](../../docs/guides/downloads.md).

## Entries

| Import | Runtime | What |
|---|---|---|
| `@vid2context/downloads` | any | `normalizeRequest`, the format and quality lists, `formatChoice` and `downloadArgs` (yt-dlp argv), `mediaOptions` (qualities and sizes from `-J` info), `ProgressTracker`, `downloadPolicy`, `optionsSummary` |
| `@vid2context/downloads` (toolkit) | any | `normalizeCaptionsRequest`, `normalizeFramesRequest`, `normalizeAnimationRequest`, `normalizeBatchRequest`, `normalizeToolkitRequest`, `renderCaptions`, `toolkitLimits`, `estimateBytes`, `toolkitOf(downloader)` |
| `@vid2context/downloads/node` | Node | `createDownloader({ registry })` (with a registry it carries `downloader.toolkit`), `createDownloadManager({ downloader })`, `createToolkit`, `createTaskQueue`, `Watchdog`, `preflightDisk`, `zipFiles` |
| `@vid2context/downloads/http` | any | `downloadsRoutes({ makeCtx, manager? })`, mounted by the server under `/api/v1` |
| `@vid2context/downloads/mcp` | any | `registerDownloadTools(server, { registry, ctx, downloader? })`, where no downloader means no tools |

The HTTP and MCP entries take the Node objects as arguments, so the Workers bundle never imports `node:*`. Without a manager the routes answer `no-provider`, and without a downloader the tools are not registered.

```ts
import { normalizeRequest } from '@vid2context/downloads';
import { createDownloader } from '@vid2context/downloads/node';

const downloader = createDownloader({ registry });
const options = await downloader.probe('aqz-KE-bpKQ', ctx); // qualities, sizes, chapters
const file = await downloader.download(normalizeRequest({ url: 'aqz-KE-bpKQ', format: 'm4a', from: '1:00', to: '1:10' }), ctx, {
  dir: '/tmp/out',
  onProgress: (p) => console.error(p.phase, p.percent),
});
// file: { path, filename, bytes, mimeType, title, durationSec, section, warnings }
```

## How a download runs

1. `yt-dlp -J` info, cached per ctx, so a probe followed by a download extracts the page once. Live and upcoming streams and playlists are refused with a hint.
2. A chapter or `from`/`to` becomes a checked section, and the duration limit is applied.
3. yt-dlp downloads from the saved info (`--load-info-json`) with the format rules below and prints progress lines (`v2c:` prefix). `ProgressTracker` folds them into one percentage across the picture and sound streams.
4. Recoveries, each noted in `warnings`: a fresh extraction after HTTP 403, a run without subtitles when a subtitle track fails (YouTube often answers 429), and a full download plus a local trim when ffmpeg crashes on the section download (static builds that cannot resolve DNS).
5. The file is renamed `Title [id].ext` (safe on every filesystem, ` (2)` instead of replacing) and moved into the target folder. The temp directory is always removed.

Local files skip yt-dlp. ffmpeg copies the streams the target container can hold and re-encodes only what it must (`convertPlan`).

## Format rules

`formatChoice` gives yt-dlp a `-f` and a `-S` per request. These were checked against real YouTube format lists, and `test/formats.test.ts` asserts that `pickVideo` and `pickAudio` (used for the size estimates) choose the same streams yt-dlp chose for 60 container and quality combinations.

| Request | `-S` |
|---|---|
| mp4 | `res:<q>,vcodec:h264,channels:2,acodec:aac` |
| webm | `res:<q>,vcodec:vp9,channels:2,acodec:opus` |
| mkv | `res:<q>,channels:2` |
| mp3, flac, wav | `channels:2` |
| m4a | `channels:2,acodec:aac` |
| opus | `channels:2,acodec:opus` |

`channels:2` keeps the stereo track instead of 5.1 AAC or AC-3. It also makes streams that already carry stereo sound win over silent ones of the same size, which is why YouTube's 360p format 18 is chosen at 360p.

## Server-side jobs

`createDownloadManager` runs jobs in this process under `VID2CONTEXT_DOWNLOAD_CONCURRENCY` (default 2), in its own queue, so downloads never hold the `YTDLP_CONCURRENCY` slots that metadata and caption calls need. Each job gets a private temp folder, deleted when the job expires (`VID2CONTEXT_DOWNLOAD_TTL_MIN`), is deleted, or when `close()` runs on shutdown. Job ids are random UUIDs, and paths never appear in the API.

## Policy

`downloadPolicy(env)`: on locally, off when `VID2CONTEXT_PUBLIC=1` unless `VID2CONTEXT_DOWNLOADS=1`, and off everywhere with `VID2CONTEXT_DOWNLOADS=0`. Public servers default to 1024 MB and 120 minutes. All settings are in [docs/providers.md](../../docs/providers.md#video-and-audio-downloads-vid2contextdownloads-node-only).

## Tests

- `npm test` runs on recorded data with no network: argv, options, policy, stream picks against yt-dlp's real choices, progress over a recorded download, and (when ffmpeg is installed) the downloader, job queue, HTTP routes and MCP tools on the public-domain Apollo 11 clip.
- `npm run test:live` also downloads from YouTube ("Me at the zoo", and 10 seconds of Big Buck Bunny, CC BY).
- Fixtures: [test/fixtures/README.md](test/fixtures/README.md).
- Toolkit tests (`test/toolkit.test.ts`, `test/stall.test.ts`, `test/trim.test.ts`) run on the Apollo 11 clip in `packages/ffmpeg/test/fixtures` (mp4 with a Commons sidecar `.en.srt`, mkv with the subtitles embedded) and on real child processes for the watchdog.

## Stall protection

Each yt-dlp and ffmpeg run gets a `Watchdog`: it follows the caller's signal (cancel), kills the process when nothing happens for `VID2CONTEXT_DOWNLOAD_STALL_SEC` (no progress line and no growth of the work folder) and the engine restarts it up to `VID2CONTEXT_DOWNLOAD_STALL_RETRIES` times, stops it at the one deadline the whole download shares (`VID2CONTEXT_DOWNLOAD_TIMEOUT_SEC`), and stops it once it writes more than `VID2CONTEXT_MAX_DOWNLOAD_MB`. Before a download starts, `preflightDisk` checks the estimated size (`estimateBytes`) against free space plus `VID2CONTEXT_DOWNLOAD_MIN_FREE_MB`. Cancel waits for child processes to exit before their folder is removed.

## API for the web app

Everything below is relative to `/api/v1`. Errors are `{ "error": { "code", "message", "hint" } }` with the server's usual statuses (400 `bad-request`, 403 `unavailable` when downloads are off, 404 `not-found`, 413 `too-large`, 429 `rate-limited`, 503 `no-provider`). A download or task is a job: create it, poll it, fetch its file, delete it.

### Status and options

| Route | Answer |
|---|---|
| `GET /downloads/status` | `{ enabled, reason?, notice, limits: { maxBytes, maxDurationSec, ttlMin }, formats: { video: [{id,label}], audio: [{id,label}] }, qualities: { video, audio }, sponsorCategories, thumbnailFormats, ytdlp? }` |
| `GET /downloads/toolkit` | `{ enabled, reason?, captions: { formats: [{id,label}], modes, via, defaults, maxTracks }, frames: { formats, defaults, maxFrames }, clips: { formats, defaults: { format, fps, width, lengthSec }, maxSec, maxWidth, maxFps }, batch: { kinds: ["video","audio","captions"], maxItems }, watchdog: { stallSec, stallRetries, minFreeMb } }` |
| `GET /downloads/options?url=` | `MediaOptions`: `{ id?, title, channel?, durationSec?, thumbnailUrl?, isLive, chapters: [{title,startSec,endSec?}], video: [{quality,label,height,fps?,hdr?,sizes:{mp4?,webm?,mkv?},codecs}], audio: [{format,quality,label,sizeBytes?,kbps?,method}], subtitles: [{language,name?,auto}], canRemoveSegments, formats }` |
| `GET /downloads/captions/tracks?url=` | `CaptionTracks`: `{ input, id?, title?, url?, tracks: [{ language, name, auto, origin: "creator-captions"\|"auto-captions"\|"native-transcript", sources: string[], translatable? }], translationTargets: [{language,name}], speechToText: boolean, formats: [{id,label}], notes: string[] }` |
| `GET /downloads/thumbnail?url=&format=jpg\|png\|webp&inline=1` | the image itself (headers `x-thumbnail-origin`, `x-thumbnail-width`, `x-thumbnail-height`) |

### Creating jobs (all answer `202` with the job and a `location` header)

| Route | Body (strings accepted everywhere; times are seconds, `m:ss` or `h:mm:ss`) |
|---|---|
| `POST /downloads` | `{ url, kind?: "video"\|"audio", format?: mp4\|webm\|mkv\|mp3\|m4a\|opus\|flac\|wav, quality?, from?, to?, chapter?, exactCuts?, subtitles?: string[], burnSubtitles?: lang, splitChapters?, removeSegments?: string[], embedThumbnail?, embedMetadata?, embedChapters? }` |
| `POST /downloads/captions` | `{ url, languages?: string[] \| "en,de" \| ["all"], format?: "srt"\|"vtt"\|"txt"\|"json"\|"markdown"\|"original" (default srt), mode?: "auto"\|"captions"\|"stt" (default auto), via?: "auto"\|"pipeline"\|"ytdlp", allowAuto? (true), allowTranslated? (true), timestamps? (txt), zip? }` |
| `POST /downloads/frames` | `{ url, times: (string\|number)[] \| "0:10,1:30", format?: "png"\|"jpg", width?, quality? (download size for web videos, default 1080), zip? }` |
| `POST /downloads/clips` | `{ url, from? (0), to? (from + 5 s), format?: "gif"\|"webp", fps? (10), width? (480), loop? (true) }` |
| `POST /downloads/batch` | `{ urls: string[], kind?: "video"\|"audio"\|"captions", limit?, playlist?, zip?, ...the fields of that kind (format, quality, languages, mode, ...) }` |

A single-video route answers `404` before queueing when the video does not exist (local files, and sites with their own provider such as YouTube), and `400` when the URL is a playlist (use `/downloads/batch`).

### The job

`GET /downloads` lists `{ jobs: Job[] }`, newest first, downloads and toolkit tasks together. `GET /downloads/:id` returns one:

```ts
type Job = {
  id: string;
  status: 'queued' | 'running' | 'done' | 'error' | 'canceled';
  request: DownloadRequest | { kind: 'captions' | 'frames' | 'animation' | 'batch'; ... }; // the normalized body; request.kind tells them apart
  progress: {
    phase: 'queued' | 'preparing' | 'downloading' | 'processing' | 'finished';
    percent?: number;        // downloading: of all streams; processing: of the current step; absent while unknown
    downloadedBytes: number;
    totalBytes?: number;
    speedBps?: number;
    etaSec?: number;
    step?: string;           // processing step: Merger, ExtractAudio, Trim, Frames, GIF, WebP, Zip, "Captions en"; batches prefix "2/5"
  };
  createdAt: string; updatedAt: string;
  expiresAt?: string;        // when the files are deleted (VID2CONTEXT_DOWNLOAD_TTL_MIN)
  file?: {                   // done, except a batch saved without zip
    filename: string; bytes: number; mimeType: string; title: string; source: string; durationSec?: number; warnings: string[];
    kind: 'video' | 'audio' | 'captions' | 'frames' | 'animation' | 'batch';
    format: string;          // mp4 ... wav, srt, vtt, txt, json, md, png, jpg, gif, webp, zip, or the original subtitle extension
    entries?: { name: string; bytes: number }[];       // a .zip: the files inside
    tracks?: { language: string; origin: string; producer: string; via: 'pipeline' | 'ytdlp' | 'file'; translated?: boolean }[]; // captions
    parts?: { filename: string; bytes: number; index: number; title: string; fromSec: number; toSec: number }[];         // splitChapters
    section?: { fromSec: number; toSec?: number; chapter?: string };
  };
  items?: {                  // batches: one per video, updated while running
    index: number; input: string; status: 'queued' | 'running' | 'done' | 'error' | 'canceled';
    progress?: Job['progress'];
    file?: { filename: string; bytes: number; mimeType: string; title: string; warnings: string[] };
    error?: { code: string; message: string; hint?: string };
  }[];
  warnings?: string[];       // task notes (a batch without zip: "2 of 5 items failed")
  error?: { code: string; message: string; hint?: string };
};
```

A batch is `done` when at least one item was saved; failed items keep their `error`. It is `error` only when every item failed.

### Files and cancel

| Route | What |
|---|---|
| `GET /downloads/:id/file` | the result file. `Range` supported (206, 416), `?inline=1` to show it in the page, `?part=N` for chapter N of a split. A batch without zip has no file (404 with a hint) |
| `GET /downloads/:id/items/:n/file` | item `n` (0-based) of a batch saved without zip; `Range` and `?inline=1` as above |
| `DELETE /downloads/:id` | cancel (child processes are killed and awaited) or delete the files: `{ deleted: true, id }` |

### MCP tools (stdio server only)

`get_media_options { url }`, `download_media { url, kind?, format?, quality?, from?, to?, chapter?, exactCuts?, subtitles?, burnSubtitles?, splitChapters?, removeSegments?, embed*?, dir?, limit? }`, `download_thumbnail { url, format?, dir? }`, `get_caption_options { url }`, `download_captions { url, languages?, format?, mode?, via?, allowAuto?, allowTranslated?, timestamps?, zip?, dir? }`, `grab_frames { url, times, format?, width?, quality?, zip?, dir? }`, `export_clip { url, from?, to?, format?, fps?, width?, loop?, dir? }`, `download_batch { urls, kind?, format?, quality?, languages?, mode?, limit?, playlist?, zip?, dir? }`. Results carry `structuredContent` (`{ dir, file?, items? }` for the toolkit tools) and send `notifications/progress` when the call has a progress token.

### CLI

- `vid2context download <inputs...>`: `--video [mp4|webm|mkv]`, `--audio [mp3|m4a|opus|flac|wav]`, `--quality`, `--from`, `--to`, `--chapter`, `--exact-cuts`, `--subs <langs>`, `--burn-subs <lang>`, `--split-chapters`, `--sponsorblock [cats]`, `--no-thumbnail`, `--no-metadata`, `--no-chapters`, `--thumbnail [jpg|png|webp]`, `--frames <times>`, `--frame-format png|jpg`, `--gif`, `--webp`, `--fps <n>`, `--width <px>`, `--zip`, `--info`, `--limit`, `--playlist`, `-d/--dir`, `--force`, `--json`.
- `vid2context captions <inputs...>`: `-f srt|vtt|txt|json|markdown|original`, `--lang <codes|all>`, `--mode auto|captions|stt`, `--via auto|pipeline|ytdlp`, `--no-auto`, `--no-translate`, `--timestamps`, `--list`, `--zip`, `--limit`, `--playlist`, `-d/--dir`, `--force`, `--json`.

stdout gets the saved paths (one per line) or JSON with `--json`; progress, notes and failures go to stderr.

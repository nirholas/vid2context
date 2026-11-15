# @vid2context/downloads

Save a video as mp4, webm or mkv, or its audio as mp3, m4a, opus, flac or wav, from YouTube and the other sites yt-dlp supports, or convert a local file. This one engine backs `vid2context download`, the `get_media_options` and `download_media` MCP tools, `/api/v1/downloads` and the web app's Download section. The user guide is [docs/guides/downloads.md](../../docs/guides/downloads.md).

## Entries

| Import | Runtime | What |
|---|---|---|
| `@vid2context/downloads` | any | `normalizeRequest`, the format and quality lists, `formatChoice` and `downloadArgs` (yt-dlp argv), `mediaOptions` (qualities and sizes from `-J` info), `ProgressTracker`, `downloadPolicy`, `optionsSummary` |
| `@vid2context/downloads/node` | Node | `createDownloader({ registry })` and `createDownloadManager({ downloader })` |
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

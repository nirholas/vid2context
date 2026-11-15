# Web app test fixtures

Real responses from the vid2context HTTP API, recorded on 2026-11-14 from a local server (`npm run start:server`, Node 22, this repo at the time) with:

```sh
npx tsx packages/web/scripts/record-fixtures.ts http://127.0.0.1:<port>/api/v1
```

Each file is `{ request: { method, path }, status, contentType, body }`, with the body exactly as served unless noted.

| File | Request | What it shows |
|---|---|---|
| `health.json` | `GET /health` | Name, version, runtime and formats. The `providers` array is removed because it lists which keys this machine has set. |
| `openapi.json` | `GET /openapi.json` | The OpenAPI 3.1 document of a Node server with every sub-app mounted (recorded 2026-11-14). The API page merges it into its catalog and marks routes a server does not serve. |
| `context-jNQXAC9IVRw.json` | `GET /context?url=https://www.youtube.com/watch?v=jNQXAC9IVRw` | "Me at the zoo". YouTube answered the caption requests with HTTP 429 from this IP, so the attempts show captions blocked, yt-dlp audio, then Whisper on Cloudflare Workers AI. |
| `context-not-found.json` | `GET /context?url=https://www.youtube.com/watch?v=xxxxxxxxxxx` | 404 `not-found` error body with hint and attempts. |
| `context-playlist.json` | `GET /context?url=<playlist>` | 400 `unsupported-input`: the input is a playlist, so the app expands it with `/items`. |
| `items-playlist.json` | `GET /items?url=<playlist>&limit=3` | The playlist expanded to video refs. |
| `job-context.json`, `job-context-events.json` | `POST /jobs` (kind `context`), then `GET /jobs/:id/events` | A context job and its event stream ending in `done`. |
| `job-not-found.json`, `job-not-found-events.json` | the same for the missing video | A context job whose stream ends in `error` (no attempts in job errors). |
| `upload-apollo.json` | `POST /uploads` with `tests/fixtures/media/apollo11-small-step.mp3` | 201 with `input: upload:<sha256>`. |
| `context-upload-apollo.json` | `GET /context?url=upload:<sha256>` | The Apollo 11 clip transcribed by speech-to-text. |

The playlist is `https://www.youtube.com/playlist?list=PLrAXtmErZgOeiKm4sgNOknGvNjby9efdf`, a public YouTube playlist. Nothing personal is in these files: no stream URLs, emails, phone numbers or keys.

## Download fixtures

`downloads-*.json` were recorded on 2026-11-14 with the real `/downloads` routes, job queue and downloader from `@vid2context/downloads` (yt-dlp 2026.10.26, ffmpeg 7.0.2), mounted in-process by:

```sh
npx tsx packages/web/scripts/record-download-fixtures.ts
```

Same `{ request, status, contentType, body }` shape. The local file was passed as the relative path `tests/fixtures/media/apollo11-small-step.mp3`, and the recorder removes this machine's repo path from every body, so local paths read as that relative path. Nothing else was changed. Job ids and times are as served.

| File | Request | What it shows |
|---|---|---|
| `downloads-status.json` | `GET /downloads/status` | Downloads enabled (local server), the rights notice, limits, formats and qualities. |
| `downloads-options-bbb.json` | `GET /downloads/options?url=<Big Buck Bunny>` | Big Buck Bunny (Blender Foundation, CC BY 3.0) from YouTube: every quality from 2160p60 to 144p with estimated sizes per container, audio choices, 0 chapters. |
| `downloads-options-apollo.json` | `GET /downloads/options?url=<Apollo clip>` | The public-domain Apollo 11 clip: audio only, no video choices. |
| `downloads-options-playlist.json` | `GET /downloads/options?url=<playlist>` | 400 `unsupported-input`: a playlist, so the page lists its items (`items-playlist.json`). |
| `downloads-start.json`, `downloads-job-running.json`, `downloads-job-done.json` | `POST /downloads` (Apollo clip, mp3 128), then `GET /downloads/:id` | A local conversion: the 202 job, a running snapshot and the finished job with its file. |
| `downloads-delete.json` | `DELETE /downloads/:id` | The finished job deleted. |
| `downloads-start-mp4.json`, `downloads-job-mp4-running.json`, `downloads-job-mp4-error.json` | the Apollo clip as mp4 | A job that fails with `unsupported-input` (no video track) and a hint. |
| `downloads-start-invalid.json` | `POST /downloads` with mp3 quality 1080 | 400 `bad-request` with the list of valid qualities. |
| `downloads-start-bbb.json`, `downloads-job-bbb-running.json`, `downloads-job-bbb-done.json` | `POST /downloads` (Big Buck Bunny, mp4 480p), then `GET /downloads/:id` | A real YouTube download: a snapshot at 38% of two streams (135+140) with speed, and the finished 37 MB file. |
| `downloads-job-rate-limited.json` | `GET /downloads/:id` the second time within a minute | 429 `rate-limited` with `retry-after: 60`, kept in the file's `headers` field. Recorded 2026-11-15 from `npm run start:server` with `VID2CONTEXT_RATE_LIMIT=1 VID2CONTEXT_RATE_BURST=1`, so the limiter answered on the second request. |
| `downloads-job-gone.json` | `GET /downloads/:id` for a job the server no longer has (same recording) | 404 `not-found`: the job expired or the server restarted, which the job view must not retry. |

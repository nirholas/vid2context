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

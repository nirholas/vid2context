# @vid2context/web

The vid2context web app: paste a link or drop a video or audio file, get the transcript, chapters and metadata as files you can copy or download, a .zip with all of them, and text to paste into an agent. A static React 19 app (Vite, Tailwind CSS v4) served at `/app/`. What each screen does, with screenshots: [docs/guides/web-app.md](../../docs/guides/web-app.md).

## Develop

```sh
npm run start:server            # the API on http://127.0.0.1:8787 (repo root)
npm run dev -w packages/web     # http://localhost:5173/app/, /api proxied to the API
```

The dev server and `vite preview` proxy `/api` to `VID2CONTEXT_API_PROXY` (default `http://127.0.0.1:8787`), so the app and the API share an origin and no CORS setup is needed.

## Build

```sh
npm run build -w packages/web   # static files in packages/web/dist/, base /app/
npm run preview -w packages/web # serve dist/ with the same /api proxy
```

`dist/` can be served by anything that serves a folder. `npm run build:assets` (deploy/serverless) copies it to `/app/` for the Cloudflare Worker, Vercel and GitHub Pages builds, and the Worker serves `/app/index.html` for deep links under `/app/`. The initial JS (the entry chunk plus the chunks it preloads) is about 146 KB gzipped, measured 2026-11-15; the result viewer, uploads, in-browser transcription, settings, the API page and the download and captions pages load on demand.

## Environment variables

| Variable | When | Effect |
|---|---|---|
| `VITE_API_BASE` | build | API base the app calls. Default `/api/v1` (same origin). Users can override it in Settings. |
| `VITE_CLIENT_ONLY` | build | `1` builds a copy that never calls an API (GitHub Pages). See client-only mode below. |
| `VID2CONTEXT_API_PROXY` | dev and preview | Where the dev and preview servers proxy `/api`. Default `http://127.0.0.1:8787`. |

The app makes no third-party requests of its own (no CDNs, analytics or remote fonts; Inter and JetBrains Mono are bundled). Thumbnails load from the video platform, and the in-browser Whisper model downloads from Hugging Face the first time a file is transcribed in the browser.

## Client-only mode

When the API does not answer at startup, or the app was built with `VITE_CLIENT_ONLY=1`, the status pill says so and:

- Dropped video and audio files are transcribed in the browser with Whisper through Transformers.js (`providers/stt-transformers`, default model `onnx-community/whisper-base`). Audio is decoded with Web Audio, downmixed and resampled to 16 kHz mono, and never leaves the device.
- Links show a plain explanation: YouTube and most sites block requests straight from a browser, so a link needs a vid2context server. The user can set an API base in Settings, drop a file instead, or bring the transcript (browser extension, paste, subtitle file).

## Where it keeps things

| What | Where |
|---|---|
| Recent results (the whole VideoContext, newest 100) | IndexedDB `v2c-web`, store `results` |
| Provider keys for in-browser work | IndexedDB `v2c-settings`, store `kv`, key `providerKeys`; sent to the vid2context server only when the user turns that on in Settings |
| API base, theme, collapsed sidebar | `localStorage` `v2c.apiBase`, `v2c.theme`, `v2c.sidebar` |

## Uploads

A dropped file is decoded and resampled to 16 kHz mono 16-bit WAV in the browser (about 1.9 MB per minute). An audio-only file that is already smaller than that WAV (most MP3 and M4A files) is uploaded as is; video files always shrink to the WAV. The upload goes to `POST /api/v1/uploads` and the returned `upload:<sha256>` input runs like a link.

## Tests

```sh
npx vitest run packages/web          # components and libraries on recorded real API responses (test/fixtures/)
npm run e2e -w packages/web          # Playwright: a real local API and the built app; UI, errors, decode, accessibility
LIVE=1 npm run e2e -w packages/web   # also YouTube end to end and an upload through speech-to-text
```

`scripts/record-fixtures.ts` re-records the API responses the unit tests replay, against a running server.

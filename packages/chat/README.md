# @vid2context/chat

The chat workspace: talk to your videos, pick which model answers (or let Auto pick free-first), and get streaming answers whose `[n]` citations open the video at the cited second. It is a static React app served at `/chat/`, and it exports its components so the web app can mount them at `/app/`.

Using it: [docs/guides/chat.md](../../docs/guides/chat.md).

## Develop

```sh
npm run dev -w packages/chat                               # http://localhost:5173/chat/
VID2CONTEXT_API=http://127.0.0.1:8787 npm run dev -w packages/chat   # proxy /api/v1 to a local server
npm run dev:server                                         # the server, in another terminal
```

Without `VID2CONTEXT_API` there is no API behind `/api/v1`, so the app starts in client-only mode.

## Build

```sh
npm run build -w packages/chat     # static files in packages/chat/dist, base /chat/
npm run preview -w packages/chat   # serve dist at http://localhost:4173/chat/
```

Serve `dist/` under `/chat/` on the same origin as the API (Cloudflare, Vercel, any static host). Code-splitting keeps the first load small: about 113 KB of JavaScript gzipped (React, the workspace, core helpers) plus 16 KB of CSS. The Markdown renderer (49 KB), the source panel (2 KB) and, in client-only mode only, the browser provider registry (53 KB) load on demand. Fonts are bundled through `@fontsource`, so the page itself makes no third-party requests. The exceptions are video thumbnails, the YouTube embed (loaded only after you click a citation) and, in client-only mode, the model APIs you choose.

## Configuration

| Setting | Where | Default |
|---|---|---|
| `VITE_API_BASE` | build env | `/api/v1` |
| `VITE_CLIENT_ONLY=1` | build env | off: client-only only when the API does not answer `GET /health` |
| API base override | `localStorage` `v2c.apiBase` (Settings) | none |
| Theme | `localStorage` `v2c.theme`: `dark`, `light`, `system` | `dark` |
| Server API key (servers with `VID2CONTEXT_API_KEYS`) | IndexedDB `v2c-settings`, store `kv`, key `serverApiKey` | none |
| Provider keys for client-only mode (`GROQ_API_KEY`, ...) | IndexedDB `v2c-settings`, store `kv`, key `providerKeys` | none |
| Conversations, messages, attached transcripts, favorites, last model | IndexedDB `v2c-chat` | in memory when IndexedDB is blocked |

## Server mode and client-only mode

- **Server mode**: `POST /api/v1/chat` streams the answer as server-sent events (`meta`, `reasoning`, `delta`, `done` or `error`). `GET /api/v1/models?kind=llm` fills the picker. `GET /api/v1/context`, `/library`, `/collections` and `POST /uploads` attach context; the attach dialog shows only the routes the server lists in `/openapi.json`.
- **Client-only mode**: the browser runs the chain itself with `@vid2context/registry/browser`, core's `listModels` and `chatStream`, using keys saved in this browser. Services whose API blocks browser requests (CORS) are skipped; see the table in the guide. Context comes from vid2context JSON files you drop in or transcripts you paste, because YouTube does not let web pages fetch captions.

A 60-second idle guard ends an answer whose stream stalls, with a `timeout` error and a retry button.

## Embedding

```ts
import '@vid2context/chat/src/styles/app.css';
import { ChatApp } from '@vid2context/chat';           // detects the mode and builds the backend
// or, with your own backend and store:
import { ChatWorkspace, ServerBackend, ApiClient, openChatStore } from '@vid2context/chat';
```

`src/index.ts` also exports `ModelPicker`, `Thread`, `Composer`, `CitationChip`, `SourcePanel`, `Sidebar`, `TokenMeter`, the API client (`ApiClient`, `chatEventsFromSse`) and the helpers behind them.

## Tests

```sh
npx vitest run packages/chat                     # unit and component tests on recorded responses, no network
npm run build -w packages/chat && LIVE=1 npm run e2e -w packages/chat   # Playwright, real services
```

The e2e suite runs the built app in Chromium twice: client-only with keyless models, and server mode against a local vid2context server started on a random port. `SCREENSHOTS=1` refreshes the guide's screenshots. Fixtures and how they were recorded: [test/fixtures/README.md](test/fixtures/README.md). Re-record with `scripts/record-fixtures.ts`, `scripts/record-models.ts` and `scripts/cors-probe.mjs`.

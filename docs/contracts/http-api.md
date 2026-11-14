# HTTP API contract

One Hono app ([packages/server/src/app.ts](../../packages/server/src/app.ts)) serves every runtime. All routes live under `/api/v1`. Bodies are JSON unless a route says otherwise. Data types are the core types in [packages/core/src/types.ts](../../packages/core/src/types.ts) and [packages/core/src/storage.ts](../../packages/core/src/storage.ts), serialized as JSON.

Sections: [conventions](#conventions), [implemented routes](#implemented-routes), [planned routes](#planned-routes). Planned routes are a contract: build them with exactly these paths and shapes, or change this page in the same commit.

## Conventions

### Errors

Every error response has this body:

```json
{
  "error": { "code": "not-found", "message": "YouTube xxxxxxxxxxx: ERROR (This video is unavailable)", "hint": "Check the video id or URL; the video may have been removed." },
  "attempts": [{ "id": "youtube", "stage": "metadata", "outcome": "error", "reason": "not-found", "detail": "..." }]
}
```

`code` is a core `ErrorCode`, `internal` for unexpected errors (status 500, no detail leaked), or one of the server's own codes about the caller's credentials: `unauthorized` (401, missing or wrong API key, with `WWW-Authenticate: Bearer`) and `forbidden` (403, the key lacks the scope). `hint` is present when there is a recovery step. `attempts` lists every provider and rung tried (empty when none ran). `rate-limited` responses carry `Retry-After` in seconds.

| Code | Status | | Code | Status |
|---|---|---|---|---|
| `unsupported-input` | 400 | | `rate-limited` | 429 |
| `bad-request` | 400 | | `timeout` | 504 |
| `not-found` | 404 | | `blocked` | 503 |
| `unavailable` | 403 | | `no-provider` | 503 |
| `no-transcript` | 422 | | `all-rungs-failed` | 502 |
| `too-large` | 413 | | `auth` | 502 (an upstream key failed, not the caller) |
| | | | `upstream` | 502 |
| `unauthorized` (server) | 401 | | `forbidden` (server) | 403 |

The map lives in `STATUS_BY_CODE` in `packages/server/src/errors.ts` (re-exported from `app.ts`). Add new codes there and here together.

### Common query parameters

| Name | Meaning |
|---|---|
| `url` | Any input a source understands: a video URL, a YouTube id, a playlist, channel or feed URL where a route expands lists, `upload:<sha256>` from `POST /uploads`, or a local path (Node only, refused when `VID2CONTEXT_PUBLIC=1`). URL-encode it. |
| `mode` | `auto` (default), `captions`, `stt`, `video`. |
| `lang` | Preferred transcript language, BCP-47 (`en`, `de`, `pt-BR`). |
| `format` | A formatter id from the core `formatters` map. Never hard-code the list; `GET /api/v1/health` returns it. |
| `timestamps` | `1`, `true` or `yes` to prefix lines with timestamps where the format allows. |
| `refresh` | `1` to ignore the library copy and rebuild (routes that load a context). |

### Headers

- `X-Request-Id`: sent back on every response. A client value of up to 128 characters from `A-Za-z0-9._:-` is kept; anything else is replaced by a UUID. Access logs carry it.
- `ETag` on `GET /context` and `GET /library/:id` (SHA-256 of the body). `If-None-Match` with a matching tag answers `304` with no body.
- `X-Robots-Tag: noindex` on every `/api/*` response, so JSON never competes with the docs in search results.
- `X-RateLimit-Limit` and `X-RateLimit-Remaining` on rate-limited routes; `Retry-After` on `429`.
- `X-Data-Attribution` when a response used SponsorBlock data (`skip=`).

### Secrets

Responses never contain env var values. Health output names the variables a rung needs (`requires`), never their contents.

## Implemented routes

### `GET /api/v1/health`

```json
{
  "ok": true,
  "name": "vid2context",
  "version": "0.1.0",
  "runtime": "node",
  "formats": [{ "id": "text", "description": "...", "mimeType": "text/plain; charset=utf-8" }],
  "providers": [
    { "id": "youtube", "kind": "source", "name": "YouTube", "enabled": true },
    {
      "id": "stt-openai-compatible", "kind": "stt", "name": "OpenAI-compatible speech-to-text",
      "rungs": [{ "id": "stt/ovh/whisper-large-v3-turbo", "service": "ovh", "model": "whisper-large-v3-turbo", "tier": "keyless", "enabled": true, "requires": [] }]
    }
  ]
}
```

`enabled` on a rung means its credentials are present and its tier is allowed (keyless rungs report `false` when `VID2CONTEXT_KEYLESS=0`).

### `GET /api/v1/context?url=&mode=&lang=`

Returns the full `VideoContext`: `metadata`, `transcript` (timed `segments`), optional `visual` and `comments`, and `attempts`.

### `GET /api/v1/transcript?url=&format=&timestamps=&mode=&lang=&skip=&translate=`

Returns the transcript rendered by the chosen formatter (default `text`) with that formatter's `mimeType` as `Content-Type`.

- `skip=sponsor,selfpromo` (or `skip=1` for the default categories) removes SponsorBlock segments from a copy of the transcript through `@vid2context/skips`; the stored transcript stays whole, and the response carries `X-Data-Attribution`.
- `translate=1` needs item 35's translation layer, which is not installed: the server answers `bad-request` with a hint (pass `lang=xx` for a track the platform already has).

### Routes implemented by item 46

Shapes are those in the planned tables below; these notes add what the tables leave open. Every route that takes `url` also takes `upload:<sha256>`.

| Route | Notes |
|---|---|
| `GET /metadata?url=` | the source's metadata only; no captions or audio are fetched |
| `GET /formats` | every formatter in the core map |
| `GET /items?url=&limit=` | `limit` 1 to `VID2CONTEXT_MAX_PLAYLIST_ITEMS` (default 500, also the default); a single video returns itself |
| `GET /section?url=&from=&to=&chapter=&format=&timestamps=` | at least one of `from`, `to`, `chapter`. `chapter` is an outline index (0-based, digits) or a title (exact, prefix, then substring). Built on core `getSection` |
| `GET /outline?url=` | core `outlineForApi`: videos without chapters get five-minute sections |
| `GET /comments?url=&limit=` | `limit` 1 to 1000; `no-provider` (503) when the source cannot fetch comments; uploads have none |
| `GET /pack?url=&maxTokens=`, `POST /pack` | the `pack` formatter (`renderMany` for several videos). POST also takes `mode` and `lang`; lists in `inputs` are expanded; at most 100 videos per request (`too-large` beyond) |
| `GET /library?limit=&cursor=` | `limit` 1 to 200, default 50 |
| `GET /library/:id`, `DELETE /library/:id` | ids URL-encoded once (`youtube%3AjNQXAC9IVRw`); a double-encoded id is decoded again. `DELETE` of an id that is not saved is `404` |

The library is the registry's enabled storage backend, opened once per process (or per Worker isolate), else a process-wide `MemoryStorage`. Every route that loads a context reads and writes it, except uploads, which are never saved there.

Identical concurrent requests that load a context (same input, mode, language, comments and refresh) share one pipeline run. The shared run has its own timeout, so one client disconnecting does not fail the others.

### `GET /api/v1/models?kind=`

`{ models: ModelInfo[], defaultPolicy: Policy }` (`ModelInfo` as in `docs/prompts/SHARED-CONTRACTS.md` section 3). Every rung the registry knows, enabled or not; `kind` is one of `llm`, `stt`, `embed`, `video`, `visual`. `label` is the model id after its last `/`. `capabilities` gains `stream` for LLM rungs that stream natively. `enabled` follows the same rule as health (credentials present, keyless allowed). `requires` lists env var names, never values. `defaultPolicy` is `VID2CONTEXT_POLICY` or `free`.

### `POST /api/v1/uploads`

Multipart form with a field `file`. Answers `201 { input: "upload:<sha256>", filename, bytes, mimeType, expiresAt }`.

- Size cap `VID2CONTEXT_MAX_UPLOAD_MB` (the server's default is 100, the Workers free-plan request limit): larger files get `too-large` (413). Empty files and bodies that are not `multipart/form-data` get `bad-request`.
- The id is the SHA-256 of the bytes, so the same file uploaded twice is one upload (its expiry is extended).
- Kept for `VID2CONTEXT_UPLOAD_TTL_MIN` minutes (default 60). When the storage backend can hold blobs (the Cloudflare backend with an R2 bucket bound), the bytes go to R2 under `blobs/uploads/<sha256>` and the details and transcripts to the KvStore (`uploads:` keys) with the same TTL, so every isolate sees them. Otherwise they stay in the process's memory (at most four uploads at the size cap at once, oldest dropped first) and are lost on restart.
- `upload:<sha256>` is resolved by the server, not the registry: transcribed with core `transcribe()` from an `AudioInput` of kind `bytes`, with minimal metadata from the filename (title without extension, `extra: { filename, bytes, mimeType }`). Modes `captions` and `video` give `unsupported-input`. The transcript is kept next to the upload, never in the library. An expired or unknown id is `not-found`; a malformed one `bad-request`.
- Large video files should be reduced to audio before uploading (the web app does this in the browser): speech-to-text services cap uploads at about 25 MB, so compressed mono audio (about 30 MB per hour at 64 kbit/s) goes much further.

### `GET /api/v1/bundle?url=&formats=&comments=&maxTokens=` and `POST /api/v1/bundle`

`application/zip` built by core `buildBundle` (layout in `docs/prompts/SHARED-CONTRACTS.md` section 2), streamed, with `Content-Disposition: attachment; filename="<root>.zip"`. `formats` is a comma-separated list (GET) or array (POST) of formatter ids; `context.md` is always written. POST takes `{ inputs?, collectionId?, formats?, comments?, maxTokens?, mode?, lang? }` with the same 100-video cap as `POST /pack`.

### `GET /api/v1/openapi.json`

OpenAPI 3.1 for every route the app serves, generated from the routes Hono actually has: each route module registers a description next to its handler (`packages/server/src/openapi.ts`), and mounted sub-app routes without a description appear with a generic entry tagged by package. A package may publish descriptions for its routes by exporting an OpenAPI `paths` object (relative to its mount prefix); the server passes it in when mounting. `/health` is marked open (`security: []`).

### Mounted sub-apps

Mounted by `createApp` (`packages/server/src/app.ts`, `MOUNTED_SUB_APPS`). They share the server's Ctx per request, its storage and its KvStore, and pass through the same middleware under `/api/*`.

| Package | Factory | Prefix | Notes |
|---|---|---|---|
| `@vid2context/search` (40) | `searchRoutes` | `/api/v1` | |
| `@vid2context/library` (41) | `libraryRoutes` | `/api/v1` | gets the server's KvStore, and the jobs queue when one is passed |
| `@vid2context/ask` (34) | `askRoutes` | `/api/v1` | `/ask` and `/chat` |
| `@vid2context/jobs` (42) | `jobsRoutes` | `/api/v1` | only when `createApp({ jobs: { queue } })` is given a queue: the Node entry passes an in-process queue with the built-in kinds |
| `@vid2context/skips` (53) | `skipsRoutes` | `/api/v1` | |
| `@vid2context/research` (54) | `researchRoutes` | `/api/v1` | |
| `@vid2context/exporters` (57) | `exporterRoutes` | `/api/v1` | |
| `@vid2context/webhooks` (59) | `webhookRoutes` | `/api/v1` | |
| `@vid2context/mcp-http` (45) | `mcpHttpRoutes` | `/` | `/mcp`, `/oauth/*`, `/.well-known/*`; answers its own errors and keeps its own auth and CORS rules |

Not mounted yet, because the package does not export a factory: insights (32, `/briefs`, `/extract`), translation (35), chapters (36), the hosted-mode accounts middleware and routes (58), bots (56), live (61) and duplicates (62).

## Planned routes

The Owner column names the work item (see `docs/ROADMAP.md`) that implements the route.

Ownership rule for parallel work: **only item 46 edits `packages/server`.** An item whose own package backs routes (32 to 36, 40, 41, 42) exports a Hono sub-app factory from `src/http.ts` in that package, implementing exactly the paths below relative to `/api/v1`:

```ts
// packages/library/src/http.ts
import type { Ctx, Registry, Storage } from '@vid2context/core';
import { Hono } from 'hono';
export interface RouteDeps { registry: Registry; makeCtx: (req: Request) => Ctx; storage: (ctx: Ctx) => Promise<Storage> }
export function libraryRoutes(deps: RouteDeps): Hono { /* GET /collections, POST /collections, ... */ }
```

Item 46 mounts every sub-app that exists when it runs (`app.route('/api/v1', libraryRoutes(deps))`). A sub-app that lands later is mounted with a one-line additive change to `packages/server/src/app.ts`. Errors thrown inside a sub-app propagate to the main app's `onError`, so they get the standard body and status. Routes whose owner is 46 are built by 46 directly from core and provider APIs.

### Videos

| Method and path | Owner | Request | Response |
|---|---|---|---|
| `GET /metadata?url=` | 46, implemented | | `VideoMetadata` |
| `GET /formats` | 46, implemented | | `{ formats: { id, description, mimeType, extension }[] }` |
| `GET /items?url=&limit=` | 46 (uses 08, 13, 15), implemented | | `{ items: VideoRef[] }`: a playlist, channel, feed or page expanded to videos |
| `GET /section?url=&from=&to=&chapter=&format=` | 46 (uses 03), implemented | `from`/`to` in seconds or `m:ss`, or a chapter index | the rendered slice; `Content-Type` from the formatter |
| `GET /outline?url=` | 46 (uses 03), implemented | | `{ metadata, chapters: (Chapter & { tokens: number })[], totalTokens }` |
| `GET /comments?url=&limit=` | 46 (uses 09), implemented | | `{ comments: Comment[] }` |
| `GET /pack?url=` or `POST /pack` | 46 (uses 01), implemented | POST: `{ inputs?: string[], collectionId?: string, maxTokens?: number }` | `text/markdown`: the context pack |

### Library and collections

| Method and path | Owner | Request | Response |
|---|---|---|---|
| `GET /library?limit=&cursor=` | 46, implemented | | `Page<VideoSummary>` |
| `GET /library/:id` | 46, implemented | id URL-encoded (`youtube%3AjNQXAC9IVRw`) | `VideoContext` |
| `DELETE /library/:id` | 46, implemented | | `204` |
| `GET /collections` | 41 | | `{ collections: Collection[] }` |
| `POST /collections` | 41 | `{ name, description?, sources?: string[], watch?: Schedule }`; `sources` must be lists (playlist, channel, feed, page) | `201 Collection` |
| `GET /collections/:id` | 41 | | `Collection & { videos: VideoSummary[], pending: string[], watch: { schedule, state } \| null }` |
| `PATCH /collections/:id` | 41 | `{ name?, description?, sources?, watch?: Schedule \| null }` (`null` removes the watch list) | `Collection` |
| `DELETE /collections/:id` | 41 | | `204`; saved transcripts stay in the library |
| `POST /collections/:id/items` | 41 | `{ inputs: string[], limit? }` (videos or lists) | `202 Job` (kind `ingest`) when the server passes its jobs queue to `libraryRoutes({ jobs })`; without a queue it runs inline and answers `{ collection, summary: RefreshSummary }`. The job's result is that same object |
| `DELETE /collections/:id/items` | 41 | `{ videoIds: string[] }` | `Collection`; removed videos are not re-added by a refresh |
| `POST /collections/:id/refresh` | 41 | `{ limit? }` (optional body) | `202 Job` (kind `refresh`): re-expand `sources` and ingest new uploads. Without a queue: inline, `{ collection, summary: RefreshSummary }` |
| `GET /collections/:id/export` | 41 | | `CollectionDefinition`: `{ format: 'vid2context.collection', version: 1, name, description?, sources, videos: string[], schedule? }`, no transcripts |
| `POST /collections/import?refresh=` | 41 | `CollectionDefinition` | `201 { collection, summary? }`; `refresh=1` ingests at once, otherwise `videos` wait for the next refresh |
| `GET /search?q=&collectionId=&videoIds=&limit=` | 40 | `videoIds` comma-separated; `limit` 1 to 100 (default 10); optional `mode=hybrid\|keyword\|vector`, `rerank=1`, `channel=`, `origin=` (comma-separated), `publishedAfter=`, `publishedBefore=`; `q` takes `"phrases"` and `-excluded` words | `{ hits: (SearchHit & { url?, chapterTitle?, channel?, snippet, sources: ('keyword'\|'vector')[], ranks, rerankScore? })[], meta }`; `url` is a timestamp link, `snippet` has matches in `**bold**`, `meta` says which sides ran, the embedding model, `vector: ok\|partial\|disabled\|failed\|off` with a reason, rerank status and timings |

Collection types (`@vid2context/library`): `Schedule` is `{ every: 'hourly' | 'daily' | 'weekly' | { minutes: number }, at?: 'HH:MM' (UTC), enabled }`. `RefreshSummary` is `{ collectionId, added: VideoSummary[], skipped: number, failed: { input, code, message, hint?, cause? }[], remaining: number, checkedAt }`. Ingest and refresh jobs report `progress` `{ done, total, message }` and one `item` event `{ id, outcome: 'ok' | 'error', title?, error? }` per video. See [guides/collections.md](../guides/collections.md).

### Intelligence

| Method and path | Owner | Request | Response |
|---|---|---|---|
| `POST /briefs` | 32 | `{ collectionId?, inputs?: string[], question?, template?: string }` | `202 Job`; result `Brief` (claims with citations, consensus and disagreement) |
| `POST /extract` | 33 | `{ inputs?: string[], collectionId?, template?: string, schema?: object }` | `202 Job`; result JSON matching the template or schema, with citations |
| `POST /ask` | 34 | `{ question, collectionId?, inputs?: string[], stream?: boolean, history?: { role, content }[], model?: ModelChoice, maxTokens?, temperature? }` | `{ answer, citations: Citation[], unverified: number[], sources, rung, model, usage?, attempts }`, or `text/event-stream` with the `/chat` events when `stream` is true |
| `POST /chat` | 34 | `ChatApiRequest` (below) | `text/event-stream`: `meta`, `reasoning`*, `delta`+, then `done` or `error` (below) |
| `GET /transcript?...&lang=xx&translate=1` | 35 (logic), 46 (route) | `translate=1` allows LLM translation when the platform has no track in `lang` | as `/transcript`, rendered from `translateContext(registry, context, { language: lang }, ctx).transcript` (`@vid2context/translate`): the platform track first, else the LLM chain with every segment and timestamp kept and `translated: true`. Without `translate=1`, pass `{ llm: false }` so only platform tracks are used |
| `POST /chapters` | 36 | `{ url, force?, llm?, summaries?, lang? }` | `{ videoId, chapters: (Chapter & { endSec, summary? })[], producer, rung, model, source: 'auto', method, durationSec, notes, attempts }`. `rung` and `model` are `null` when the chapters are fully offline (`producer: 'chapters/texttiling'`). A video that already has chapters answers `bad-request` unless `force` is true. Sub-app: `chaptersRoutes` from `@vid2context/chapters/http` |

`Citation` is `{ videoId, title, startSec, endSec?, url?, quote? }`, where `url` is a timestamp link from `timestampUrl`. `/ask` and `/chat` add `n`, the `[n]` in the answer the citation backs; `startSec` is narrowed to the segment that best supports the citing sentence.

#### `POST /chat` (and `POST /ask` with `stream: true`)

Multi-turn, model-selectable answers grounded in videos. Implemented by `askRoutes` in [packages/ask/src/http.ts](../../packages/ask/src/http.ts); see [guides/ask.md](../guides/ask.md).

```ts
interface ChatApiRequest {
  messages: { role: 'user' | 'assistant'; content: string }[]; // oldest first, ending with the user's question
  /** Omit for Auto (the server's policy, free-first). */
  model?: { rung: string; strict?: boolean } | { policy: 'free' | 'quality' | 'local-only' };
  /** What to ground the answer in: URLs, ids like youtube:abc, or upload:<sha256>, and/or a collection. */
  context?: { inputs?: string[]; collectionId?: string };
  maxTokens?: number;
  temperature?: number;
}
```

`model.rung` with `strict: false` (the default) starts with that rung, then falls back along the chain; `strict: true` means that rung or an error. `/ask` takes the same `model`.

Events, in order (`event:` name, `data:` one JSON object). A comment line (`: keep-alive`) is sent every 15 seconds; a client disconnect aborts the upstream call.

| event | data |
|---|---|
| `meta` | `{ rung, model, contextTokens?, promptTokens, sources: { n, videoId, title, url?, startSec, endSec }[] }`; `contextTokens` is the answering rung's window |
| `reasoning` | `{ text }` (zero or more, only when the model exposes reasoning) |
| `delta` | `{ text }` (one or more) |
| `done` | `{ text, rung, model, usage?, citations: Citation[], unverified: number[], attempts }` |
| `error` | `{ code, message, hint?, attempts? }` (instead of `done`) |

The answer cites sources as `[n]`, matching `meta.sources[].n`. A number that matches no source is removed from the streamed text and from `done.text`, and listed in `done.unverified`. Request errors (bad body, unknown collection, a video that cannot be had) are answered before streaming with the standard error body and status; failures after streaming starts (every rung failed, a broken stream) arrive as an `error` event.

### Jobs

Long work (collection ingest, briefs, long audio) runs as a job. Owner: 42.

| Method and path | Request | Response |
|---|---|---|
| `POST /jobs` | `{ kind, input, options? }` | `202 Job` |
| `GET /jobs/:id` | | `Job` |
| `GET /jobs/:id/events` | | `text/event-stream` with events `progress` `{ done, total, message? }`, `item` `{ id, outcome }`, `done` `{ result }`, `error` `{ code, message, hint? }` |
| `DELETE /jobs/:id` | | `202 Job` (cancel requested) |
| `POST /jobs/:id/run` | `{ jobId }` with `Authorization: Bearer <Google OIDC token>` | `200 { outcome, job }`; only when the Cloud Tasks adapter is configured (otherwise `404`); `401` with the standard error body (`code: auth`) when the token fails verification |

Stream details (implemented in `packages/jobs/src/sse.ts`):

- Event ids are a per-job sequence starting at 1. A client that reconnects with `Last-Event-ID: n` receives only events after `n`.
- A fresh connection first replays the state: the `item` events so far, then the latest `progress` (or the final `done` or `error` of a finished job), then live events. A comment line `: heartbeat` is sent every 15 seconds. The stream closes after `done` or `error`.
- `item` may also carry `title` and, for failures, `error: { code, message, hint? }`; `outcome` is `ok`, `error` or `skipped`.
- A canceled job ends with `error` `{ code: 'canceled', ... }`, and its `Job.error` has the same value.
- Built-in kinds: `context` (input: one URL), `items` (input: a playlist, channel or feed; options `limit`, `concurrency`), `bundle` (input: a URL or an array of URLs). See `docs/guides/jobs.md`.

```ts
interface Job {
  id: string;
  kind: string; // 'ingest', 'refresh', 'brief', 'extract', 'transcribe-long', ...
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'canceled';
  progress?: { done: number; total?: number; message?: string };
  result?: unknown;
  error?: { code: string; message: string; hint?: string };
  createdAt: string; // ISO 8601
  updatedAt: string;
}
```

### Platform

| Method and path | Owner | Notes |
|---|---|---|
| `POST /mcp`, `GET /mcp` | 45 | Remote MCP over Streamable HTTP, the same tools as stdio (see `mcp-tools.md`) |
| `GET /openapi.json` | 46, implemented | OpenAPI 3.1 for every route the server serves |
| `GET /models?kind=` | 46, implemented | see [above](#get-apiv1modelskind) |
| `POST /uploads` | 46, implemented | see [above](#post-apiv1uploads) |
| `GET /bundle`, `POST /bundle` | 46, implemented | see [above](#get-apiv1bundleurlformatscommentsmaxtokens-and-post-apiv1bundle) |

### Auth and limits (owner: 45 and 46, implemented by 46 for `/api/*`)

- API keys: when `VID2CONTEXT_API_KEYS` is set (comma-separated), every `/api/*` route except `/health` requires `Authorization: Bearer <key>`; otherwise the server is open and the Node entry binds to 127.0.0.1 by default. Each entry is a plain key (full access) or a hashed entry `name:scope:sha256hex`, where the hex is the SHA-256 of the key and the scope is `read`, `write` or `admin`. `read` allows `GET` and the POST routes that only compute an answer (`/pack`, `/bundle`, `/ask`, `/chat`, `/research`, `/duplicates`, `/exports/obsidian`); `write` also allows every other POST, PUT, PATCH and DELETE; `admin` allows everything. Keys are compared by SHA-256 in constant time. Missing or wrong keys get `401 unauthorized`, a key without the scope `403 forbidden`. Logs name the key (`key-1` for the first plain key, or the hashed entry's name), never the key itself. `/mcp` and the OAuth paths use mcp-http's own credentials.
- Rate limiting: a token bucket per key (or per client IP in open mode) in a KvStore (`ratelimit:` keys; the storage's own KV when it has one, else process memory). `VID2CONTEXT_RATE_LIMIT` requests per minute (default 120, `0` off) with bursts of `VID2CONTEXT_RATE_BURST` (default half the rate). Over the limit: `429` with `Retry-After` and the standard error body (`code: rate-limited`). `/health` and CORS preflights are not limited. The client IP is the socket address on Node and `CF-Connecting-IP` on Workers; `X-Forwarded-For` and `X-Real-IP` count only with `VID2CONTEXT_TRUST_PROXY=1`.
- CORS is off by default; `VID2CONTEXT_CORS_ORIGINS` lists allowed origins (`https://vid2context.com`, `chrome-extension://<id>`, or `*`). Preflights are answered before auth. Allowed request headers: `Authorization`, `Content-Type`, `X-Request-Id`, `If-None-Match`; exposed: `X-Request-Id`, `Retry-After`, `ETag`, `Content-Disposition`, `X-Data-Attribution`, `X-RateLimit-*`.
- Body limits: `VID2CONTEXT_MAX_BODY_KB` (default 1024) for JSON bodies, the upload cap for `POST /uploads`; larger bodies get `413 too-large`.
- Timeout: a request that runs longer than `VID2CONTEXT_REQUEST_TIMEOUT_MS` (default 300000) is answered with `504 timeout`, and its Ctx signal aborts the providers' work.
- Public mode: with `VID2CONTEXT_PUBLIC=1`, inputs that are local paths, `file://` URLs or private addresses are refused with `unsupported-input` before any provider runs (route check plus the pipeline's own).
- Access logs: one JSON line per request on stderr: `ts`, `method`, `path`, `status`, `ms`, `requestId`, `key` (name), `ip`. `VID2CONTEXT_ACCESS_LOG=0` turns them off.
- Node shutdown: on `SIGTERM` or `SIGINT` the server stops accepting connections, lets in-flight requests finish for up to `VID2CONTEXT_SHUTDOWN_TIMEOUT_MS` (default 10000), closes MCP sessions and the jobs queue, then exits.

### Worker: site discovery (item 51)

The Worker entry (`packages/server/src/workers.ts`) sends `/api/*` and, with mcp-http mounted, its paths to the app; everything else is a static asset, through `serveSite` in `packages/server/src/discovery.ts`:

- A `GET` or `HEAD` whose `Accept` ranks `text/markdown` above `text/html` gets the page's `.md` twin (`/index.md` for `/`, then `<path>.md`, then `<path>/index.md`) with `Content-Type: text/markdown; charset=utf-8` and `Vary: Accept`. Without a twin, the HTML is served.
- HTML responses get `Vary: Accept` and `Link: </llms.txt>; rel="alternate"; type="text/plain", </api/v1/openapi.json>; rel="service-desc"; type="application/openapi+json", </mcp>; rel="service"` (the last only when mcp-http is mounted).
- `www` and `http` are redirected at the zone, not in code.

## Wave 2 routes (prompts 51 to 62)

Same conventions as above. Each package exports a Hono sub-app factory from its own `src/http.ts`; item 46, or the integration pass, mounts it under `/api/v1`.

| Method and path | Owner | Request | Response |
|---|---|---|---|
| `GET /skips?url=&categories=` | 53 | `categories` comma-separated | `{ segments: SkipSegment[], coveredSec, source: 'sponsorblock', attribution }` |
| `GET /transcript?...&skip=sponsor,selfpromo` | 53 (option), 46 (route), implemented | | the transcript with those segments removed; the raw transcript stays stored |
| `POST /research` | 54 | `{ urls: string[], query, contextSec?, maxExcerpts? }` | `{ results: { videoId, title, excerpts: { startSec, endSec, text, context, url? }[] }[] }` |
| `GET /caption-languages?url=` | 54 | | `{ tracks: CaptionTrackInfo[], translationTargets: { language, name }[] }` |
| `GET /key-moments?url=&count=` | 54 | | `{ moments: { startSec, title, why, url? }[], rung }` |
| `POST /bots/telegram` | 56 | Telegram update; `X-Telegram-Bot-Api-Secret-Token` checked | `200` |
| `POST /bots/discord` | 56 | Discord interaction; Ed25519 signature checked | interaction response |
| `POST /bots/slack/events`, `POST /bots/slack/commands` | 56 | Slack payloads; signing secret checked | `200` within 3 seconds |
| `POST /exports/notion` | 57 | `{ inputs?, collectionId?, parentPageId? }` | `{ pages: { videoId, url }[] }` |
| `POST /exports/obsidian` | 57 | `{ inputs?, collectionId? }` | `{ files: { path, content }[] }` (the caller writes them, or 15 zips them) |
| `GET /auth/github/login`, `GET /auth/github/callback`, `POST /auth/logout` | 58 | | session cookie; only the GitHub id and login are stored |
| `GET /me`, `GET /me/usage` | 58 | | `{ id, login, plan }`, `{ period, used, limits }` |
| `GET /me/keys`, `POST /me/keys`, `DELETE /me/keys/:id` | 58 | `{ name }` on POST | the key is shown once on creation, stored hashed |
| `GET /webhooks`, `POST /webhooks`, `DELETE /webhooks/:id`, `POST /webhooks/:id/test` | 59 | `{ url, events: string[] }` on POST | `Webhook` (the signing secret is shown once) |
| `GET /live?url=&maxMinutes=` | 61 | | `text/event-stream`: `segment`, `status`, `done`, `error` |
| `POST /duplicates` | 62 | `{ inputs?, collectionId? }` | `{ groups: { kind: 'reupload' \| 'clip', members: { videoId, offsetSec? }[], evidence }[] }` |

Hosted mode (58): when `VID2CONTEXT_HOSTED=1`, the accounts middleware runs in front of every route except `/health`, `/auth/*` and `/bots/*`, enforcing sessions or API keys, per-account quotas and per-IP limits.

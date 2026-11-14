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

`code` is a core `ErrorCode`, or `internal` for unexpected errors (status 500, no detail leaked). `hint` is present when there is a recovery step. `attempts` lists every provider and rung tried (empty when none ran).

| Code | Status | | Code | Status |
|---|---|---|---|---|
| `unsupported-input` | 400 | | `rate-limited` | 429 |
| `bad-request` | 400 | | `timeout` | 504 |
| `not-found` | 404 | | `blocked` | 503 |
| `unavailable` | 403 | | `no-provider` | 503 |
| `no-transcript` | 422 | | `all-rungs-failed` | 502 |
| `too-large` | 413 | | `auth` | 502 (an upstream key failed, not the caller) |
| | | | `upstream` | 502 |

The map lives in `STATUS_BY_CODE` in `app.ts`. Add new codes there and here together.

### Common query parameters

| Name | Meaning |
|---|---|
| `url` | Any input a source understands: a video URL, a YouTube id, a local path (Node only), later a feed or page URL. URL-encode it. |
| `mode` | `auto` (default), `captions`, `stt`, `video`. |
| `lang` | Preferred transcript language, BCP-47 (`en`, `de`, `pt-BR`). |
| `format` | A formatter id from the core `formatters` map. Never hard-code the list; `GET /api/v1/health` returns it. |
| `timestamps` | `1`, `true` or `yes` to prefix lines with timestamps where the format allows. |

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

### `GET /api/v1/transcript?url=&format=&timestamps=&mode=&lang=`

Returns the transcript rendered by the chosen formatter (default `text`) with that formatter's `mimeType` as `Content-Type`.

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
| `GET /metadata?url=` | 46 | | `VideoMetadata` |
| `GET /formats` | 46 | | `{ formats: { id, description, mimeType, extension }[] }` |
| `GET /items?url=&limit=` | 46 (uses 08, 13, 15) | | `{ items: VideoRef[] }`: a playlist, channel, feed or page expanded to videos |
| `GET /section?url=&from=&to=&chapter=&format=` | 46 (uses 03) | `from`/`to` in seconds or `m:ss`, or a chapter index | the rendered slice; `Content-Type` from the formatter |
| `GET /outline?url=` | 46 (uses 03) | | `{ metadata, chapters: (Chapter & { tokens: number })[], totalTokens }` |
| `GET /comments?url=&limit=` | 46 (uses 09) | | `{ comments: Comment[] }` |
| `GET /pack?url=` or `POST /pack` | 46 (uses 01) | POST: `{ inputs?: string[], collectionId?: string, maxTokens?: number }` | `text/markdown`: the context pack |

### Library and collections

| Method and path | Owner | Request | Response |
|---|---|---|---|
| `GET /library?limit=&cursor=` | 46 | | `Page<VideoSummary>` |
| `GET /library/:id` | 46 | id URL-encoded (`youtube%3AjNQXAC9IVRw`) | `VideoContext` |
| `DELETE /library/:id` | 46 | | `204` |
| `GET /collections` | 41 | | `{ collections: Collection[] }` |
| `POST /collections` | 41 | `{ name, description?, sources?: string[] }` | `201 Collection` |
| `GET /collections/:id` | 41 | | `Collection & { videos: VideoSummary[] }` |
| `PATCH /collections/:id` | 41 | `{ name?, description?, sources? }` | `Collection` |
| `DELETE /collections/:id` | 41 | | `204` |
| `POST /collections/:id/items` | 41 | `{ inputs: string[] }` (videos or lists) | `202 Job` (ingest runs as a job) |
| `DELETE /collections/:id/items` | 41 | `{ videoIds: string[] }` | `Collection` |
| `POST /collections/:id/refresh` | 41 | | `202 Job`: re-expand `sources` and ingest new uploads |
| `GET /search?q=&collectionId=&videoIds=&limit=` | 40 | `videoIds` comma-separated | `{ hits: (SearchHit & { url?: string })[] }`; `url` is a timestamp link |

### Intelligence

| Method and path | Owner | Request | Response |
|---|---|---|---|
| `POST /briefs` | 32 | `{ collectionId?, inputs?: string[], question?, template?: string }` | `202 Job`; result `Brief` (claims with citations, consensus and disagreement) |
| `POST /extract` | 33 | `{ inputs?: string[], collectionId?, template?: string, schema?: object }` | `202 Job`; result JSON matching the template or schema, with citations |
| `POST /ask` | 34 | `{ question, collectionId?, inputs?: string[], stream?: boolean, history?: { role, content }[], model?: ModelChoice, maxTokens?, temperature? }` | `{ answer, citations: Citation[], unverified: number[], sources, rung, model, usage?, attempts }`, or `text/event-stream` with the `/chat` events when `stream` is true |
| `POST /chat` | 34 | `ChatApiRequest` (below) | `text/event-stream`: `meta`, `reasoning`*, `delta`+, then `done` or `error` (below) |
| `GET /transcript?...&lang=xx&translate=1` | 35 | `translate=1` allows LLM translation when the platform has no track in `lang` | as `/transcript`; the transcript has `translated: true` |
| `POST /chapters` | 36 | `{ url }` | `{ chapters: Chapter[], producer, rung }` for videos without chapters |

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
| `GET /openapi.json` | 46 | OpenAPI 3.1 for every route on this page |

### Auth and limits (owner: 45 and 46)

- When `VID2CONTEXT_API_KEYS` is set (comma-separated), every route except `/health` requires `Authorization: Bearer <key>`; otherwise the server is open and binds to 127.0.0.1 by default.
- Rate limiting is per key (or per IP when open), answering `429` with `Retry-After` and the standard error body (`code: rate-limited`).
- CORS is off by default; `VID2CONTEXT_CORS_ORIGINS` lists allowed origins for the web app and the extension.

## Wave 2 routes (prompts 51 to 62)

Same conventions as above. Each package exports a Hono sub-app factory from its own `src/http.ts`; item 46, or the integration pass, mounts it under `/api/v1`.

| Method and path | Owner | Request | Response |
|---|---|---|---|
| `GET /skips?url=&categories=` | 53 | `categories` comma-separated | `{ segments: SkipSegment[], coveredSec, source: 'sponsorblock', attribution }` |
| `GET /transcript?...&skip=sponsor,selfpromo` | 53 (option), 46 (route) | | the transcript with those segments removed; the raw transcript stays stored |
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

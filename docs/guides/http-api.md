# HTTP API

One Hono app serves the API on Node (`npm run start:server`), Cloudflare Workers, Docker and the other hosts in [ARCHITECTURE.md](../ARCHITECTURE.md). Every route lives under `/api/v1`. The exact shapes are in [contracts/http-api.md](../contracts/http-api.md); `GET /api/v1/openapi.json` describes every route the running server has.

## Start it

```sh
npm run start:server                     # http://127.0.0.1:8787, reachable only from this machine
HOST=0.0.0.0 PORT=9000 npm run start:server
npm run dev:server                       # with reload
```

The examples below use:

```sh
API=http://127.0.0.1:8787/api/v1
```

On `SIGTERM` or `SIGINT` the server stops accepting connections, lets running requests finish (up to `VID2CONTEXT_SHUTDOWN_TIMEOUT_MS`, 10 s by default), closes MCP sessions and the jobs queue, then exits.

## Videos

`url` takes a video URL, a YouTube id, `upload:<sha256>` from an upload, or (on Node, not in public mode) a local file path. URL-encode it; `curl -G --data-urlencode` does that for you.

```sh
# Everything: metadata, timed transcript, attempts. Saved to the library.
curl -sG "$API/context" --data-urlencode "url=https://youtu.be/jNQXAC9IVRw"

# The transcript in a format (text, json, markdown, srt, vtt, pack; see /formats)
curl -sG "$API/transcript" --data-urlencode "url=https://youtu.be/jNQXAC9IVRw" -d format=srt
curl -sG "$API/transcript" --data-urlencode "url=jNQXAC9IVRw" -d timestamps=1 -d lang=en -d mode=captions

# Translated into German: the platform's track first, then LLM translation that keeps timestamps
curl -sG "$API/transcript" --data-urlencode "url=jNQXAC9IVRw" -d lang=de -d translate=1 -i

# Without sponsor reads and self-promotion (SponsorBlock); the stored transcript stays whole
curl -sG "$API/transcript" --data-urlencode "url=https://www.youtube.com/watch?v=CrO0Timw2z4" -d skip=sponsor,selfpromo

curl -sG "$API/metadata" --data-urlencode "url=jNQXAC9IVRw"          # no transcript fetched
curl -s  "$API/formats"
curl -sG "$API/items" --data-urlencode "url=https://www.youtube.com/playlist?list=PL..." -d limit=20

# What a video contains and what each part costs in tokens, then one part
curl -sG "$API/outline" --data-urlencode "url=jNQXAC9IVRw"
curl -sG "$API/section" --data-urlencode "url=jNQXAC9IVRw" -d from=0:05 -d to=0:15 -d timestamps=1
curl -sG "$API/section" --data-urlencode "url=jNQXAC9IVRw" -d chapter=0 -d format=markdown

curl -sG "$API/comments" --data-urlencode "url=jNQXAC9IVRw" -d limit=20

# One Markdown file sized for a token budget, with citation instructions for the model
curl -sG "$API/pack" --data-urlencode "url=jNQXAC9IVRw" -d maxTokens=8000
curl -s  "$API/pack" -H 'content-type: application/json' \
  -d '{"inputs": ["https://youtu.be/jNQXAC9IVRw", "https://www.youtube.com/playlist?list=PL..."], "maxTokens": 50000}'

# A .zip with context.md, transcripts in every format, metadata and a manifest
curl -sG "$API/bundle" --data-urlencode "url=jNQXAC9IVRw" -d formats=markdown,srt -OJ
curl -s  "$API/bundle" -H 'content-type: application/json' -d '{"collectionId": "talks-1a2b3c4d"}' -OJ
```

`POST /pack` and `POST /bundle` take `inputs` (playlists and channels are expanded) and/or a `collectionId`, up to 100 videos per request. Larger sets belong in a collection and a job.

Identical requests that arrive together share one run, and finished contexts come from the library afterwards, so retrying a slow request is cheap. `refresh=1` rebuilds.

## Library

```sh
curl -s "$API/library?limit=20"
curl -s "$API/library/youtube%3AjNQXAC9IVRw"                    # ids are URL-encoded once
curl -s "$API/library/youtube%3AjNQXAC9IVRw" -H 'if-none-match: "<etag>"' -i   # 304 when unchanged
curl -s -X DELETE "$API/library/youtube%3AjNQXAC9IVRw" -i       # 204
```

`GET /context` and `GET /library/:id` send an `ETag`; send it back as `If-None-Match` to get `304 Not Modified` without the body.

## Models

```sh
curl -s "$API/models"             # every rung, enabled or not, and the default policy
curl -s "$API/models?kind=llm"    # llm, stt, embed, video or visual
```

Each entry says its tier (local, free, keyless, paid), whether it is enabled, and which env vars it needs (names only, never values). Pass an `id` back as the `rung` of a chat request.

## Uploads

```sh
curl -s "$API/uploads" -F file=@talk.mp3
# {"input":"upload:9f86d0...","filename":"talk.mp3","bytes":145412,"mimeType":"audio/mpeg","expiresAt":"..."}

curl -sG "$API/context" --data-urlencode "url=upload:9f86d0..."
curl -s  "$API/pack" -H 'content-type: application/json' -d '{"inputs": ["upload:9f86d0..."]}'
```

- The cap is `VID2CONTEXT_MAX_UPLOAD_MB` (100 MB by default, the Workers free-plan request limit); larger files get `413 too-large`.
- Uploads are kept for `VID2CONTEXT_UPLOAD_TTL_MIN` minutes (60). On Cloudflare with an R2 bucket bound (`VID2CONTEXT_R2`) they live in R2 and every isolate sees them; elsewhere they live in the server's memory and are lost on restart. They never enter the library.
- Uploads are transcribed with the speech-to-text chain (mode `auto` or `stt`). Reduce large video files to audio before uploading: speech-to-text services take about 25 MB per request, and mono audio at 64 kbit/s is about 30 MB per hour. The web app does this in the browser. With ffmpeg: `ffmpeg -i talk.mp4 -vn -ac 1 -b:a 64k talk.mp3`.

## More routes

Mounted from other packages, documented in their guides: collections ([collections.md](collections.md)), search ([search.md](search.md)), ask and chat ([ask.md](ask.md)), briefs and extraction, auto-chapters and translation ([translate-and-chapters.md](translate-and-chapters.md)), jobs ([jobs.md](jobs.md)), SponsorBlock skips, research, exports, webhooks, and the remote MCP server at `/mcp` ([remote-mcp.md](remote-mcp.md)).

```sh
curl -s "$API/openapi.json" | jq '.paths | keys'
```

## API keys

Without `VID2CONTEXT_API_KEYS` the server is open, which is why the Node entry binds to 127.0.0.1 by default. Set keys before exposing it:

```sh
# .env
VID2CONTEXT_API_KEYS=7wq0yA0e...long-random-key...
```

```sh
curl -s "$API/formats" -H "authorization: Bearer $KEY"
```

Plain keys have full access. To keep keys out of the config, or to hand out read-only keys, list hashed entries `name:scope:sha256hex`:

```sh
KEY=$(openssl rand -base64 32)
printf %s "$KEY" | sha256sum            # the hex goes into the entry
VID2CONTEXT_API_KEYS=ci-reader:read:3b5d...e1,ingest:write:9a41...7c
```

| Scope | Allows |
|---|---|
| `read` | `GET`, and POSTs that only compute an answer: `/pack`, `/bundle`, `/ask`, `/chat`, `/research`, `/duplicates`, `/exports/obsidian` |
| `write` | also every other POST, PUT, PATCH and DELETE (uploads, collections, jobs, library deletes) |
| `admin` | everything |

A missing or wrong key gets `401 unauthorized` (with `WWW-Authenticate: Bearer`); a key without the scope gets `403 forbidden`. `/api/v1/health` is always open. Access logs name the key (`key-1` for the first plain key, or the hashed entry's name), never the key itself. `/mcp` has its own credentials (`VID2CONTEXT_MCP_TOKENS` or OAuth, see [remote-mcp.md](remote-mcp.md)).

In hosted mode (`VID2CONTEXT_HOSTED=1`), `@vid2context/accounts` takes over: GitHub sign-in sessions, `v2c_` keys made at `/api/v1/me/keys`, the anonymous plan, per-IP limits and daily quotas. `VID2CONTEXT_API_KEYS` and the server's own rate limit are then not used.

## Rate limits

Each key (or each client IP without keys) gets a token bucket: `VID2CONTEXT_RATE_LIMIT` requests per minute (120), with bursts of `VID2CONTEXT_RATE_BURST` (60). Responses carry `X-RateLimit-Limit` and `X-RateLimit-Remaining`; over the limit the answer is `429` with `Retry-After` in seconds and the usual error body:

```json
{ "error": { "code": "rate-limited", "message": "Too many requests: ...", "hint": "Wait 2 s before retrying (see Retry-After)." }, "attempts": [] }
```

Buckets live in the storage backend's key-value store when it has one (SQLite, D1, Postgres), so they hold across restarts and Worker isolates; otherwise in memory. On Node the client IP is the socket address; behind your own reverse proxy set `VID2CONTEXT_TRUST_PROXY=1` to use `X-Forwarded-For`. On Workers it is `CF-Connecting-IP`. `VID2CONTEXT_RATE_LIMIT=0` turns the limit off.

## CORS: the web app and the extension

CORS is off by default. The web app served from the same origin (`/app/` next to `/api/v1`) needs nothing. A web app on another origin, a local dev server, or the browser extension needs its origin listed:

```sh
VID2CONTEXT_CORS_ORIGINS=https://vid2context.com,http://localhost:5173,chrome-extension://abcdefghijklmnopabcdefghijklmnop
```

The extension's origin is `chrome-extension://<its id>` (Chrome, Edge) or `moz-extension://<uuid>` (Firefox, different per install). `*` allows any origin; with API keys that still means every caller needs a key. Preflight requests are answered before the key check. Browsers may send `Authorization`, `Content-Type`, `X-Request-Id` and `If-None-Match`, and may read `X-Request-Id`, `Retry-After`, `ETag`, `Content-Disposition` (for bundle downloads), `X-Data-Attribution`, `X-Translated-Via` and the rate-limit headers.

## Errors, request ids and logs

Every error has the same body: `{ error: { code, message, hint? }, attempts }`, where `attempts` lists every provider and rung that was tried and why it failed. Status codes per error code are in the contract. Unexpected errors are `500 internal` without details.

Send `X-Request-Id` to tag a request (letters, digits, `._:-`, up to 128 characters); the server returns it, or a new UUID, on every response. Each request writes one JSON line to stderr:

```json
{"ts":"2026-11-14T17:00:00.000Z","level":"info","msg":"request","requestId":"1f0c...","method":"GET","path":"/api/v1/transcript","status":200,"ms":812,"key":"ci-reader","ip":"203.0.113.7"}
```

`VID2CONTEXT_ACCESS_LOG=0` turns these off. Requests that run past `VID2CONTEXT_REQUEST_TIMEOUT_MS` (5 minutes) are answered with `504 timeout`; finished work is cached, so a retry picks it up. Bodies over `VID2CONTEXT_MAX_BODY_KB` (1024) get `413 too-large`.

## Public deployments

Set `VID2CONTEXT_PUBLIC=1` on any server other people can reach: local file paths, `file://` and URLs pointing at private or cloud metadata addresses are then refused with `unsupported-input` before any provider runs. All `/api/*` responses carry `X-Robots-Tag: noindex`.

On the Cloudflare Worker, pages other than the API answer agents that prefer Markdown (`Accept: text/markdown`) with the page's `.md` twin, and HTML pages carry a `Link` header pointing at `/llms.txt`, `/api/v1/openapi.json` and `/mcp`. See [discovery.md](discovery.md).

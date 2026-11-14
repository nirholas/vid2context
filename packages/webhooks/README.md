# @vid2context/webhooks

Signed, retried outbound webhooks for vid2context events, so n8n, Zapier, Make or your own code hear about new videos, collection updates, finished jobs and briefs. Requests follow the [Standard Webhooks](https://www.standardwebhooks.com/) specification, so any of its libraries can verify them.

No service or key is needed.

## Events

| Type | When | `data` |
|---|---|---|
| `video.ingested` | a video was fetched and saved | `{ video, collectionId?, jobId? }` |
| `collection.updated` | a collection gained or lost videos (a watch list refresh found new uploads) | `{ collection: { id, name, videoCount, links }, added: video[], removed: string[], checkedAt? }` |
| `job.succeeded`, `job.failed` | a background job finished | `{ job: { id, kind, status, error?, createdAt, updatedAt, links } }` |
| `brief.ready` | a cited brief is ready | `{ brief: { id, jobId?, collectionId?, question?, template?, claims?, videoCount?, links } }` |
| `test.ping` | `POST /webhooks/:id/test` only, sent regardless of the hook's events | `{ webhookId, message }` |

A `video` is `{ id, title, url?, platform, channel?, durationSec?, origin?, language?, links: { context, transcript } }`.

Every body is `{ "type", "timestamp", "data" }`. Payloads carry ids, titles and links to the API, never transcripts or job results: fetch `links.context`, `links.transcript` or `links.job` for those. Links are paths (`/api/v1/library/youtube%3AcCPsdFdlshc`) unless `VID2CONTEXT_WEBHOOKS_BASE_URL` is set, which makes them absolute.

```json
{
  "type": "collection.updated",
  "timestamp": "2026-11-14T12:00:00.000Z",
  "data": {
    "collection": { "id": "g-wagon-1a2b3c4d", "name": "G-Wagon", "videoCount": 1, "links": { "collection": "/api/v1/collections/g-wagon-1a2b3c4d" } },
    "added": [
      {
        "id": "youtube:cCPsdFdlshc",
        "title": "Best & Worst G-Wagon Years: Reliability, Interiors & Engines Ranked!",
        "url": "https://www.youtube.com/watch?v=cCPsdFdlshc",
        "platform": "youtube",
        "channel": "Alliance Motorworks",
        "durationSec": 1084,
        "origin": "auto-captions",
        "language": "en",
        "links": { "context": "/api/v1/library/youtube%3AcCPsdFdlshc", "transcript": "/api/v1/transcript?url=https%3A%2F%2Fwww.youtube.com%2Fwatch%3Fv%3DcCPsdFdlshc" }
      }
    ],
    "removed": [],
    "checkedAt": "2026-11-14T12:00:00.000Z"
  }
}
```

## HTTP routes

Mounted under `/api/v1` from `webhookRoutes(deps)` in [src/http.ts](src/http.ts).

| Method and path | Body | Response |
|---|---|---|
| `GET /webhooks` | | `{ webhooks: Webhook[] }` (no secrets) |
| `POST /webhooks` | `{ url, events: string[], description? }` | `201 Webhook & { secret }`: the only time the secret is shown |
| `DELETE /webhooks/:id` | | `204`, or `404` |
| `POST /webhooks/:id/test` | | `{ delivered, messageId, status?, error?, ms, webhook }` |

`events` takes the types above or `"*"` for all. A `Webhook` is `{ id, url, events, description?, createdAt, failures, disabledAt?, disabledReason?, lastAttemptAt?, lastStatus?, lastError? }`.

```sh
curl -s -X POST http://127.0.0.1:8787/api/v1/webhooks \
  -H 'content-type: application/json' \
  -d '{"url":"https://example.com/hook","events":["collection.updated"]}'
```

## Signing

Each attempt carries three headers:

| Header | Value |
|---|---|
| `webhook-id` | `msg_...`, the same on every retry of one event (use it to drop duplicates) |
| `webhook-timestamp` | Unix seconds of this attempt |
| `webhook-signature` | `v1,<base64 HMAC-SHA256>` of `${webhook-id}.${webhook-timestamp}.${raw body}` |

The key is the base64 part of the secret (`whsec_` plus 24 random bytes). Signing uses WebCrypto, so it runs on Node, Workers and in the browser. Tests check it against the Standard Webhooks published vectors and against the official `standardwebhooks` library in both directions.

## Receiving

Verify against the raw body exactly as received (parsing and re-serializing JSON changes the bytes), and reject timestamps more than 5 minutes off:

```ts
import { verifyWebhook } from '@vid2context/webhooks';

const payload = await verifyWebhook(process.env.HOOK_SECRET!, request.headers, await request.text());
// throws a bad-request Vid2ContextError when the signature or timestamp is wrong
```

Or with the official library in any language, for example `new Webhook(secret).verify(rawBody, headers)` from the `standardwebhooks` npm package. Answer with any 2xx within 10 seconds; do slow work after answering.

## Delivery and retries

- Success is any 2xx. Redirects are not followed (a 3xx is a failure: update the URL).
- Network errors, timeouts (10 s), 5xx and 429 are retried: attempts at about 0 s, 30 s, 5 min, 30 min, 2 h and 8 h, each with up to 20% jitter. A longer `Retry-After` wins. Other 4xx answers end that message.
- `410 Gone` disables the hook at once. 20 consecutive failed attempts disable it too. A successful `POST /webhooks/:id/test` re-enables it.
- The URL is checked again before every attempt.
- Retries run in this process with `setTimeout` by default, so pending retries are lost when the process restarts, and on Workers they end with the request. Pass a `scheduler` (anything with `schedule(task, delayMs)`, where the task is plain JSON) to keep them durable, and call `deliverTask(task, store, ctx)` when one comes due. The jobs package has no delayed enqueue yet, so there is no built-in durable scheduler.

## Where events come from

Emitters call `webhookEmitter(store, ctx).on(type, data)`, which never throws (failures are logged to stderr). These builders make the `data` from core types without transcripts: `videoIngestedData(context)`, `collectionUpdatedData(collection, { added, removed, checkedAt })`, `jobData(job)`, `briefReadyData(brief)`.

Share one store between the routes and the emitters with `webhookStoreResolver({ storage })` and pass it as `stores` to `webhookRoutes`. The store keeps hooks under `webhooks:` keys in the storage backend's KvStore, or in process memory when the backend has none.

## SSRF protection

Hooks make the server send requests to a URL a caller chose, so targets are checked with the core URL policy (`checkUrl` from `packages/core/src/security`): only `https:`, no credentials in the URL, no loopback, private, link-local, CGNAT, multicast, reserved or cloud metadata addresses, as IP literals (including decimal, octal, hex and IPv4-mapped forms) and, on Node, in DNS answers. Workers has no DNS API, so there only literal and name checks apply.

`VID2CONTEXT_WEBHOOKS_ALLOW_LOCAL=1` allows `http:` and hosts on this machine or the private network, for a self-hosted n8n. Link-local and metadata addresses stay refused. A DNS server that answers differently between the check and the request (DNS rebinding) is not stopped.

## Environment

| Variable | Effect |
|---|---|
| `VID2CONTEXT_WEBHOOKS_ALLOW_LOCAL` | `1` allows `http:` and local or private targets |
| `VID2CONTEXT_WEBHOOKS_BASE_URL` | public base URL of the API, for absolute payload links |

## Tests

`npx vitest run packages/webhooks` signs the published vectors, delivers to a real HTTP server started on a random port (success, a 500 then success, a 429 with `Retry-After`, a timeout, disabling after 20 failures and on 410, redirects) and checks SSRF rejections. `LIVE=1` adds DNS checks against public names that point at private addresses (`localtest.me`, `nip.io`).

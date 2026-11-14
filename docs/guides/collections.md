# Collections and watch lists

A collection groups videos on one topic and can follow sources: YouTube playlists and channels, podcast feeds, pages, anything a source provider can list. A refresh expands every source and ingests only what the collection has not seen yet, through the normal free-first pipeline (captions first, speech-to-text only when there are none). A watch list refreshes on a schedule, and a webhook hears about every new video.

Code: [packages/library](../../packages/library/). HTTP routes: the collection rows in [contracts/http-api.md](../contracts/http-api.md). MCP tools: `list_collections`, `create_collection`, `add_to_collection`, `get_collection` in [contracts/mcp-tools.md](../contracts/mcp-tools.md).

## Walkthrough: a G-Wagon research collection

Over HTTP (`npm run dev:server`, port 8787):

```sh
API=http://127.0.0.1:8787/api/v1

# 1. Create the collection and follow the series playlist.
curl -s -X POST $API/collections -H 'content-type: application/json' \
  -d '{"name": "G-Wagon", "sources": ["https://www.youtube.com/playlist?list=PLHeawKfarQSPKIjpe86at3Ttc2sz7uD_b"]}'
# -> 201 {"id": "g-wagon-1f661f13", "sources": [...], "videoIds": [], ...}

# 2. Ingest every video in the playlist.
curl -s -X POST $API/collections/g-wagon-1f661f13/refresh
# -> 202 Job (kind "refresh") when the server runs the jobs queue: follow GET /jobs/:id/events.
#    Without a queue: {"collection": ..., "summary": {"added": [...], "skipped": 0, "failed": [...], ...}}

# 3. Check every day at 06:00 UTC for new episodes.
curl -s -X PATCH $API/collections/g-wagon-1f661f13 -H 'content-type: application/json' \
  -d '{"watch": {"every": "daily", "at": "06:00"}}'

# 4. List what is in it.
curl -s $API/collections/g-wagon-1f661f13
# -> the collection plus "videos": [{ "id": "youtube:cCPsdFdlshc", "title": "Best & Worst G-Wagon Years: ...", "origin": "auto-captions", ... }]
```

From an agent over MCP: `create_collection { name: "G-Wagon", sources: [...] }`, then `add_to_collection { collection, urls: [<playlist URL>] }`, then `get_collection`. Search and cite with `search_transcript { query, collection }`.

From TypeScript:

```ts
import { MemoryStorage } from '@vid2context/core';
import { createNodeContext, createRegistry } from '@vid2context/registry/node';
import { createLibrary } from '@vid2context/library';

const registry = createRegistry();
const ctx = createNodeContext();
const lib = createLibrary({ registry, ctx, storage: (await registry.openStorage(ctx)) ?? new MemoryStorage() });

const c = await lib.createCollection({ name: 'G-Wagon' });
await lib.addSource(c.id, 'https://www.youtube.com/playlist?list=PLHeawKfarQSPKIjpe86at3Ttc2sz7uD_b');
const summary = await lib.refresh(c.id, { onProgress: (p) => console.error(`${p.done}/${p.total} ${p.message}`) });
```

What the live run on 2026-11-14 from a GCP VM returned: the playlist expanded to its 9 videos, and YouTube answered every caption download with HTTP 429 (its block on datacenter IPs), so all 9 came back in `failed` with `code: "no-transcript"` and `cause: "youtube-captions blocked: ... HTTP 429 ..."`. Nothing was added, and the next refresh retries them. From a home connection, or with the yt-dlp provider and a speech-to-text rung installed, they ingest. See [youtube.md](youtube.md) for blocks.

## Sources

`addSource(id, input)` (or `sources` on create and PATCH) accepts only lists: the input must resolve to a playlist, channel, feed or page, and its source provider must be able to list it. A single video is refused with `bad-request` (add it as an item instead), and an input no provider understands with `unsupported-input`. Different spellings of the same list are stored once. `removeSource` stops following a list; videos already ingested stay.

## Items

`POST /collections/:id/items { inputs }`, MCP `add_to_collection`, or `lib.addVideos(id, inputs)`: each input is a video or a list (lists are expanded). Videos already in the collection are skipped. `DELETE /collections/:id/items { videoIds }` removes videos and remembers them, so a later refresh does not bring them back; adding one explicitly does. Saved transcripts stay in the library either way.

## Refresh

`refresh(id, { limit?, concurrency?, delayMs?, onProgress? })`:

1. Expands every source (plus inputs queued by an import).
2. Keeps the items that are neither in the collection nor in its seen set.
3. Fetches them with at most `concurrency` (default 3) at a time and a pause of `delayMs` (default 300) between items on each worker, adding each success to the collection as it lands.
4. Records each failure (`input`, `code`, `message`, `hint`, `cause`) and keeps going. Failures are retried on the next refresh.

It returns `{ collectionId, added: VideoSummary[], skipped, failed, remaining, checkedAt }` and reports progress as `{ done, total, message }`, the Job progress shape. Running it twice adds nothing the second time. One process never runs two refreshes of the same collection at once: a second call joins the first.

Limits: `VID2CONTEXT_MAX_PLAYLIST_ITEMS` (default 500, a core limit) caps the items read from each source and the items ingested per run. `limit` lowers the per-run cap; items beyond it are counted in `remaining` and picked up next time.

## Watch lists

A schedule per collection, stored under `library:watch:<id>` in the KvStore (the storage backend when it implements one, else process memory):

```json
{ "every": "hourly" | "daily" | "weekly" | { "minutes": 30 }, "at": "06:00", "enabled": true }
```

`at` is a UTC time of day (hourly schedules use only its minutes). Without `at`, a new watch list is due at once and then every period after each check. With `at`, it runs at the next matching slot, then at the same time the next day (or week). `minutes` is 5 or more. State lives under `library:state:<id>`: `{ seenIds, lastCheckedAt, lastError, nextDueAt }`.

Set it with `PATCH /collections/:id { "watch": {...} }` (`null` removes it), `POST /collections { ..., "watch": {...} }`, or `lib.setWatch(id, schedule)`.

Something has to call `lib.runDue(now)`, which refreshes every enabled collection whose `nextDueAt` has passed, one at a time:

- Node, in a long-running process: `startScheduler(lib, { intervalMs: 60_000 })` returns `{ stop() }`. The timer is unref'd, and `stop()` waits for a run in progress.
- Cloudflare Workers: `export default { scheduled: scheduledHandler({ library: (env) => createLibrary(...) }) }` with a cron trigger. It runs at the cron's scheduled time and keeps the Worker alive until webhooks are sent.

Calling `runDue` from several processes at once is safe: each collection is taken under a lease (`library:lease:<id>`, one hour TTL, so a crashed run frees it), and a collection someone else holds is reported as `leased` and left alone. On a KvStore without atomic writes (Cloudflare KV is eventually consistent) the lease is best effort; refreshes are idempotent, so a rare double run only costs requests.

## Webhooks

Set `VID2CONTEXT_WEBHOOK_URL` and `VID2CONTEXT_WEBHOOK_SECRET`. After a refresh that adds videos, vid2context POSTs:

```json
{ "collection": { "id": "g-wagon-1f661f13", "name": "G-Wagon" }, "added": [ { "id": "youtube:cCPsdFdlshc", "title": "...", "ref": { "url": "https://www.youtube.com/watch?v=cCPsdFdlshc" }, "origin": "auto-captions", "language": "en", "savedAt": "..." } ], "checkedAt": "2026-11-14T06:00:12.000Z" }
```

with headers `X-Vid2context-Signature: sha256=<hex HMAC-SHA256 of the raw body, keyed with the secret>` and `X-Vid2context-Timestamp: <unix seconds>`. 5xx, 429 and network errors are retried with exponential backoff (4 attempts, 1 s base); 4xx is not retried. A failed delivery is logged and never fails or slows the refresh result.

Verify the signature over the raw body, before parsing it:

```js
import { createHmac, timingSafeEqual } from 'node:crypto';

function verify(rawBody, header, secret) {
  const expected = Buffer.from(`sha256=${createHmac('sha256', secret).update(rawBody).digest('hex')}`);
  const got = Buffer.from(header ?? '');
  return got.length === expected.length && timingSafeEqual(got, expected);
}
```

```python
import hashlib, hmac

def verify(raw_body: bytes, header: str, secret: str) -> bool:
    expected = "sha256=" + hmac.new(secret.encode(), raw_body, hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, header or "")
```

The signature covers the body only. To refuse replays, also reject requests whose timestamp header is more than a few minutes old, and ignore `added` ids you have already handled. In JS, `verifySignature(body, secret, header)` from `@vid2context/library` does the comparison.

These two variables are a simple per-deployment hook for new collection items. For per-user subscriptions to many event types, see the webhooks package (`/webhooks` routes).

## Import and export

`GET /collections/:id/export` (or `lib.exportCollection(id)`) returns a portable definition, without transcripts:

```json
{
  "format": "vid2context.collection",
  "version": 1,
  "name": "G-Wagon",
  "description": "Buying research",
  "sources": ["https://www.youtube.com/playlist?list=PLHeawKfarQSPKIjpe86at3Ttc2sz7uD_b"],
  "videos": ["https://www.youtube.com/watch?v=jNQXAC9IVRw"],
  "schedule": { "every": "daily", "at": "06:00", "enabled": true }
}
```

`POST /collections/import` (or `lib.importCollection(json)`) validates everything first (`bad-request` with a hint, nothing created), then creates the collection, sets its schedule, and queues `videos` for the next refresh. Add `?refresh=1` (`{ refresh: true }`) to ingest at once. Videos whose transcript is not saved in the library are left out of an export, because only a saved context knows its URL.

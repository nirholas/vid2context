# Cloudflare: Workers AI and D1, R2, KV storage

vid2context.com runs as one Cloudflare Worker. Two provider packages let that Worker use Cloudflare's own free AI and storage:

- `providers/cloudflare-ai`: Whisper speech-to-text, LLM chat and bge-m3 embeddings through the Workers AI binding inside a Worker, and Whisper over REST anywhere else.
- `providers/storage-cloudflare`: the library (saved contexts, collections, transcript search, key-value state) on D1, with R2 for large contexts and uploads, and KV for small state.

## How bindings reach providers

A Worker gets its bindings (`env.AI`, `env.DB`, ...) as objects next to its string vars. `createWorkersContext(env)` from `@vid2context/registry/workers` keeps string values in `ctx.env` and passes every other value through as `ctx.bindings`. Providers decide whether they are enabled from string env alone, so each piece is turned on by a var that names its binding, and the binding is looked up in `ctx.bindings` when it is used:

| Var (string, in `vars`) | Turns on | Reads binding |
|---|---|---|
| `CLOUDFLARE_AI_BINDING=AI` | Workers AI binding rungs: `stt/cloudflare-binding/...`, `llm/cloudflare-binding/...`, `embed/cloudflare-binding/...` | `ctx.bindings.AI` |
| `VID2CONTEXT_D1=DB` | the D1 storage backend (priority 20, ahead of `MemoryStorage`) | `ctx.bindings.DB` |
| `VID2CONTEXT_R2=MEDIA` | R2 for contexts over 1,000,000 bytes of JSON, and `putBlob` / `getBlob` / `deleteBlob` for uploaded media | `ctx.bindings.MEDIA` |
| `VID2CONTEXT_KV=KV` | Workers KV as the storage's `KvStore` (without it, a D1 table) | `ctx.bindings.KV` |

If a var names a binding that is missing, the call fails with `no-provider` and a hint showing the `wrangler.jsonc` entry to add. `VID2CONTEXT_STORAGE=memory` (or another backend's name) turns the D1 backend off.

## wrangler.jsonc

The bindings the deployed Worker needs, for the owner of the root `wrangler.jsonc` to adopt. Create the resources first:

```sh
npx wrangler d1 create vid2context          # prints the database_id
npx wrangler r2 bucket create vid2context
npx wrangler kv namespace create vid2context # prints the id
```

```jsonc
{
  "ai": { "binding": "AI" },
  "d1_databases": [
    {
      "binding": "DB",
      "database_name": "vid2context",
      "database_id": "<from wrangler d1 create>",
      "migrations_dir": "providers/storage-cloudflare/migrations"
    }
  ],
  "r2_buckets": [{ "binding": "MEDIA", "bucket_name": "vid2context" }],
  "kv_namespaces": [{ "binding": "KV", "id": "<from wrangler kv namespace create>" }],
  "vars": {
    "CLOUDFLARE_AI_BINDING": "AI",
    "VID2CONTEXT_D1": "DB",
    "VID2CONTEXT_R2": "MEDIA",
    "VID2CONTEXT_KV": "KV"
  }
}
```

The Worker entry must build its context with `createWorkersContext(env, signal)` (it already does), and the server needs no other change: storage comes from the registry's enabled storage provider.

## Migrations

The schema is in `providers/storage-cloudflare/migrations/` (numbered `.sql` files). Apply it with:

```sh
npx wrangler d1 migrations apply vid2context --remote   # or --local for wrangler dev
```

The same statements are built into the package, and the storage checks the `schema_version` table when it starts and applies anything missing, so a fresh database also works without the command. Every statement is idempotent. `src/migrations.ts` is the source; a test keeps the `.sql` files identical to it.

Tables: `videos` (one row per saved context, with the context JSON or an R2 key), `segments` (one row per transcript segment), `segments_fts` (an FTS5 index over segment text, kept in sync by triggers), `collections`, `collection_items`, `kv` (key-value state when no KV namespace is bound), `vector_chunks` (reserved for a vector index) and `schema_version`.

## What the storage does

- Search uses FTS5 with `bm25` ranking. The query is reduced to words (letters and digits), each quoted, joined with OR, so FTS5 syntax in user input is never interpreted. `collectionId` and `videoIds` narrow the search.
- Listing is newest first with an opaque cursor.
- Deleting a context also deletes its segments, search rows, collection memberships and R2 object. Deletes of unknown ids do nothing, as in `MemoryStorage`; collection updates on unknown ids throw `not-found`.
- KV TTLs: Workers KV rejects `expirationTtl` below 60 seconds, so shorter TTLs are raised to 60. The D1 fallback table honours any TTL.
- Not included: a Vectorize-backed `VectorStore`. Miniflare has no local Vectorize engine, so it could not be verified without creating a real index; until then the storage does not claim `VectorStore`, and callers fall back to `MemoryVectors`.

## Binding versus REST

| | Inside a Worker (binding) | Node, browser or a Worker without the binding (REST) |
|---|---|---|
| Speech-to-text | `stt/cloudflare-binding/<model>` | `stt/cloudflare/<model>` with `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` |
| LLM | `llm/cloudflare-binding/<model>` (with streaming) | `llm/cloudflare/...` in `providers/llm-free-catalog` |
| Embeddings | `embed/cloudflare-binding/@cf/baai/bge-m3` | `embed/cloudflare/...` in `providers/embed` |

Binding rungs need no token and skip a network hop. On Node, local rungs still come first under the default `free` policy; the REST rungs sit in the free tier with the other hosted free options.

Model input formats, verified against the live models on 2026-11-14: `whisper-large-v3-turbo` takes base64 audio in JSON and returns segments, words and the language; the older `whisper` takes raw audio bytes over REST (a byte array through the binding) and returns words, which are grouped into segments. Chat models return OpenAI-shaped `choices` and also a `response` field, which JSON mode returns already parsed. Workers AI defaults `max_tokens` to 256, so the rungs ask for 4,096 unless the caller sets `maxTokens`.

## Free allocations (checked 2026-11-14)

| Service | Free allocation | Source |
|---|---|---|
| Workers AI | 10,000 neurons per day on Free and Paid plans, reset 00:00 UTC. Whisper large-v3-turbo about 47 neurons per audio minute; bge-m3 about 1,075 neurons per million tokens | developers.cloudflare.com/workers-ai/platform/pricing |
| D1 (Free plan) | 5 million rows read and 100,000 rows written per day, 5 GB total, 500 MB per database, 10 databases. A row is at most 2,000,000 bytes; a query takes at most 100 bound parameters | developers.cloudflare.com/d1/platform/pricing and /limits |
| R2 | 10 GB-month storage, 1 million Class A and 10 million Class B operations per month, free egress (Standard storage only) | developers.cloudflare.com/r2/pricing |
| KV (Free plan) | 100,000 reads and 1,000 writes per day, 1 GB storage, values up to 25 MiB, keys up to 512 bytes, minimum TTL 60 s | developers.cloudflare.com/kv/platform/limits |

Saving a context writes one row per transcript segment (plus the FTS rows the triggers add), so a long video with 500 segments uses about 1,000 of D1's 100,000 free daily row writes.

## Testing

- `npx vitest run providers/storage-cloudflare` runs the full Storage contract on Miniflare, which is workerd's real D1, R2 and KV, over the shared fixture contexts. No account needed.
- `npx vitest run providers/cloudflare-ai` replays responses recorded from Workers AI (REST directly, and the binding rungs through an adapter that returns the same recorded `result`).
- `LIVE=1` with `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` set also runs REST Whisper and bge-m3 from Node, and starts `wrangler dev` with the test Workers in each package's `test/worker/`: one calls every binding rung against real Workers AI, the other saves contexts into local D1 and finds them again by search.

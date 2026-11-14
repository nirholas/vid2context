# Search

A 15-episode series is about 90k tokens of transcript, so an agent should search instead of reading everything. `@vid2context/search` answers "where do they talk about the timing chain?" with the right minute of the right video, even when the speaker said "cam chain", and still finds exact model names such as "M278" or "W463".

It backs `GET /api/v1/search` and the MCP tool `search_transcript`, and works with any storage backend.

## Use it

```ts
import { createSearchEngine } from '@vid2context/search';

const engine = createSearchEngine({ registry, storage, ctx });
await engine.index(context); // a VideoContext; idempotent per video
const { hits, meta } = await engine.search({ query: 'timing chain', limit: 5 });
// hits[0]: { videoId, title, startSec, endSec, text, snippet, url, chapterTitle?, sources: ['keyword', 'vector'], score, ranks }
// meta: which sides ran, the embedding model, vector status and reason, timings
```

With a `storage`, `search` first syncs with the library: contexts saved there but not yet indexed (or saved again since) are indexed, and deleted ones are dropped. So anything the pipeline saved is searchable without calling `index`.

HTTP: `GET /api/v1/search?q=timing%20chain&collectionId=&videoIds=a,b&limit=10`, plus optional `mode=hybrid|keyword|vector`, `rerank=1`, `channel=`, `origin=auto-captions,stt`, `publishedAfter=2024-01-01`, `publishedBefore=`. Mount with `app.route('/api/v1', searchRoutes(deps))` from `@vid2context/search/http`.

MCP: `search_transcript { query, collection?, urls?, limit?, rerank? }`, registered by `registerSearchTools(server, deps)` from `@vid2context/search/mcp`. `urls` that are not in the library yet are fetched and saved first. The result is text: one block per hit with title, `[m:ss-m:ss]`, timestamp link and highlighted snippet, then a status line.

## Query syntax

| You type | Meaning |
|---|---|
| `timing chain` | Ranked by keyword and vector search together |
| `"Land Cruiser killer"` | Every hit must contain this phrase (case-insensitive, plurals and -ing forms match) |
| `oil -cooler` | No hit may contain "cooler" (or "coolers") |
| `-"oil cooler"` | No hit may contain the phrase |

Filters are separate fields, not syntax: `collectionId`, `videoIds`, `channel` (name or id), `publishedAfter` and `publishedBefore` (videos without a publish date are excluded when a date filter is set), `origin` (`creator-captions`, `auto-captions`, `native-transcript`, `stt`, `video-model`).

## How indexing works

1. **Chunking.** Each transcript is cut into windows of about 30 to 60 seconds. A window ends at a sentence end or a pause of a second or more once it is 30 seconds long; auto-captions have no punctuation, so otherwise it ends at the largest gap between segments before 60 seconds. Chunks never cross a chapter start, and each repeats up to 8 seconds of whole segments from the previous one so a sentence cut at a boundary is still found. Segments are never split, so every chunk maps back to exact transcript times. The raw transcript is never changed.
2. **Keyword side.** If the storage backend has real full-text search (SQLite FTS5, Postgres tsvector, D1 FTS5: backends named `sqlite`, `d1`, `postgres` or `pg`), its `search` is used and each hit is mapped to the chunk it overlaps most. Otherwise (MemoryStorage, the browser) an in-memory BM25 index (k1 1.2, b 0.75) is built over chunks. The tokenizer lowercases, folds diacritics, keeps Unicode letters and digits, drops English stop words and caption filler ("um", "uh", "yeah"), and stems English plurals, -ing, -ed and -ly. Model codes stay whole and also add their parts, so "M113" also matches a speaker who said "the 113 motor". Force a backend with `keyword: 'bm25' | 'storage'`.
3. **Vector side.** Chunks are embedded with one embedding model (see below) and stored in the storage backend when it implements `VectorStore`, else in process-local `MemoryVectors`. With no embed rung enabled, the engine runs keyword-only and every result says `vector: 'disabled'` with the reason.

`index` replaces a video's chunks and vectors, so calling it again is safe. When the transcript and model are unchanged since the last index, the stored vectors are reused (`vector: 'reused'`) instead of embedding again.

## One model per index

Vectors from different models live in different spaces; comparing them gives meaningless scores. So:

- Every vector is stored with the model id it came from: the rung id without a pooled-key suffix, for example `embed/ovh/bge-m3`. This is the same id `pickEmbedModel` in `@vid2context/provider-embed` produces, so indexes built by either package agree.
- Queries are embedded with the same model, and only vectors of that model are searched. Pooled keys of one service and model may stand in for each other (they return identical vectors); another model never does.
- The model is `embedModel` when given (a rung id or a model name), else `VID2CONTEXT_EMBED_MODEL`, else the first enabled embed rung in free-first order: local (Ollama, LM Studio, Transformers.js), then free tiers with your key, then keyless OVH `bge-m3`.
- When the model changes (you added a free key, or changed `VID2CONTEXT_EMBED_MODEL`), the next index or search re-embeds the affected videos with the new model, deletes the old vectors, and says so: `IndexResult.reindexedFrom`, and `meta.reindexed` on the search that did it.
- A per-video manifest (model, transcript hash, chunk count) lives next to the vectors: in storage when it implements both `VectorStore` and `KvStore`, else in memory. That is how a restarted server knows its stored vectors are still valid.

Embedding requests are batched to the rung's `maxBatch` (24 when the rung does not say; keyless OVH accepts at most 25). While indexing, a rate-limited model is waited out when its reset is under 75 seconds (OVH keyless allows about 2 requests per minute). A search never waits: if the query cannot be embedded, results are keyword-only with `vector: 'failed'` and the reason. Videos that could not be embedded yet are still keyword-searchable; the result says `vector: 'partial'` and they are retried on the next search.

## How a search runs

1. Parse the query; resolve filters to a set of allowed videos.
2. Take the top 50 chunks from each side, keeping only chunks that satisfy the phrases and exclusions.
3. **Reciprocal rank fusion**: `score = sum over sides of weight / (k + rank)`, with k = 60 and weights 1 by default (`fusion: { k, keywordWeight, vectorWeight }`). RRF uses ranks, not raw scores, so unbounded BM25 scores and cosine similarities combine without calibration. A chunk both sides like rises to the top; a chunk only one side finds still gets in.
4. **Optional rerank** (`rerank: true`, off by default): one chat call through the free-first LLM chain (local, then free, then keyless) scores the top 20 candidates from 0 to 10 as JSON, and they are reordered by that score. If it fails, the fused order is kept and `meta.rerank` says why. A local cross-encoder is left out: it needs a 100 MB+ model and an ONNX runtime, which does not fit Workers and cold-starts slowly in the browser, while this package runs in all three runtimes.
5. **Post-processing**: neighbouring or overlapping chunks of one video merge into one time range (never longer than 150 seconds), text is rebuilt from the raw segments so overlap is not repeated, matched words are bolded in a snippet of at most 320 characters, and each hit gets a timestamp link from `timestampUrl` and its chapter title.

`meta` reports the parsed query, which sides ran, the keyword backend, the embedding model, vector status and coverage, rerank status and rung, fusion settings, index size and timings per stage.

## Keep the index warm

The keyword index and chunk table live in memory. The HTTP and MCP factories keep one engine per `Storage` instance, so pass the same instance across requests (the server's `storage(ctx)` should return a shared object). A new instance means a new engine, which re-reads the library on its first search; with a backend that stores vectors and the manifest, it reuses the stored vectors instead of embedding again.

# Embeddings

Semantic search over a library ("which episode talks about the timing chain?") and passage retrieval for question answering both turn text into vectors. vid2context gets them from embedding rungs, in the same free-first order as everything else, and pins one model per index so vectors from different models are never mixed.

## Rungs

With nothing configured, OVH AI Endpoints `bge-m3` works with no key. Local and free rungs run first when you configure them.

| Rung id | Tier | Enabled by | Dimensions | Max input tokens | Batch | Verified |
|---|---|---|---|---|---|---|
| `embed/ollama/<model>` | local | `OLLAMA_EMBED_MODEL` (`OLLAMA_BASE_URL`) | per model | per model | 32 | docs |
| `embed/lmstudio/<model>` | local | `LMSTUDIO_EMBED_MODEL` (`LMSTUDIO_BASE_URL`) | per model | per model | 32 | docs |
| `embed/local/<model>` | local | `LOCAL_EMBED_BASE_URL` + `LOCAL_EMBED_MODEL` | per model | per model | 32 | docs |
| `embed/transformers/<model>` | local | `TRANSFORMERS_EMBED_MODEL` (Node and browser) | 384 for `Xenova/multilingual-e5-small` | 512 | 16 | live |
| `embed/gemini/gemini-embedding-2` | free | `GEMINI_API_KEY` | 3072 | 8192 | 32 | docs |
| `embed/jina/jina-embeddings-v3` | free | `JINA_API_KEY` | 1024 | 8192 | 32 | docs |
| `embed/cloudflare/@cf/baai/bge-m3` | free | `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID` | 1024 (measured) | 8192 | 100 | live |
| `embed/mistral/mistral-embed` | free | `MISTRAL_API_KEY` | 1024 | 8192 | 32, 16k tokens | docs |
| `embed/ovh/bge-m3` | keyless | none | 1024 (measured) | 8192 (measured) | 25 (measured) | live |
| `embed/ovh/Qwen3-Embedding-8B` | keyless | none | 4096 (measured) | 8192 | 25 (measured) | live |
| `embed/openai/text-embedding-3-small` | paid | `OPENAI_API_KEY` | 1536 | 8191 | 512 | docs |

Every rung:

- returns unit-length vectors (L2-normalized), so cosine similarity and dot product give the same ranking;
- truncates texts longer than the model's window on a word boundary, keeping 20% headroom against the token estimate;
- splits large inputs into batches the service accepts and keeps the order;
- retries a batch once on a 5xx answer;
- adds the query and passage prefixes the model was trained with (e5 `query:`/`passage:`, nomic `search_query:`/`search_document:`, the Qwen3 query instruction, Gemini Embedding 2 task prefixes) and selects Jina's `retrieval.query` and `retrieval.passage` adapters;
- checks that the vectors have the size the model should produce, so a server quietly serving another model fails loudly instead of corrupting an index.

OVH keyless allows 2 requests per minute per model per IP. Indexing 500 chunks there takes 20 requests, about 10 minutes; `embedWithModel` waits out the short rate-limit resets on its own. A local or free rung is much faster.

Pick another model on a lane with `<PROVIDER>_EMBED_MODEL` (for example `OVH_EMBED_MODEL=bge-multilingual-gemma2`) and add keys with `<PROVIDER>_FALLBACK_KEYS`.

## The pinning rule

Vectors from different models live in different spaces, usually with different sizes too. Comparing a bge-m3 query against Qwen3 passages gives meaningless scores. So:

1. An index records the rung id it was built with. Every `VectorRecord` carries it in `model` (see `packages/core/src/storage-ext.ts`).
2. Every later embed for that index, new chunks and queries alike, uses exactly that model.
3. Changing models means re-indexing: embed every chunk again with the new model and replace the old vectors.

`@vid2context/provider-embed` exports three helpers that enforce this:

```ts
import { embedQuery, embedWithModel, pickEmbedModel } from '@vid2context/provider-embed';

// Once, when the index is created. VID2CONTEXT_EMBED_MODEL overrides the choice.
const model = pickEmbedModel(registry, ctx.env); // 'embed/ovh/bge-m3' with no keys

// Indexing: exactly this model, never another one.
const vectors = await embedWithModel(registry, model, chunks.map((c) => c.text), ctx);
await store.upsertVectors(chunks.map((c, i) => ({ ...c, model, vector: vectors[i] })));

// Searching: the query uses the index's model and its query prefix.
const q = await embedQuery(registry, { model }, 'which episode talks about the timing chain?', ctx);
const hits = await store.queryVectors({ vector: q, model, limit: 10 });
```

`embedWithModel` and `embedQuery` never fall back to another model. They may use other keys of the same service and model (`embed/mistral/mistral-embed` and `embed/mistral#2/mistral-embed` return identical vectors), and they wait out short rate limits. When the model still fails, they throw a `Vid2ContextError` whose hint says that switching models requires re-indexing and names the other enabled rungs.

The same model served by two hosts (bge-m3 on OVH and on Cloudflare) gives nearly identical vectors (cosine above 0.99 on our recordings), but the helpers still treat them as different rung ids, because hosts can change precision or versions without notice.

## Re-indexing with another model

Say an index was built with `embed/ovh/bge-m3` and you now have a Gemini key and want `embed/gemini/gemini-embedding-2`:

```ts
const next = 'embed/gemini/gemini-embedding-2';
for (const videoId of videoIds) {
  const chunks = await loadChunks(videoId); // the raw transcript chunks, kept as they were
  const vectors = await embedWithModel(registry, next, chunks.map((c) => c.text), ctx);
  await store.upsertVectors(chunks.map((c, i) => ({ ...c, id: `${c.id}@${next}`, model: next, vector: vectors[i] })));
  await store.deleteVectors({ videoId, model: 'embed/ovh/bge-m3' });
}
// From now on, record `next` as the index model and query with it.
```

Set `VID2CONTEXT_EMBED_MODEL=embed/gemini/gemini-embedding-2` to make new indexes use it too.

## Local embeddings in Node and the browser

`@vid2context/provider-embed-transformers` runs a model on your machine with Transformers.js. Set `TRANSFORMERS_EMBED_MODEL=Xenova/multilingual-e5-small`. The first call downloads the 118 MB quantized model into `.vid2context/models` (or `$VID2CONTEXT_HOME/models`); later calls reuse it. In the browser it uses WebGPU when available and WASM otherwise, and caches the model with the Cache API. It is not available on Cloudflare Workers.

Why this model: it is multilingual, small (384 dimensions), embeds 8 sentences in about 50 ms on one CPU core, and on a real transcript it ranked every paraphrase pair above every unrelated pair. `paraphrase-multilingual-MiniLM-L12-v2` did not, and `bge-small-en-v1.5` is English only. e5 similarity scores sit in a narrow high band (about 0.8 to 0.9), so compare scores only within one model.

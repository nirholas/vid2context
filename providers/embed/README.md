# @vid2context/provider-embed

Embedding rungs over OpenAI-compatible HTTP, free first, for Node, Workers and the browser: Ollama, LM Studio and any local server; Gemini, Jina, Cloudflare Workers AI and Mistral with your free key; OVH AI Endpoints `bge-m3` and `Qwen3-Embedding-8B` with no key; OpenAI last. With nothing configured, `embed/ovh/bge-m3` works.

Rungs, dimensions and limits: [docs/guides/embeddings.md](../../docs/guides/embeddings.md).

## One model per index

Vectors from different models cannot be compared. An index records the rung id it was built with (`VectorRecord.model`), every query uses that model, and changing models means re-indexing. These helpers make that the default:

- `pickEmbedModel(registry, env, opts?)`: the rung id a new index should use (`VID2CONTEXT_EMBED_MODEL`, or the first enabled rung in free-first order).
- `embedWithModel(registry, rungId, texts, ctx)`: embeds with exactly that model. It may use pooled keys of the same service and model and waits out short rate limits, but never switches models; on failure the error hint explains re-indexing and lists the other enabled rungs.
- `embedQuery(registry, { model }, query, ctx)`: embeds a search query with the index's model and its query prefix.

Rungs from this package (and from `provider-embed-transformers`) also have `embedQueries(texts, ctx)`, `maxBatch` and `maxInputTokens`. Their vectors are unit length.

Try it with no keys: `npx tsx providers/embed/scripts/keyless-demo.ts`.

/**
 * Builds an EmbedRung from a function that embeds one batch. Every rung in
 * this package and in provider-embed-transformers goes through here, so they
 * all apply the same rules: retrieval prefixes, truncation on a word
 * boundary, batching that keeps order, one retry on 5xx, L2 normalization,
 * and a check that the vectors have the dimensions the model should produce.
 */
import { type Ctx, type EmbedRung, estimateTokens, type Tier, Vid2ContextError } from '@vid2context/core';
import { l2normalize, type RetrievalPrefixes, retrievalPrefixes, splitBatches, truncateForEmbedding } from './text.ts';

export type EmbedMode = 'passage' | 'query';

/** An EmbedRung that also knows how to embed search queries and its own limits. */
export interface RetrievalEmbedRung extends EmbedRung {
  /** Largest number of texts sent in one request. */
  maxBatch: number;
  /** Largest input the model accepts, in tokens. Longer texts are truncated. */
  maxInputTokens: number;
  /** Embed search queries (with the model's query prefix or task). `embed` is for indexed passages. */
  embedQueries(texts: string[], ctx: Ctx): Promise<number[][]>;
}

export interface EmbedRungSpec {
  id: string;
  provider: string;
  service: string;
  model: string;
  tier: Tier;
  priority: number;
  quality: number;
  requires: string[];
  enabled: boolean;
  /** Known output size; 0 when unknown (measured on the first call). */
  dimensions: number;
  maxInputTokens: number;
  maxBatch: number;
  /** Cap on estimated tokens per request, for services that limit the total. */
  maxBatchTokens?: number;
  /** Defaults to the model's own convention (retrievalPrefixes). */
  prefixes?: RetrievalPrefixes;
  /** Embed one batch (already prefixed and truncated). */
  embedBatch(texts: string[], mode: EmbedMode, ctx: Ctx): Promise<number[][]>;
}

function isRetryable(err: unknown): boolean {
  return err instanceof Vid2ContextError && err.code === 'upstream' && (err.status ?? 0) >= 500;
}

export function makeEmbedRung(spec: EmbedRungSpec): RetrievalEmbedRung {
  const prefixes = spec.prefixes ?? retrievalPrefixes(spec.model);
  let dimensions = spec.dimensions;

  async function run(texts: string[], mode: EmbedMode, ctx: Ctx): Promise<number[][]> {
    if (texts.length === 0) return [];
    const prefix = mode === 'query' ? prefixes.query : prefixes.passage;
    const inputs = texts.map((t, i) => {
      if (typeof t !== 'string' || t.trim() === '') {
        throw new Vid2ContextError('bad-request', `Text ${i} to embed is empty.`, {
          hint: 'Drop empty chunks before embedding; embedding services reject empty input.',
        });
      }
      return prefix + truncateForEmbedding(t, spec.maxInputTokens - estimateTokens(prefix));
    });
    const out: number[][] = new Array(inputs.length);
    for (const batch of splitBatches(inputs, spec.maxBatch, spec.maxBatchTokens)) {
      let vecs: number[][];
      try {
        vecs = await spec.embedBatch(batch.items, mode, ctx);
      } catch (err) {
        if (!isRetryable(err) || ctx.signal?.aborted) throw err;
        ctx.log.warn('embedding batch failed with a server error, retrying once', { rung: spec.id });
        vecs = await spec.embedBatch(batch.items, mode, ctx);
      }
      vecs.forEach((v, j) => {
        if (dimensions === 0) dimensions = v.length;
        if (v.length !== dimensions) {
          throw new Vid2ContextError('upstream', `${spec.id} returned ${v.length}-dimensional vectors, expected ${dimensions}.`, {
            hint: 'The server is serving a different model than the one configured. Check the model id; vectors from different models cannot share an index.',
          });
        }
        out[batch.start + j] = l2normalize(v);
      });
    }
    return out;
  }

  return {
    id: spec.id,
    provider: spec.provider,
    service: spec.service,
    model: spec.model,
    tier: spec.tier,
    priority: spec.priority,
    quality: spec.quality,
    capabilities: ['normalized', ...(prefixes.query || prefixes.passage ? ['prefixes'] : [])],
    requires: spec.requires,
    isEnabled: () => spec.enabled,
    get dimensions() {
      return dimensions;
    },
    maxBatch: spec.maxBatch,
    maxInputTokens: spec.maxInputTokens,
    embed: (texts, ctx) => run(texts, 'passage', ctx),
    embedQueries: (texts, ctx) => run(texts, 'query', ctx),
  };
}

/** True when a rung has the query-aware method (rungs from this package and embed-transformers). */
export function isRetrievalRung(rung: EmbedRung): rung is RetrievalEmbedRung {
  return typeof (rung as Partial<RetrievalEmbedRung>).embedQueries === 'function';
}

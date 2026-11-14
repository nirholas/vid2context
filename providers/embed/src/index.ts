/**
 * Embedding rungs over OpenAI-compatible HTTP, free first (see lanes.ts), plus
 * the helpers that pin one model per index (see pin.ts).
 */
import { defineProvider, type EmbedProvider } from '@vid2context/core';
import { embedRungs, PROVIDER_ID } from './lanes.ts';

export { type EmbedEndpoint, postEmbeddings } from './client.ts';
export { type EmbedModelInfo, embedRungs, LANES, modelInfo } from './lanes.ts';
export { canonicalRungId, embedQuery, embedWithModel, pickEmbedModel, pinnedRungs } from './pin.ts';
export { type EmbedMode, type EmbedRungSpec, isRetrievalRung, makeEmbedRung, type RetrievalEmbedRung } from './rung.ts';
export {
  type Batch,
  cosine,
  l2normalize,
  type RetrievalPrefixes,
  retrievalPrefixes,
  splitBatches,
  TOKEN_HEADROOM,
  truncateForEmbedding,
} from './text.ts';

const provider: EmbedProvider = defineProvider({
  id: PROVIDER_ID,
  kind: 'embed',
  name: 'OpenAI-compatible embeddings',
  runtimes: ['node', 'workers', 'browser'],
  rungs: embedRungs,
});

export default provider;

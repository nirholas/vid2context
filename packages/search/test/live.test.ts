/**
 * Live checks against the real keyless services (LIVE=1 only): OVH bge-m3
 * embeddings for indexing and a query, and an LLM rerank through the real
 * llm-openai-compatible provider. Slow (rate limited to about 2 requests per
 * minute per model) and dependent on the network, hence gated.
 */
import { createContext, stderrLogger } from '@vid2context/core';
import llm from '@vid2context/provider-llm-openai-compatible';
import { describe, expect, it } from 'vitest';
import { createSearchEngine } from '../src/engine.ts';
import { embedProvider, loadContext, ovhEmbedRung, registryWith, ZOO } from './helpers.ts';

describe.skipIf(!process.env.LIVE)('live: OVH embeddings and LLM rerank', () => {
  const ctx = createContext({ runtime: 'node', env: {}, fetch: globalThis.fetch, log: stderrLogger('warn') });

  it('indexes and searches the zoo video with real bge-m3 embeddings', async () => {
    const engine = createSearchEngine({ registry: registryWith([embedProvider([ovhEmbedRung()])]), ctx });
    const res = await engine.index(loadContext(ZOO));
    expect(res.vector, res.reason).toBe('indexed');
    const out = await engine.search({ query: 'animals with long noses', mode: 'vector' });
    expect(out.meta.vector, out.meta.vectorReason).toBe('ok');
    expect(out.hits[0]?.videoId).toBe('youtube:jNQXAC9IVRw');
    expect(out.hits.some((h) => h.text.includes('trunks'))).toBe(true);
  }, 180_000);

  it('reranks with a keyless LLM rung', async () => {
    const engine = createSearchEngine({ registry: registryWith([llm].flat()), ctx });
    await engine.index(loadContext(ZOO));
    const out = await engine.search({ query: 'elephant trunks', rerank: true });
    expect(out.meta.rerank, out.meta.rerankReason).toBe('ok');
    expect(out.meta.rerankRung).toMatch(/^llm\//);
    expect(out.hits[0]?.rerankScore).toBeGreaterThanOrEqual(0);
  }, 180_000);
});

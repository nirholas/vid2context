/**
 * Search suite: retrieval quality of @vid2context/search on labeled queries.
 *
 * The collection's recorded transcripts are indexed in memory, then every
 * query in search.json runs in keyword mode (BM25) and, when an embedding
 * rung is enabled, in hybrid mode (BM25 fused with vectors). Each mode is one
 * row: precision@k, recall@k and MRR against the labeled ranges, and the
 * engine's own total time per query.
 */
import { createSearchEngine } from '@vid2context/search';
import { datasetLabel, datasetPath, loadSearchDataset } from '../dataset.ts';
import { precisionAtK, recallAtK, reciprocalRank, type TimeRange } from '../metrics/retrieval.ts';
import type { ItemResult } from '../results.ts';
import { loadCollection } from './collection.ts';
import { errorInfo, limited, type SuiteContext } from './common.ts';
import type { SuiteOutput } from './stt.ts';

export const SEARCH_K = 5;

export async function runSearchSuite(sc: SuiteContext): Promise<SuiteOutput> {
  const path = datasetPath(sc.dataset ?? 'search.json');
  const data = loadSearchDataset(path);
  const contexts = loadCollection(data.collection);
  const queries = limited(data.queries, sc.limit);
  const items: ItemResult[] = [];
  const notes: string[] = [];
  const rungs: string[] = [];

  for (const mode of ['keyword', 'hybrid'] as const) {
    const engine = createSearchEngine({ registry: sc.registry, ctx: sc.ctx, storage: null, keyword: 'bm25' });
    const indexed = [];
    for (const c of contexts) indexed.push(await engine.index(c));
    const label = `search/${mode}`;
    if (mode === 'hybrid') {
      const vectors = indexed.map((r) => r.vector);
      if (vectors.every((v) => v === 'disabled')) {
        notes.push(
          'Hybrid search was not scored: no embedding rung is enabled (the keyless OVH bge-m3 rung needs VID2CONTEXT_KEYLESS unset).',
        );
        continue;
      }
      if (vectors.some((v) => v === 'failed')) {
        notes.push(
          `Hybrid search: embedding failed for some videos (${indexed
            .map((r) => r.reason)
            .filter(Boolean)
            .join('; ')}).`,
        );
      }
      const model = indexed.find((r) => r.model)?.model;
      if (model) notes.push(`Hybrid search used the embedding model ${model}.`);
    }
    rungs.push(label);
    for (const q of queries) {
      try {
        const res = await engine.search({ query: q.query, limit: 10, mode });
        const hits: TimeRange[] = res.hits.map((h) => ({ videoId: h.videoId, startSec: h.startSec, endSec: h.endSec }));
        const judged = { hits, expected: q.expected };
        items.push({
          item: q.id,
          videoId: q.expected[0]?.videoId ?? '',
          language: 'en',
          rung: label,
          outcome: 'ok',
          detail: mode === 'hybrid' && res.meta.vector !== 'ok' ? `vector ${res.meta.vector}` : undefined,
          retrieval: {
            k: SEARCH_K,
            precisionAtK: precisionAtK(judged, SEARCH_K),
            recallAtK: recallAtK(judged, SEARCH_K),
            reciprocalRank: reciprocalRank(judged),
          },
          latencyMs: res.meta.timings.totalMs,
          attempts: res.meta.attempts,
        });
      } catch (err) {
        items.push({ item: q.id, videoId: '', language: 'en', rung: label, outcome: 'error', ...errorInfo(err) });
      }
    }
  }
  const evaluated = new Set(items.filter((i) => i.outcome === 'ok').map((i) => i.item)).size;
  return { dataset: { file: datasetLabel(path), items: queries.length, evaluated }, skippedRungs: [], notes, items, rungs };
}

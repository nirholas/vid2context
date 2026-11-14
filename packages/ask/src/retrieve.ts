/**
 * Default retrieval.
 *
 * Every transcript is cut into 30 to 90 second chunks. When all of them fit
 * the budget, they are all sent (whole transcripts, nothing lost). Otherwise
 * chunks are ranked by keyword hits from `storage.search` and, when the
 * storage holds vectors and an embedding rung is enabled, by vector
 * similarity with one embedding model pinned for the query. The two rankings
 * are fused with reciprocal rank fusion, the best chunks are taken up to the
 * budget, and neighbouring chunks of the same video are merged into one
 * time range. Whole transcripts are not merged, so each source stays a
 * short stretch of video.
 */
import {
  attemptsOf,
  type Ctx,
  type EmbedRung,
  hasVectors,
  MemoryStorage,
  runChain,
  type SearchHit,
  timestampUrl,
  type VectorHit,
  type VideoContext,
} from '@vid2context/core';
import { chunkByTime, type TimeChunk } from './chunk.ts';
import type { RetrievalScope, Retriever, Source } from './types.ts';

/** Standard RRF constant: damps the weight of the very top ranks. */
const RRF_K = 60;
/** Merged ranges stay short enough to cite precisely. */
const MAX_MERGED_SEC = 240;

const STOPWORDS = new Set(
  (
    'a an and are as at be been but by can could did do does for from had has have how i if in into is it its me my of on or ' +
    'our over she so that the their them then there these they this those to us was we were what when where which while who ' +
    'whom why will with would you your about any some say said tell talk video does did than also just more most very much'
  ).split(' '),
);

/** Content words of a question for keyword search: lowercase, no punctuation, no stopwords. */
export function keywords(question: string): string[] {
  const words = question
    .toLowerCase()
    .normalize('NFKC')
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length > 0 && !STOPWORDS.has(w) && (w.length > 2 || /\d/.test(w)));
  return [...new Set(words)];
}

/** Reciprocal rank fusion of several rankings of the same keys. */
export function fuseRankings(rankings: string[][]): string[] {
  const score = new Map<string, number>();
  for (const ranking of rankings) {
    ranking.forEach((key, rank) => {
      score.set(key, (score.get(key) ?? 0) + 1 / (RRF_K + rank + 1));
    });
  }
  return [...score.entries()].sort((a, b) => b[1] - a[1]).map(([k]) => k);
}

const keyOf = (c: Pick<TimeChunk, 'videoId' | 'index'>): string => `${c.videoId}#${c.index}`;

function chunkAt(chunks: TimeChunk[], sec: number): TimeChunk | undefined {
  return chunks.find((c) => sec >= c.startSec && sec < c.endSec) ?? chunks.find((c) => sec < c.endSec) ?? chunks.at(-1);
}

/** Rank chunks by summed hit scores: chunks with more and better matching segments first. */
function rankHits(hits: Array<SearchHit | VectorHit>, byVideo: Map<string, TimeChunk[]>): string[] {
  const score = new Map<string, number>();
  for (const h of hits) {
    const chunks = byVideo.get(h.videoId);
    if (!chunks) continue;
    const c = chunkAt(chunks, h.startSec);
    if (c) score.set(keyOf(c), (score.get(keyOf(c)) ?? 0) + h.score);
  }
  return [...score.entries()].sort((a, b) => b[1] - a[1]).map(([k]) => k);
}

async function vectorRanking(
  question: string,
  scope: RetrievalScope,
  ids: string[],
  byVideo: Map<string, TimeChunk[]>,
  ctx: Ctx,
): Promise<string[]> {
  const storage = scope.storage;
  if (!hasVectors(storage)) return [];
  const rungs = scope.registry.embedRungs(ctx.env);
  if (rungs.length === 0) return [];
  try {
    // One model per query: vectors from different models are never compared.
    const res = await runChain<EmbedRung, number[][]>('embed', rungs, (r) => r.embed([question], ctx), {}, ctx);
    const vector = res.value[0];
    if (!vector) return [];
    const hits = await storage.queryVectors({ vector, model: res.rung.model, videoIds: ids, limit: 100 });
    return rankHits(hits, byVideo);
  } catch (err) {
    ctx.log.warn('ask: vector retrieval skipped', {
      reason: err instanceof Error ? err.message : String(err),
      attempts: attemptsOf(err).length,
    });
    return [];
  }
}

/**
 * Number chunks as sources by video order and time. With `merge`, neighbouring
 * chunks of one video become one range (for retrieved chunks, so the model
 * sees continuous context); without it every chunk stays its own source, so
 * whole transcripts keep a precise citation per minute or so.
 */
export function toSources(chunks: TimeChunk[], contexts: VideoContext[], opts: { merge?: boolean } = {}): Source[] {
  const order = new Map(contexts.map((c, i) => [c.metadata.ref.id, i]));
  const sorted = [...chunks].sort((a, b) => (order.get(a.videoId) ?? 0) - (order.get(b.videoId) ?? 0) || a.index - b.index);
  const groups: TimeChunk[][] = [];
  for (const c of sorted) {
    const last = groups.at(-1);
    const prev = last?.at(-1);
    if (
      opts.merge &&
      last &&
      prev &&
      prev.videoId === c.videoId &&
      prev.index + 1 === c.index &&
      c.endSec - (last[0] as TimeChunk).startSec <= MAX_MERGED_SEC
    ) {
      last.push(c);
    } else {
      groups.push([c]);
    }
  }
  const byId = new Map(contexts.map((c) => [c.metadata.ref.id, c]));
  return groups.map((g, i) => {
    const first = g[0] as TimeChunk;
    const last = g[g.length - 1] as TimeChunk;
    const ctx = byId.get(first.videoId);
    const url = ctx ? timestampUrl(ctx.metadata.ref, first.startSec) : undefined;
    return {
      n: i + 1,
      videoId: first.videoId,
      title: ctx?.metadata.title ?? first.videoId,
      ...(url ? { url } : {}),
      startSec: first.startSec,
      endSec: last.endSec,
      text: g.map((c) => c.text).join(' '),
    };
  });
}

/**
 * Keyword hits from the library, plus hits from an in-process index for
 * contexts handed in directly that the library does not hold (they are not
 * saved as a side effect of asking).
 */
async function keywordHits(text: string, scope: RetrievalScope, ids: string[]): Promise<SearchHit[]> {
  const stored = await Promise.all(ids.map(async (id) => (await scope.storage.getContext(id)) !== null));
  const inStorage = ids.filter((_, i) => stored[i]);
  const missing = scope.contexts.filter((c) => !inStorage.includes(c.metadata.ref.id));
  const hits: SearchHit[] = [];
  if (inStorage.length > 0) {
    hits.push(...(await scope.storage.search({ text, videoIds: inStorage, limit: 500 })));
  }
  if (missing.length > 0) {
    const local = new MemoryStorage();
    for (const c of missing) await local.putContext(c);
    hits.push(...(await local.search({ text, limit: 500 })));
  }
  return hits;
}

function chunkAll(contexts: VideoContext[]): Map<string, TimeChunk[]> {
  return new Map(contexts.map((c) => [c.metadata.ref.id, chunkByTime(c)]));
}

function totalTokens(byVideo: Map<string, TimeChunk[]>): number {
  let n = 0;
  for (const chunks of byVideo.values()) for (const c of chunks) n += c.tokens;
  return n;
}

export const defaultRetriever: Retriever = {
  needsQuery(scope) {
    return totalTokens(chunkAll(scope.contexts)) > scope.budgetTokens;
  },

  async retrieve(question, scope, ctx) {
    const byVideo = chunkAll(scope.contexts);
    const all = [...byVideo.values()].flat();
    if (totalTokens(byVideo) <= scope.budgetTokens) return toSources(all, scope.contexts);

    const ids = [...byVideo.keys()];
    const terms = keywords(question);
    const hits = terms.length > 0 ? await keywordHits(terms.join(' '), scope, ids) : [];
    const rankings = [rankHits(hits, byVideo), await vectorRanking(question, scope, ids, byVideo, ctx)].filter(
      (r) => r.length > 0,
    );
    // No hit at all: keep transcript order, so the model still sees the opening of each video and can say the answer is not there.
    const ranked = rankings.length > 0 ? fuseRankings(rankings) : all.map(keyOf);
    const byKey = new Map(all.map((c) => [keyOf(c), c]));
    const picked: TimeChunk[] = [];
    let used = 0;
    for (const key of ranked) {
      const c = byKey.get(key);
      if (!c) continue;
      if (used + c.tokens > scope.budgetTokens) continue;
      picked.push(c);
      used += c.tokens;
    }
    return toSources(picked, scope.contexts, { merge: true });
  },
};

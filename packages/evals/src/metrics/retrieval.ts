/**
 * Retrieval quality for transcript search.
 *
 * A hit is relevant when it overlaps an expected time range of the same
 * video (overlap of at least `minOverlapSec`, default 0 meaning any touch).
 *
 *   precision@k  relevant hits among the top k, over k (or over the number
 *                of hits when fewer than k came back)
 *   recall@k     expected ranges covered by at least one top-k hit, over the
 *                number of expected ranges
 *   MRR          mean over queries of 1 / rank of the first relevant hit
 *                (0 when none is relevant)
 */

export interface TimeRange {
  videoId: string;
  startSec: number;
  endSec: number;
}

export interface QueryJudgement {
  /** Ranked hits, best first. */
  hits: readonly TimeRange[];
  expected: readonly TimeRange[];
}

export interface RetrievalScore {
  queries: number;
  k: number;
  precisionAtK: number;
  recallAtK: number;
  mrr: number;
}

function overlaps(a: TimeRange, b: TimeRange, minOverlapSec: number): boolean {
  if (a.videoId !== b.videoId) return false;
  const overlap = Math.min(a.endSec, b.endSec) - Math.max(a.startSec, b.startSec);
  return minOverlapSec > 0 ? overlap >= minOverlapSec : overlap >= 0;
}

export function precisionAtK(q: QueryJudgement, k: number, minOverlapSec = 0): number {
  const top = q.hits.slice(0, k);
  if (top.length === 0) return 0;
  return top.filter((h) => q.expected.some((e) => overlaps(h, e, minOverlapSec))).length / top.length;
}

export function recallAtK(q: QueryJudgement, k: number, minOverlapSec = 0): number {
  if (q.expected.length === 0) return 0;
  const top = q.hits.slice(0, k);
  return q.expected.filter((e) => top.some((h) => overlaps(h, e, minOverlapSec))).length / q.expected.length;
}

export function reciprocalRank(q: QueryJudgement, minOverlapSec = 0): number {
  const i = q.hits.findIndex((h) => q.expected.some((e) => overlaps(h, e, minOverlapSec)));
  return i < 0 ? 0 : 1 / (i + 1);
}

export function retrievalScore(queries: readonly QueryJudgement[], k = 5, minOverlapSec = 0): RetrievalScore {
  const n = queries.length;
  const avg = (f: (q: QueryJudgement) => number) => (n === 0 ? 0 : queries.reduce((s, q) => s + f(q), 0) / n);
  return {
    queries: n,
    k,
    precisionAtK: avg((q) => precisionAtK(q, k, minOverlapSec)),
    recallAtK: avg((q) => recallAtK(q, k, minOverlapSec)),
    mrr: avg((q) => reciprocalRank(q, minOverlapSec)),
  };
}

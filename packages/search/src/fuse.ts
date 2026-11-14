/**
 * Reciprocal rank fusion (Cormack, Clarke and Buettcher, 2009). Each list
 * votes for its items by rank, not by raw score, so BM25 scores (unbounded)
 * and cosine similarities (-1 to 1) combine without calibration:
 *
 *   rrf(d) = sum over lists L containing d of  weight(L) / (k + rank_L(d))
 *
 * with ranks starting at 1. k = 60 is the value from the paper; larger k
 * flattens the advantage of the very top ranks.
 */

export type SearchSide = 'keyword' | 'vector';

export interface RankedList {
  side: SearchSide;
  /** Item ids, best first. */
  ids: string[];
  /** Default 1. */
  weight?: number;
}

export interface FusedItem {
  id: string;
  score: number;
  /** Lists the item appeared in. */
  sources: SearchSide[];
  /** 1-based rank per side. */
  ranks: Partial<Record<SearchSide, number>>;
}

export function reciprocalRankFusion(lists: RankedList[], k = 60): FusedItem[] {
  const byId = new Map<string, FusedItem>();
  for (const list of lists) {
    const weight = list.weight ?? 1;
    const seen = new Set<string>();
    list.ids.forEach((id, i) => {
      if (seen.has(id)) return;
      seen.add(id);
      const rank = i + 1;
      let item = byId.get(id);
      if (!item) {
        item = { id, score: 0, sources: [], ranks: {} };
        byId.set(id, item);
      }
      item.score += weight / (k + rank);
      if (!item.sources.includes(list.side)) item.sources.push(list.side);
      item.ranks[list.side] = rank;
    });
  }
  // Ties (same score) keep the better best rank first, then id for determinism.
  const bestRank = (f: FusedItem) => Math.min(...Object.values(f.ranks).map((r) => r ?? Number.POSITIVE_INFINITY));
  return [...byId.values()].sort((a, b) => b.score - a.score || bestRank(a) - bestRank(b) || a.id.localeCompare(b.id));
}

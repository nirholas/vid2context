/**
 * Exact comparison of one candidate pair.
 *
 * 1. Every shingle of the shorter transcript is looked up in the longer one
 *    (stock phrases that repeat many times in a transcript are ignored).
 * 2. The longest chain of matches that moves forward in both transcripts is
 *    kept (longest increasing subsequence), which is what "in time order"
 *    means: a clip's words appear in the original in the same order.
 * 3. The chain is cut into runs wherever it jumps by more than `maxGap`
 *    shingles on either side. Inside a run, small gaps are bridged: one
 *    misheard word breaks five shingles in a row, yet the words around it
 *    are plainly the same passage, so they count as covered.
 * 4. Runs with fewer than `minRunMatches` matches are coincidences and dropped.
 */
import type { ShingledDoc } from './shingles.ts';
import type { TimeRange } from './types.ts';

export interface AlignOptions {
  shingleSize: number;
  maxGap: number;
  minRunMatches: number;
  maxOccurrences: number;
}

export interface Run {
  /** Shingle positions of the first and last match on each side. */
  aFrom: number;
  aTo: number;
  bFrom: number;
  bTo: number;
  matches: number;
}

export interface Alignment {
  /** Covered share of `a` (0..1). */
  overlapA: number;
  /** Covered share of `b` (0..1). */
  overlapB: number;
  matchedShingles: number;
  /** Median of (time in b) minus (time in a) over matched shingles: where `a` starts inside `b`. */
  offsetSec: number;
  /** Span of `b` covered by matched runs. */
  coveredRangeB?: TimeRange;
  runs: Run[];
}

const indexCache = new WeakMap<ShingledDoc, Map<number, number[]>>();

/** Shingle key to positions, built once per document. */
function positionIndex(doc: ShingledDoc): Map<number, number[]> {
  let idx = indexCache.get(doc);
  if (idx) return idx;
  idx = new Map();
  for (let p = 0; p < doc.keys.length; p++) {
    const key = doc.keys[p] as number;
    const list = idx.get(key);
    if (list) list.push(p);
    else idx.set(key, [p]);
  }
  indexCache.set(doc, idx);
  return idx;
}

/** Longest chain of matches strictly increasing in both a and b. Input sorted by a ascending, b descending within one a. */
function longestChain(ma: Int32Array, mb: Int32Array): number[] {
  const m = ma.length;
  const tails: number[] = []; // index into matches of the smallest tail for each chain length
  const prev = new Int32Array(m).fill(-1);
  for (let x = 0; x < m; x++) {
    const b = mb[x] as number;
    let lo = 0;
    let hi = tails.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if ((mb[tails[mid] as number] as number) < b) lo = mid + 1;
      else hi = mid;
    }
    if (lo > 0) prev[x] = tails[lo - 1] as number;
    tails[lo] = x;
  }
  const chain: number[] = [];
  let cur = tails.length > 0 ? (tails[tails.length - 1] as number) : -1;
  while (cur >= 0) {
    chain.push(cur);
    cur = prev[cur] as number;
  }
  return chain.reverse();
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((x, y) => x - y);
  const mid = s.length >> 1;
  return s.length % 2 ? (s[mid] as number) : ((s[mid - 1] as number) + (s[mid] as number)) / 2;
}

/** Words covered by runs on one side: from the first matched shingle's first word to the last matched shingle's last word. */
function coveredWords(runs: Run[], side: 'a' | 'b', k: number, words: number): number {
  let total = 0;
  let lastEnd = -1;
  for (const r of runs) {
    const from = side === 'a' ? r.aFrom : r.bFrom;
    const to = Math.min(words - 1, (side === 'a' ? r.aTo : r.bTo) + k - 1);
    const start = Math.max(from, lastEnd + 1);
    if (to >= start) total += to - start + 1;
    lastEnd = Math.max(lastEnd, to);
  }
  return total;
}

export function align(a: ShingledDoc, b: ShingledDoc, opts: AlignOptions): Alignment {
  const idx = positionIndex(b);
  const ma: number[] = [];
  const mb: number[] = [];
  for (let i = 0; i < a.keys.length; i++) {
    const list = idx.get(a.keys[i] as number);
    if (!list || list.length > opts.maxOccurrences) continue;
    for (let x = list.length - 1; x >= 0; x--) {
      ma.push(i);
      mb.push(list[x] as number);
    }
  }
  const chain = longestChain(Int32Array.from(ma), Int32Array.from(mb));

  const runs: Run[] = [];
  let run: Run | undefined;
  for (const x of chain) {
    const i = ma[x] as number;
    const j = mb[x] as number;
    if (run && i - run.aTo <= opts.maxGap && j - run.bTo <= opts.maxGap) {
      run.aTo = i;
      run.bTo = j;
      run.matches++;
    } else {
      if (run) runs.push(run);
      run = { aFrom: i, aTo: i, bFrom: j, bTo: j, matches: 1 };
    }
  }
  if (run) runs.push(run);
  const kept = runs.filter((r) => r.matches >= opts.minRunMatches);
  // Document edges are anchors too: when both transcripts start (or end) within maxGap of the first (or last) shared
  // run, the words before (after) it are the same passage misheard, like any other small gap.
  const head = kept[0];
  if (head && head.aFrom <= opts.maxGap && head.bFrom <= opts.maxGap) kept[0] = { ...head, aFrom: 0, bFrom: 0 };
  const tail = kept[kept.length - 1];
  const lastA = a.keys.length - 1;
  const lastB = b.keys.length - 1;
  if (tail && lastA - tail.aTo <= opts.maxGap && lastB - tail.bTo <= opts.maxGap) {
    kept[kept.length - 1] = { ...tail, aTo: lastA, bTo: lastB };
  }

  const diffs: number[] = [];
  let matched = 0;
  let r = 0;
  for (const x of chain) {
    const i = ma[x] as number;
    while (r < runs.length && i > (runs[r] as Run).aTo) r++;
    if ((runs[r] as Run).matches < opts.minRunMatches) continue;
    matched++;
    diffs.push((b.wordStart[mb[x] as number] as number) - (a.wordStart[i] as number));
  }

  const k = opts.shingleSize;
  const first = kept[0];
  const last = kept[kept.length - 1];
  return {
    overlapA: a.words > 0 ? coveredWords(kept, 'a', k, a.words) / a.words : 0,
    overlapB: b.words > 0 ? coveredWords(kept, 'b', k, b.words) / b.words : 0,
    matchedShingles: matched,
    offsetSec: median(diffs),
    coveredRangeB:
      first && last
        ? { startSec: b.wordStart[first.bFrom] as number, endSec: b.wordEnd[Math.min(b.words - 1, last.bTo + k - 1)] as number }
        : undefined,
    runs: kept,
  };
}

/** Words a run covers on side a. */
export function runWords(r: Run, k: number): number {
  return r.aTo - r.aFrom + k;
}

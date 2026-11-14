/**
 * Offline topic segmentation in the style of TextTiling (Hearst, 1997),
 * adapted to timed transcripts. No model, no network, runtime-neutral, and
 * deterministic: the same transcript always gives the same boundaries.
 *
 *   1. Tokenize: content words only (stopwords and words that appear almost
 *      everywhere are dropped), each tied to the segment it came from.
 *   2. Cut the term stream into pseudo-sentences of `w` terms.
 *   3. At every gap between pseudo-sentences, compare the `k` pseudo-sentences
 *      before it with the `k` after it (cosine similarity of term counts).
 *      `k` is chosen so each block covers about two minutes of speech.
 *   4. Smooth the similarity curve, then give every gap a depth score: how far
 *      the curve climbs back up on both sides. A deep valley is a topic shift.
 *   5. Pick the deepest valleys, keeping chapters at least the minimum length
 *      apart and the count near one chapter per `targetSec`, and snap each
 *      to the start of the segment where the new block begins.
 */
import type { Segment } from '@vid2context/core';
import { type Term, tokenize } from './tokenize.ts';
import { type ChapterRules, countRange, resolveRules } from './validate.ts';

export interface TilingOptions extends ChapterRules {
  /** Transcript language (BCP-47) for stopwords and stemming. Default en. */
  language?: string;
  /** Video duration. Default: the end of the last segment. */
  durationSec?: number;
  /** Preferred average chapter length in seconds. Default 300 (5 minutes). */
  targetSec?: number;
  /** Terms per pseudo-sentence. Default 20. */
  pseudoSentence?: number;
  /** Seconds of speech each comparison block should cover. Default 120. */
  blockSec?: number;
}

export interface Gap {
  /** Index of the first pseudo-sentence after the gap. */
  index: number;
  /** Start of the segment the gap snaps to. */
  startSec: number;
  /** Segment index the gap snaps to. */
  seg: number;
  similarity: number;
  smoothed: number;
  depth: number;
}

export interface TilingResult {
  /** Chapter starts in seconds, ascending, the first is 0. Each is a real segment start (or 0). */
  starts: number[];
  /** Segment index each start snapped to (the first is the first segment). */
  segs: number[];
  durationSec: number;
  /** Every gap scored, for inspection and tests. */
  gaps: Gap[];
  /** The count the selection aimed for. */
  target: number;
  terms: Term[];
}

type Counts = Map<string, number>;

function addCounts(into: Counts, terms: Term[], sign: 1 | -1): void {
  for (const t of terms) {
    const n = (into.get(t.stem) ?? 0) + sign;
    if (n === 0) into.delete(t.stem);
    else into.set(t.stem, n);
  }
}

export function cosine(a: Counts, b: Counts): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (const [k, v] of a) {
    na += v * v;
    const w = b.get(k);
    if (w) dot += v * w;
  }
  for (const v of b.values()) nb += v * v;
  return na === 0 || nb === 0 ? 0 : dot / Math.sqrt(na * nb);
}

/** Moving average over a window of 3, applied `passes` times. Endpoints average over what exists. */
export function smooth(values: number[], passes = 2): number[] {
  let cur = values;
  for (let p = 0; p < passes; p++) {
    cur = cur.map((_, i) => {
      const win = [cur[i - 1], cur[i], cur[i + 1]].filter((v): v is number => v !== undefined);
      return win.reduce((a, b) => a + b, 0) / win.length;
    });
  }
  return cur;
}

/** Hearst's depth score: climb to the nearest peak on each side and add both rises. */
export function depthScores(values: number[]): number[] {
  return values.map((v, i) => {
    let left = v;
    for (let j = i - 1; j >= 0 && (values[j] ?? 0) >= left; j--) left = values[j] ?? left;
    let right = v;
    for (let j = i + 1; j < values.length && (values[j] ?? 0) >= right; j++) right = values[j] ?? right;
    return left - v + (right - v);
  });
}

/** Drop terms that appear in more than `share` of the pseudo-sentence-sized windows: they carry no topic signal. */
function dropUbiquitous(terms: Term[], w: number, share: number): Term[] {
  const windows = Math.max(1, Math.ceil(terms.length / w));
  if (windows < 8) return terms;
  const seen = new Map<string, number>();
  for (let i = 0; i < windows; i++) {
    const uniq = new Set(terms.slice(i * w, (i + 1) * w).map((t) => t.stem));
    for (const s of uniq) seen.set(s, (seen.get(s) ?? 0) + 1);
  }
  return terms.filter((t) => (seen.get(t.stem) ?? 0) / windows <= share);
}

export function textTiling(segments: Segment[], opts: TilingOptions = {}): TilingResult {
  const rules = resolveRules(opts);
  const durationSec = opts.durationSec ?? segments.at(-1)?.endSec ?? 0;
  const w = opts.pseudoSentence ?? 20;
  const range = countRange(durationSec, rules);
  const target = Math.min(range.max, Math.max(range.min, Math.round(durationSec / (opts.targetSec ?? 300))));
  const firstSeg = 0;
  const base: TilingResult = { starts: [0], segs: [firstSeg], durationSec, gaps: [], target, terms: [] };
  if (segments.length === 0 || target <= 1) return base;

  const terms = dropUbiquitous(tokenize(segments, opts.language), w, 0.6);
  base.terms = terms;
  const pseudo: Term[][] = [];
  for (let i = 0; i < terms.length; i += w) pseudo.push(terms.slice(i, i + w));
  if (pseudo.length < 4) return base;

  const timeOf = (p: Term[] | undefined): number => segments[p?.[0]?.seg ?? 0]?.startSec ?? 0;
  const secPerPseudo = Math.max(1, (timeOf(pseudo.at(-1)) - timeOf(pseudo[0])) / Math.max(1, pseudo.length - 1));
  const k = Math.min(12, Math.max(2, Math.round((opts.blockSec ?? 120) / secPerPseudo)));

  // Sliding block comparison: keep running counts for the left and right blocks.
  const sims: number[] = [];
  const left: Counts = new Map();
  const right: Counts = new Map();
  for (let i = 0; i < Math.min(k, pseudo.length); i++) addCounts(right, pseudo[i] ?? [], 1);
  for (let g = 1; g < pseudo.length; g++) {
    // Gap g sits before pseudo-sentence g: left = [g-k, g), right = [g, g+k).
    addCounts(left, pseudo[g - 1] ?? [], 1);
    if (g - 1 - k >= 0) addCounts(left, pseudo[g - 1 - k] ?? [], -1);
    addCounts(right, pseudo[g - 1] ?? [], -1);
    if (g - 1 + k < pseudo.length) addCounts(right, pseudo[g - 1 + k] ?? [], 1);
    sims.push(cosine(left, right));
  }
  const smoothed = smooth(sims);
  const depths = depthScores(smoothed);
  const gaps: Gap[] = sims.map((similarity, i) => {
    const seg = pseudo[i + 1]?.[0]?.seg ?? 0;
    return {
      index: i + 1,
      seg,
      startSec: segments[seg]?.startSec ?? 0,
      similarity,
      smoothed: smoothed[i] ?? 0,
      depth: depths[i] ?? 0,
    };
  });
  base.gaps = gaps;

  // Candidates are local minima of the smoothed curve.
  const minima = gaps.filter((g, i) => g.smoothed <= (gaps[i - 1]?.smoothed ?? 2) && g.smoothed <= (gaps[i + 1]?.smoothed ?? 2));
  const mean = minima.reduce((a, g) => a + g.depth, 0) / Math.max(1, minima.length);
  const sd = Math.sqrt(minima.reduce((a, g) => a + (g.depth - mean) ** 2, 0) / Math.max(1, minima.length));
  const cutoff = mean - sd / 2;
  const byDepth = (a: Gap, b: Gap) => b.depth - a.depth || a.index - b.index;

  const chosen: Gap[] = [];
  const fits = (g: Gap, spacing: number): boolean =>
    g.startSec >= spacing &&
    durationSec - g.startSec >= spacing &&
    chosen.every((c) => Math.abs(c.startSec - g.startSec) >= spacing);
  const want = target - 1;
  // First pass: deep valleys only, spread out (no chapter under 40% of the target length).
  const wide = Math.max(rules.minChapterSec, (0.4 * durationSec) / target);
  for (const g of minima.filter((m) => m.depth >= cutoff).sort(byDepth)) {
    if (chosen.length >= want) break;
    if (fits(g, wide)) chosen.push(g);
  }
  // Second pass, only when below the minimum count: any valley at the minimum chapter length.
  for (const g of [...minima].sort(byDepth)) {
    if (chosen.length >= range.min - 1) break;
    if (fits(g, rules.minChapterSec)) chosen.push(g);
  }
  // Last resort for a flat curve: split the longest chapter at its least cohesive gap.
  while (chosen.length < range.min - 1) {
    const starts = [0, ...chosen.map((c) => c.startSec).sort((a, b) => a - b), durationSec];
    let lo = 0;
    let hi = 0;
    for (let i = 0; i + 1 < starts.length; i++) {
      const a = starts[i] ?? 0;
      const b = starts[i + 1] ?? 0;
      if (b - a > hi - lo) {
        lo = a;
        hi = b;
      }
    }
    const pick = gaps
      .filter(
        (g) => g.startSec - lo >= rules.minChapterSec && hi - g.startSec >= rules.minChapterSec && fits(g, rules.minChapterSec),
      )
      .sort((a, b) => a.smoothed - b.smoothed || a.index - b.index)[0];
    if (!pick) break;
    chosen.push(pick);
  }

  chosen.sort((a, b) => a.startSec - b.startSec);
  return {
    ...base,
    starts: [0, ...chosen.map((c) => c.startSec)],
    segs: [firstSeg, ...chosen.map((c) => c.seg)],
  };
}

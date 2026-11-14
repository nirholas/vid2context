/**
 * Choosing which frames to read and tidying the notes that come back
 * (runtime-neutral, pure functions).
 *
 *   dedupeFrames   collapse runs of consecutive look-alike frames (dHash within
 *                  a Hamming threshold of the run's first frame) into one, keeping
 *                  the sharpest frame but the time the picture first appeared.
 *   selectBudget   when there are more distinct frames than the budget, keep the
 *                  biggest visual changes, spread across the whole duration.
 *   mergeNotes     sort notes by time and drop a note whose text is nearly the
 *                  same as the note just before it, keeping the first occurrence.
 */
import type { VisualNote } from '@vid2context/core';
import { hammingDistance } from './hash.ts';

export interface SampledFrame {
  /** Position in the sampled sequence (matches the JPEG file order). */
  index: number;
  atSec: number;
  hash: string;
  sharpness: number;
}

export interface DistinctFrame {
  /** When this picture first appeared (start of the run). */
  atSec: number;
  /** dHash of the run's first frame. */
  hash: string;
  /** The sharpest frame of the run: the one sent to a rung. */
  best: SampledFrame;
  /** Hamming distance from the previous distinct frame (64 for the first). */
  change: number;
  /** How many sampled frames the run collapsed. */
  runLength: number;
}

/**
 * Default Hamming threshold: frames within 12 of 64 bits count as the same picture.
 * Measured on the fixture talk: the same slide with different burned-in subtitles
 * differs by 5 to 6 bits, an animated code screen drifts by up to 11, and
 * different slides differ by 23 or more.
 */
export const DEFAULT_HASH_THRESHOLD = 12;

export function dedupeFrames(frames: SampledFrame[], threshold = DEFAULT_HASH_THRESHOLD): DistinctFrame[] {
  const out: DistinctFrame[] = [];
  let anchor: SampledFrame | undefined;
  for (const f of [...frames].sort((a, b) => a.atSec - b.atSec)) {
    const current = out[out.length - 1];
    if (anchor && current && hammingDistance(anchor.hash, f.hash) <= threshold) {
      current.runLength++;
      if (f.sharpness > current.best.sharpness) current.best = f;
      continue;
    }
    const change = anchor ? hammingDistance(anchor.hash, f.hash) : 64;
    anchor = f;
    out.push({ atSec: f.atSec, hash: f.hash, best: f, change, runLength: 1 });
  }
  return out;
}

/**
 * Keep at most `maxFrames`. The duration is split into `maxFrames` equal
 * windows; each window contributes its biggest change, then the remaining
 * slots go to the biggest changes overall. Returned in time order.
 */
export function selectBudget<T extends { atSec: number; change: number }>(
  frames: T[],
  maxFrames: number,
  durationSec?: number,
): T[] {
  if (maxFrames <= 0) return [];
  if (frames.length <= maxFrames) return [...frames].sort((a, b) => a.atSec - b.atSec);
  const last = Math.max(...frames.map((f) => f.atSec));
  const span = Math.max(durationSec ?? 0, last + 1e-6);
  const better = (a: T, b: T) => b.change - a.change || a.atSec - b.atSec;
  const chosen = new Set<T>();
  const windows = new Map<number, T>();
  for (const f of frames) {
    const w = Math.min(maxFrames - 1, Math.floor((f.atSec / span) * maxFrames));
    const cur = windows.get(w);
    if (!cur || better(f, cur) < 0) windows.set(w, f);
  }
  for (const f of windows.values()) chosen.add(f);
  for (const f of [...frames].sort(better)) {
    if (chosen.size >= maxFrames) break;
    chosen.add(f);
  }
  return [...chosen].sort((a, b) => a.atSec - b.atSec);
}

/** Lowercase, Unicode-normalized letters and digits separated by single spaces. */
export function normalizeText(text: string): string {
  return text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

function bigrams(s: string): Map<string, number> {
  const m = new Map<string, number>();
  for (let i = 0; i < s.length - 1; i++) {
    const g = s.slice(i, i + 2);
    m.set(g, (m.get(g) ?? 0) + 1);
  }
  return m;
}

/** Dice coefficient over character bigrams of the normalized texts: 1 for identical, near 0 for unrelated. */
export function textSimilarity(a: string, b: string): number {
  const na = normalizeText(a);
  const nb = normalizeText(b);
  if (na === nb) return 1;
  if (na.length < 2 || nb.length < 2) return 0;
  const ga = bigrams(na);
  const gb = bigrams(nb);
  let overlap = 0;
  for (const [g, n] of ga) overlap += Math.min(n, gb.get(g) ?? 0);
  return (2 * overlap) / (na.length - 1 + (nb.length - 1));
}

/** Notes at or above this similarity to the previous note are merged into it. */
export const MERGE_SIMILARITY = 0.9;

export function mergeNotes(notes: VisualNote[], minSimilarity = MERGE_SIMILARITY): VisualNote[] {
  const out: VisualNote[] = [];
  const sorted = notes
    .map((n, i) => ({ n, i }))
    .filter(({ n }) => normalizeText(n.text).length > 0)
    .sort((a, b) => a.n.atSec - b.n.atSec || a.i - b.i);
  for (const { n } of sorted) {
    const prev = out[out.length - 1];
    if (prev && textSimilarity(prev.text, n.text) >= minSimilarity) continue;
    out.push(n);
  }
  return out;
}

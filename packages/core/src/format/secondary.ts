/**
 * Bilingual subtitles: how a translated or second-language transcript is
 * combined with the primary one. Each secondary segment goes to exactly one
 * primary segment: the one it overlaps most in time, or, when it overlaps
 * none, the nearest one. A primary segment shows the text of every secondary
 * segment it received, joined in time order. So no secondary text is lost or
 * shown twice, and a translation with the same timings as its source (what
 * the translate package produces) lines up one to one.
 */
import type { Segment } from '../types.ts';
import { cleanText } from './paragraphs.ts';

/** Index of the first element of the sorted `xs` that is >= `x`. */
function lowerBound(xs: number[], x: number): number {
  let lo = 0;
  let hi = xs.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((xs[mid] as number) < x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * The secondary text for each primary segment, in the order of `primary`
 * (an empty string where none was assigned). Text is cleaned like cue text.
 */
export function alignSecondary(primary: Segment[], secondary: Segment[]): string[] {
  const order = primary.map((_, i) => i).sort((a, b) => (primary[a] as Segment).startSec - (primary[b] as Segment).startSec);
  const starts = order.map((i) => (primary[i] as Segment).startSec);
  const maxDur = primary.reduce((m, p) => Math.max(m, p.endSec - p.startSec), 0);
  const assigned: { at: number; text: string }[][] = primary.map(() => []);
  if (!primary.length) return [];
  for (const s of secondary) {
    const text = cleanText(s.text);
    if (!text) continue;
    const sEnd = Math.max(s.startSec, s.endSec);
    // Every primary segment that can overlap s starts before s ends and after s.start - maxDur.
    const hi = lowerBound(starts, sEnd);
    const lo = lowerBound(starts, s.startSec - maxDur);
    let best = -1;
    let bestScore = Number.NEGATIVE_INFINITY;
    for (let k = Math.max(0, Math.min(lo, hi - 1)); k <= Math.min(order.length - 1, hi); k++) {
      const p = primary[order[k] as number] as Segment;
      const overlap = Math.min(sEnd, p.endSec) - Math.max(s.startSec, p.startSec);
      // A positive overlap wins; otherwise the smallest gap (a negative overlap is minus the gap).
      if (overlap > bestScore) {
        bestScore = overlap;
        best = order[k] as number;
      }
    }
    assigned[best]?.push({ at: s.startSec, text });
  }
  return assigned.map((list) =>
    list
      .sort((a, b) => a.at - b.at)
      .map((x) => x.text)
      .join(' '),
  );
}

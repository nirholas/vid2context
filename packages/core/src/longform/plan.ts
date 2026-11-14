/**
 * Cut planning shared by the built-in splitters. Audio is a sequence of
 * indivisible units (MP3 frames, or 20 ms blocks of WAV samples) with known
 * start times and byte spans. The planner picks chunk boundaries that:
 *
 *   - never exceed maxBytes (hard limit),
 *   - spread the audio evenly, each chunk close to targetSec,
 *   - start each chunk after the first `overlapSec` before the previous end,
 *   - when an energy function is given, move each cut to the quietest unit
 *     within a small window around the even cut point.
 */
import { Vid2ContextError } from '../errors.ts';

export interface PlannedCut {
  /** First unit (inclusive). */
  start: number;
  /** Last unit (exclusive). */
  end: number;
  /** Seconds this chunk repeats from the previous one. */
  overlapSec: number;
}

export interface PlanInput {
  count: number;
  /** Start time of each unit; length count + 1, the last entry is the total duration. */
  times: ArrayLike<number>;
  /** Bytes a chunk of units [s, e) takes once written out (headers included). Must grow with e. */
  bytesOf(s: number, e: number): number;
  maxBytes: number;
  targetSec: number;
  overlapSec: number;
  /** Lower is quieter. Energy of unit i; a cut at boundary i ends a chunk just before unit i. */
  energy?(i: number): number;
  /** Seconds either side of the even cut point to search for a quiet unit. */
  searchSec?: number;
  /** For error messages: 'frame', 'block'. */
  unit: string;
}

/** First index i in [lo, hi] with times[i] >= t. */
function indexAt(times: ArrayLike<number>, t: number, lo: number, hi: number): number {
  let a = lo;
  let b = hi;
  while (a < b) {
    const m = (a + b) >> 1;
    if ((times[m] as number) < t) a = m + 1;
    else b = m;
  }
  return a;
}

export function planCuts(p: PlanInput): PlannedCut[] {
  const { count, times, bytesOf, maxBytes } = p;
  const total = times[count] as number;
  const overlap = Math.max(0, p.overlapSec);

  // Largest e such that [s, e) fits in maxBytes.
  const maxEnd = (s: number): number => {
    let a = s;
    let b = count;
    while (a < b) {
      const m = (a + b + 1) >> 1;
      if (bytesOf(s, m) <= maxBytes) a = m;
      else b = m - 1;
    }
    return a;
  };

  // Even spacing: chunk length (cut-to-cut plus overlap) at most the target and what fits by average byte rate.
  const avgBps = total > 0 ? bytesOf(0, count) / total : 0;
  const secByBytes = avgBps > 0 ? (maxBytes / avgBps) * 0.97 : Number.POSITIVE_INFINITY;
  const eff = Math.min(p.targetSec, secByBytes);
  const step = Math.max(eff - overlap, eff / 2);
  const n = total > 0 && step > 0 ? Math.max(1, Math.ceil(total / step - 1e-9)) : 1;
  const per = total / n;
  const search = p.searchSec ?? Math.min(15, per * 0.1);

  const cuts: PlannedCut[] = [];
  let s = 0;
  let prevOverlap = 0;
  let k = 0;
  while (s < count) {
    const hard = maxEnd(s);
    if (hard <= s) {
      throw new Vid2ContextError('too-large', `One ${p.unit} is larger than the ${maxBytes}-byte chunk limit.`, {
        hint: 'Raise the chunk size limit or use a rung that accepts larger uploads.',
      });
    }
    const goal = Math.min(total, (k + 1) * per);
    let e = Math.min(indexAt(times, goal, s + 1, count), hard);
    if (e < count && p.energy) {
      const t0 = times[e] as number;
      const lo = Math.max(s + 1, indexAt(times, t0 - search, s + 1, count));
      const hi = Math.min(hard, indexAt(times, t0 + search, s + 1, count), count - 1);
      let best = e;
      let bestE = p.energy(e);
      for (let i = lo; i <= hi; i++) {
        const en = p.energy(i);
        if (en < bestE || (en === bestE && Math.abs(i - e) < Math.abs(best - e))) {
          best = i;
          bestE = en;
        }
      }
      e = best;
    }
    cuts.push({ start: s, end: e, overlapSec: prevOverlap });
    if (e >= count) break;
    const endT = times[e] as number;
    let next = indexAt(times, endT - overlap, 0, e);
    // Overlap never takes more than half a chunk, so splitting always progresses.
    next = Math.max(next, s + Math.ceil((e - s) / 2));
    prevOverlap = endT - (times[next] as number);
    s = next;
    k++;
  }
  return cuts;
}

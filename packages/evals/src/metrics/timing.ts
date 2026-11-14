/**
 * Timestamp alignment error: how far apart the same word starts in two
 * transcripts of one video.
 *
 * Segments carry start and end times, not per-word times, so each word gets
 * a start time interpolated by its position inside its segment (word k of n
 * in a segment from s to e starts at s + (e - s) * k / n). The two word
 * lists (normalized as for WER) are aligned, and for every matched word the
 * absolute start-time difference is collected. The median and p90 of those
 * differences are the metric. Only exact word matches count: substituted
 * words may be misheard neighbours and would blur the timing signal.
 */
import type { Segment } from '@vid2context/core';
import { align } from './align.ts';
import { type NormalizeOptions, normalizeWords } from './normalize.ts';
import { median, percentile } from './stats.ts';

export interface TimedWord {
  word: string;
  startSec: number;
}

export interface TimingError {
  /** Words matched exactly and compared. */
  matched: number;
  medianSec?: number;
  p90Sec?: number;
  maxSec?: number;
}

/** Normalized words with interpolated start times. */
export function timedWords(segments: readonly Segment[], opts: NormalizeOptions = {}): TimedWord[] {
  const out: TimedWord[] = [];
  for (const seg of segments) {
    const words = normalizeWords(seg.text, opts);
    const span = Math.max(0, seg.endSec - seg.startSec);
    words.forEach((word, k) => {
      out.push({ word, startSec: seg.startSec + (span * k) / words.length });
    });
  }
  return out;
}

/** Median and p90 absolute start-time difference over exactly matched words. */
export function timingError(reference: readonly Segment[], hypothesis: readonly Segment[], opts: NormalizeOptions = {}): TimingError {
  const r = timedWords(reference, opts);
  const h = timedWords(hypothesis, opts);
  const a = align(
    r.map((w) => w.word),
    h.map((w) => w.word),
  );
  const diffs: number[] = [];
  for (const step of a.steps) {
    if (step.op !== 'match') continue;
    const rw = r[step.ref as number] as TimedWord;
    const hw = h[step.hyp as number] as TimedWord;
    diffs.push(Math.abs(rw.startSec - hw.startSec));
  }
  if (diffs.length === 0) return { matched: 0 };
  return {
    matched: diffs.length,
    medianSec: median(diffs),
    p90Sec: percentile(diffs, 90),
    maxSec: Math.max(...diffs),
  };
}

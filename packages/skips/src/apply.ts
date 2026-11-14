/**
 * Build a transcript layer without (or with labels for) the lines that fall
 * inside SponsorBlock spans. The input transcript is never changed: the raw
 * transcript stays what was stored, and the result is a new object whose
 * producer ends in "+skips".
 */
import { segmentsToText, type Transcript, Vid2ContextError } from '@vid2context/core';
import { type SkipSegment, unionSeconds } from './sponsorblock.ts';

export interface ApplySkipsOptions {
  /** drop: remove the overlapping lines (default). mark: keep every line unchanged and report which ones overlap. */
  mode?: 'drop' | 'mark';
  /** Share of a line's duration that must fall inside skip spans for it to count. Default 0.5. */
  minOverlap?: number;
}

export interface RemovedSpan {
  segment: SkipSegment;
  /** Number of transcript lines attributed to this span. */
  lines: number;
  /** Those lines' text, joined. */
  text: string;
  /** Indexes of those lines in the input transcript's `segments`. */
  indexes: number[];
}

export interface ApplySkipsResult {
  /** The new layer: lines dropped (drop) or all lines kept (mark). Producer is "<original>+skips". */
  transcript: Transcript;
  /** One entry per skip span, in time order, including spans that matched no line. */
  removed: RemovedSpan[];
  /** Seconds of video covered by the skip spans (their union). */
  coveredSec: number;
}

function overlap(aStart: number, aEnd: number, bStart: number, bEnd: number): number {
  return Math.max(0, Math.min(aEnd, bEnd) - Math.max(aStart, bStart));
}

/** Producer id of a skips layer, never suffixed twice. */
export function skipsProducer(producer: string): string {
  return producer.endsWith('+skips') ? producer : `${producer}+skips`;
}

export function applySkips(
  transcript: Transcript,
  segments: readonly SkipSegment[],
  opts: ApplySkipsOptions = {},
): ApplySkipsResult {
  const mode = opts.mode ?? 'drop';
  if (mode !== 'drop' && mode !== 'mark') {
    throw new Vid2ContextError('bad-request', `Unknown skip mode "${String(mode)}".`, { hint: 'Use "drop" or "mark".' });
  }
  const minOverlap = opts.minOverlap ?? 0.5;
  if (!(minOverlap > 0 && minOverlap <= 1)) {
    throw new Vid2ContextError('bad-request', `minOverlap must be above 0 and at most 1, got ${minOverlap}.`, {
      hint: 'Pass a share of the line duration, for example 0.5.',
    });
  }

  // Only spans are skipped: highlights (poi), whole-video labels (full) and chapters remove nothing.
  const spans = segments
    .filter((s) => (s.actionType === 'skip' || s.actionType === 'mute') && s.endSec > s.startSec)
    .map((s) => ({ ...s }))
    .sort((a, b) => a.startSec - b.startSec || a.endSec - b.endSec);
  const hits: number[][] = spans.map(() => []);

  transcript.segments.forEach((line, index) => {
    const duration = line.endSec - line.startSec;
    let best = -1;
    let bestOverlap = 0;
    let covered = 0;
    if (duration <= 0) {
      best = spans.findIndex((s) => line.startSec >= s.startSec && line.startSec < s.endSec);
      covered = best >= 0 ? 1 : 0;
    } else {
      const inside: { startSec: number; endSec: number }[] = [];
      spans.forEach((s, i) => {
        const o = overlap(line.startSec, line.endSec, s.startSec, s.endSec);
        if (o <= 0) return;
        inside.push({ startSec: Math.max(line.startSec, s.startSec), endSec: Math.min(line.endSec, s.endSec) });
        if (o > bestOverlap) {
          bestOverlap = o;
          best = i;
        }
      });
      covered = unionSeconds(inside) / duration;
    }
    if (best >= 0 && covered >= minOverlap) hits[best]?.push(index);
  });

  const flagged = new Set(hits.flat());
  const kept = transcript.segments.filter((_, i) => mode === 'mark' || !flagged.has(i)).map((s) => ({ ...s }));
  const layer: Transcript = {
    ...transcript,
    ref: { ...transcript.ref },
    producer: skipsProducer(transcript.producer),
    segments: kept,
  };

  const removed: RemovedSpan[] = spans.map((segment, i) => {
    const indexes = hits[i] ?? [];
    return {
      segment,
      lines: indexes.length,
      text: segmentsToText(indexes.map((idx) => transcript.segments[idx]).filter((s) => s !== undefined)),
      indexes,
    };
  });

  return { transcript: layer, removed, coveredSec: Math.round(unionSeconds(spans) * 1000) / 1000 };
}

/**
 * Shared building blocks for chunking, outlines, sections and budgets:
 * where a transcript may be cut, how chapters own segments, and how a run of
 * segments is split by tokens or by time. Pure and runtime-neutral.
 */
import { Vid2ContextError } from '../errors.ts';
import { formatTimestamp, segmentsToText } from '../segments.ts';
import { estimateTokens } from '../tokens.ts';
import type { Segment, VideoContext } from '../types.ts';

/** A pause of at least this many seconds between two segments is a safe place to cut. */
export const PAUSE_SEC = 1;

/** Target length of synthetic time sections for videos without chapters. */
export const SECTION_TARGET_SEC = 300;

const SENTENCE_END = /[.!?…。！？][\s"'”’)\]」』]*$/u;

/** Inclusive segment index range. `first > last` means empty. */
export type Range = [first: number, last: number];

/** One outline section with the segments it owns (by segment start time). */
export interface Span {
  index: number;
  title: string;
  startSec: number;
  endSec: number;
  source: 'chapters' | 'time';
  first: number;
  last: number;
}

/** True when the text may end right after segment `i`: a sentence end, a pause, or the end of the run. */
export function isCut(segs: Segment[], i: number): boolean {
  const next = segs[i + 1];
  if (!next) return true;
  if (next.startSec - segs[i].endSec >= PAUSE_SEC) return true;
  return SENTENCE_END.test(segs[i].text.trim());
}

/** Estimated tokens of one segment's text. */
export function segmentTokens(segs: Segment[]): number[] {
  return segs.map((s) => estimateTokens(s.text.trim()));
}

/** Estimated tokens of segments first..last joined the way formatters join them. */
export function rangeTokens(segs: Segment[], first: number, last: number): number {
  return first > last ? 0 : estimateTokens(segmentsToText(segs.slice(first, last + 1)));
}

/** End of the media: the larger of the reported duration and the last segment end. */
export function mediaEnd(context: VideoContext): number {
  return Math.max(context.metadata.durationSec ?? 0, context.transcript.segments.at(-1)?.endSec ?? 0);
}

export function assertBudget(name: string, value: number): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Vid2ContextError('bad-request', `${name} must be a positive number, got ${value}.`, {
      hint: `Pass ${name} as a token count greater than 0, for example 4000.`,
    });
  }
}

/**
 * Split segments first..last into consecutive ranges of at most `max`
 * tokens. Each range ends at the latest sentence end or pause that fits; when
 * there is none (unpunctuated auto-captions), or it would leave the range under
 * a quarter of the budget, it ends at the last whole segment that fits. A
 * single segment larger than `max` becomes its own range. Segments are never split.
 */
export function splitByTokens(segs: Segment[], first: number, last: number, max: number, tokens: number[]): Range[] {
  const out: Range[] = [];
  let s = first;
  while (s <= last) {
    let sum = 0;
    let e = s;
    let strong = -1;
    let strongSum = 0;
    while (e <= last && (e === s || sum + tokens[e] <= max)) {
      sum += tokens[e];
      if (isCut(segs, e)) {
        strong = e;
        strongSum = sum;
      }
      e++;
    }
    let end = e - 1;
    if (e <= last && strong >= s && strong < end && strongSum >= max / 4) end = strong;
    // Per-segment estimates round up, so the joined text is almost always cheaper; check anyway.
    while (end > s && rangeTokens(segs, s, end) > max) end--;
    out.push([s, end]);
    s = end + 1;
  }
  return out;
}

/**
 * Split segments first..last into windows of about `targetSec`, cutting at
 * the sentence end or pause nearest each target (within 40 percent of it),
 * else at the nearest segment boundary. A tail shorter than 1.4 targets stays
 * in one window so the last section is never a sliver.
 */
export function splitByTime(segs: Segment[], first: number, last: number, targetSec: number): Range[] {
  const out: Range[] = [];
  let s = first;
  while (s <= last) {
    const ws = segs[s].startSec;
    if (segs[last].endSec - ws <= targetSec * 1.4) {
      out.push([s, last]);
      break;
    }
    const goal = ws + targetSec;
    let bestStrong = -1;
    let bestStrongDist = Number.POSITIVE_INFINITY;
    let bestAny = s;
    let bestAnyDist = Number.POSITIVE_INFINITY;
    for (let i = s; i < last; i++) {
      const end = segs[i].endSec;
      if (end > ws + targetSec * 1.4) break;
      const dist = Math.abs(end - goal);
      if (dist < bestAnyDist) {
        bestAny = i;
        bestAnyDist = dist;
      }
      if (end >= ws + targetSec * 0.6 && isCut(segs, i) && dist < bestStrongDist) {
        bestStrong = i;
        bestStrongDist = dist;
      }
    }
    const end = bestStrong >= 0 ? bestStrong : bestAny;
    out.push([s, end]);
    s = end + 1;
  }
  return out;
}

/** Chapters in start order with the segment range each one owns (segments go to the chapter their start falls in). */
function chapterSpans(context: VideoContext): Span[] {
  const segs = context.transcript.segments;
  const chapters = [...context.metadata.chapters].sort((a, b) => a.startSec - b.startSec);
  const end = mediaEnd(context);
  const spans: Span[] = [];
  let seg = 0;
  for (let c = 0; c < chapters.length; c++) {
    const nextStart = chapters[c + 1]?.startSec;
    const first = seg;
    while (seg < segs.length && (nextStart === undefined || segs[seg].startSec < nextStart)) seg++;
    const startSec = c === 0 ? Math.min(chapters[0].startSec, segs[0]?.startSec ?? chapters[0].startSec) : chapters[c].startSec;
    const endSec = nextStart ?? Math.max(chapters[c].endSec ?? 0, end, startSec);
    spans.push({ index: c, title: chapters[c].title, startSec, endSec, source: 'chapters', first, last: seg - 1 });
  }
  return spans;
}

/** Synthetic sections of about five minutes, cut on sentence ends or pauses, titled by time range. */
function timeSpans(context: VideoContext): Span[] {
  const segs = context.transcript.segments;
  if (segs.length === 0) return [];
  const end = mediaEnd(context);
  const long = end >= 3600;
  const ranges = splitByTime(segs, 0, segs.length - 1, SECTION_TARGET_SEC);
  return ranges.map(([first, last], index) => {
    const startSec = index === 0 ? 0 : segs[first].startSec;
    const endSec = index === ranges.length - 1 ? end : segs[last + 1].startSec;
    const title = `${formatTimestamp(startSec, long)} to ${formatTimestamp(endSec, long)}`;
    return { index, title, startSec, endSec, source: 'time' as const, first, last };
  });
}

/** The outline sections of a video: its chapters when it has any, else synthetic time sections. */
export function sectionSpans(context: VideoContext): Span[] {
  return context.metadata.chapters.length > 0 ? chapterSpans(context) : timeSpans(context);
}

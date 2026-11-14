/**
 * Time-window chunking for retrieval. A search hit should point at about one
 * minute of video: long enough to carry a topic, short enough that the
 * timestamp link lands near the answer. Chunks:
 *
 * - span about `minSec` to `maxSec` seconds (default 30 to 60),
 * - end on a sentence end (". ? !") or a pause of `pauseSec` or more when one
 *   falls inside the window; otherwise at the largest gap between segments in
 *   the window (auto-captions have no punctuation),
 * - never cross a chapter start,
 * - start with whole segments repeated from the end of the previous chunk, up
 *   to `overlapSec` seconds, so a sentence cut at a boundary is still found.
 *
 * Segments are never split, so every chunk maps back to exact transcript time.
 * (Core's chunkTranscript is token-budget based and is not exported from the
 * core index, so search keeps this small time-based chunker of its own.)
 */

import type { Segment, VideoContext } from '@vid2context/core';
import { segmentsToText } from '@vid2context/core';

export interface ChunkOptions {
  /** Shortest window before a cut is considered. Default 30. */
  minSec?: number;
  /** Longest window; a cut is forced here. Default 60. */
  maxSec?: number;
  /** Repeat up to this many seconds of whole segments from the previous chunk. Default 8. */
  overlapSec?: number;
  /** A gap of at least this many seconds counts as a pause. Default 1. */
  pauseSec?: number;
}

export interface SearchChunk {
  /** `${videoId}#${startSec}` with startSec to two decimals; stable across re-index of the same transcript. */
  id: string;
  videoId: string;
  index: number;
  startSec: number;
  endSec: number;
  text: string;
  chapterTitle?: string;
  /** Inclusive segment indexes, overlap included. */
  segmentRange: [number, number];
}

export const CHUNK_DEFAULTS = { minSec: 30, maxSec: 60, overlapSec: 8, pauseSec: 1 } as const;

const SENTENCE_END = /[.?!。！？]["')\]]*$/;

function chapterAt(context: VideoContext, sec: number): string | undefined {
  let title: string | undefined;
  for (const ch of [...context.metadata.chapters].sort((a, b) => a.startSec - b.startSec)) {
    if (ch.startSec <= sec + 0.001) title = ch.title;
    else break;
  }
  return title;
}

function chapterStarts(context: VideoContext): number[] {
  return context.metadata.chapters
    .map((c) => c.startSec)
    .filter((s) => s > 0)
    .sort((a, b) => a - b);
}

export function chunkId(videoId: string, startSec: number): string {
  return `${videoId}#${startSec.toFixed(2)}`;
}

/** Split a transcript into overlapping 30 to 60 second chunks. */
export function chunkTranscript(context: VideoContext, opts: ChunkOptions = {}): SearchChunk[] {
  const minSec = opts.minSec ?? CHUNK_DEFAULTS.minSec;
  const maxSec = Math.max(opts.maxSec ?? CHUNK_DEFAULTS.maxSec, minSec);
  const overlapSec = Math.max(0, opts.overlapSec ?? CHUNK_DEFAULTS.overlapSec);
  const pauseSec = opts.pauseSec ?? CHUNK_DEFAULTS.pauseSec;
  const segs: Segment[] = context.transcript.segments.filter((s) => s.text.trim().length > 0);
  const videoId = context.metadata.ref.id;
  if (segs.length === 0) return [];
  const starts = chapterStarts(context);
  const crossesChapter = (a: Segment, b: Segment) => starts.some((s) => a.startSec < s && b.startSec >= s - 0.001);
  const gapAfter = (i: number) => {
    const cur = segs[i];
    const next = segs[i + 1];
    return cur && next ? next.startSec - cur.endSec : Number.POSITIVE_INFINITY;
  };

  // Core ranges: consecutive, non-overlapping [first, last] segment indexes.
  const ranges: [number, number][] = [];
  let first = 0;
  while (first < segs.length) {
    const startSec = segs[first]?.startSec ?? 0;
    let last = first;
    let cut = -1;
    let bestGap = -1;
    let bestGapAt = -1;
    for (let i = first; i < segs.length; i++) {
      const seg = segs[i] as Segment;
      const next = segs[i + 1];
      last = i;
      if (next && crossesChapter(seg, next)) {
        cut = i;
        break;
      }
      if (!next) {
        cut = i;
        break;
      }
      const dur = seg.endSec - startSec;
      if (dur >= minSec) {
        const gap = gapAfter(i);
        if (SENTENCE_END.test(seg.text.trim()) || gap >= pauseSec) {
          cut = i;
          break;
        }
        if (gap > bestGap) {
          bestGap = gap;
          bestGapAt = i;
        }
      }
      if (next.endSec - startSec > maxSec) {
        cut = bestGapAt >= first ? bestGapAt : i;
        break;
      }
    }
    if (cut < 0) cut = last;
    ranges.push([first, cut]);
    first = cut + 1;
  }

  // A very short tail (under a third of minSec) joins the previous chunk when no chapter separates them.
  const tail = ranges.at(-1);
  const prev = ranges.at(-2);
  if (tail && prev) {
    const tailDur = (segs[tail[1]] as Segment).endSec - (segs[tail[0]] as Segment).startSec;
    if (tailDur < minSec / 3 && !crossesChapter(segs[prev[1]] as Segment, segs[tail[0]] as Segment)) {
      prev[1] = tail[1];
      ranges.pop();
    }
  }

  return ranges.map(([f, l], index) => {
    let start = f;
    if (index > 0 && overlapSec > 0) {
      const coreStart = (segs[f] as Segment).startSec;
      const prevFirst = (ranges[index - 1] as [number, number])[0];
      while (
        start - 1 > prevFirst &&
        coreStart - (segs[start - 1] as Segment).startSec <= overlapSec &&
        !crossesChapter(segs[start - 1] as Segment, segs[f] as Segment)
      ) {
        start--;
      }
    }
    const slice = segs.slice(start, l + 1);
    const startSec = (slice[0] as Segment).startSec;
    const chapterTitle = chapterAt(context, (segs[f] as Segment).startSec);
    // Map back to indexes in the unfiltered transcript.
    const all = context.transcript.segments;
    const segmentRange: [number, number] = [all.indexOf(slice[0] as Segment), all.indexOf(slice[slice.length - 1] as Segment)];
    return {
      id: chunkId(videoId, startSec),
      videoId,
      index,
      startSec,
      endSec: (slice[slice.length - 1] as Segment).endSec,
      text: segmentsToText(slice),
      ...(chapterTitle ? { chapterTitle } : {}),
      segmentRange,
    };
  });
}

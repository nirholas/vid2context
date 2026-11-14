/**
 * Chapter-aware transcript chunking for agents and retrieval: pieces that fit
 * a token budget, cut on sentence ends or pauses, never splitting a segment.
 */
import { Vid2ContextError } from '../errors.ts';
import { segmentsToText } from '../segments.ts';
import { estimateTokens } from '../tokens.ts';
import type { VideoContext } from '../types.ts';
import {
  assertBudget,
  type Range,
  rangeTokens,
  SECTION_TARGET_SEC,
  sectionSpans,
  segmentTokens,
  splitByTime,
  splitByTokens,
} from './spans.ts';

export interface ChunkOptions {
  /** Most tokens per chunk, overlap included. */
  maxTokens: number;
  /** Repeat whole segments from the end of the previous chunk, up to this many tokens. Default 0. */
  overlapTokens?: number;
  /** Default: `chapters` when the video has chapters, else `tokens`. */
  by?: 'chapters' | 'time' | 'tokens';
  /** Window length for `by: 'time'`, in seconds. Default 300. */
  targetSec?: number;
}

export interface TranscriptChunk {
  index: number;
  startSec: number;
  endSec: number;
  text: string;
  tokens: number;
  /** Index of the chapter (in start order) the chunk belongs to; in `time` and `tokens` mode, the chapter its first segment is in. */
  chapterIndex?: number;
  chapterTitle?: string;
  /** Inclusive indexes into `transcript.segments`, overlap included. */
  segmentRange: [number, number];
  /** How many leading segments repeat the end of the previous chunk. */
  overlapSegments: number;
}

/**
 * Split a transcript into chunks of at most `maxTokens`.
 *
 * - `chapters`: each chapter is chunked on its own; pieces never merge or overlap across chapter boundaries.
 * - `tokens`: the whole transcript, filled up to the budget.
 * - `time`: windows of about `targetSec`, each split further when over budget.
 *
 * Chunks cut on sentence ends or pauses of 1 s or more, falling back to
 * segment boundaries for unpunctuated text. Only a single segment larger than
 * the budget can produce a chunk over `maxTokens`.
 */
export function chunkTranscript(context: VideoContext, opts: ChunkOptions): TranscriptChunk[] {
  assertBudget('maxTokens', opts.maxTokens);
  const overlap = Math.max(0, Math.floor(opts.overlapTokens ?? 0));
  if (overlap >= opts.maxTokens) {
    throw new Vid2ContextError('bad-request', `overlapTokens (${overlap}) must be smaller than maxTokens (${opts.maxTokens}).`, {
      hint: 'Use an overlap of a small fraction of the budget, for example 10 percent of maxTokens.',
    });
  }
  const segs = context.transcript.segments;
  if (segs.length === 0) return [];
  const tokens = segmentTokens(segs);
  const spans = sectionSpans(context);
  const hasChapters = context.metadata.chapters.length > 0;
  const by = opts.by ?? (hasChapters ? 'chapters' : 'tokens');
  // Leave room for the overlap so every chunk, overlap included, stays within budget.
  const core = opts.maxTokens - overlap;

  /** Groups of core ranges; overlap never crosses from one group into the next. */
  const groups: Range[][] = [];
  if (by === 'chapters' && hasChapters) {
    for (const span of spans) if (span.first <= span.last) groups.push(splitByTokens(segs, span.first, span.last, core, tokens));
  } else if (by === 'time') {
    const target = opts.targetSec ?? SECTION_TARGET_SEC;
    assertBudget('targetSec', target);
    const ranges = splitByTime(segs, 0, segs.length - 1, target).flatMap(([f, l]) => splitByTokens(segs, f, l, core, tokens));
    groups.push(ranges);
  } else {
    groups.push(splitByTokens(segs, 0, segs.length - 1, core, tokens));
  }

  const chapterOf = (seg: number) => (hasChapters ? spans.find((s) => seg >= s.first && seg <= s.last) : undefined);

  const out: TranscriptChunk[] = [];
  for (const ranges of groups) {
    ranges.forEach(([first, last], k) => {
      let start = first;
      if (overlap > 0 && k > 0) {
        const prevFirst = ranges[k - 1][0];
        let sum = 0;
        while (start - 1 >= prevFirst && sum + tokens[start - 1] <= overlap) {
          sum += tokens[start - 1];
          start--;
        }
        while (start < first && rangeTokens(segs, start, last) > opts.maxTokens) start++;
      }
      const slice = segs.slice(start, last + 1);
      const text = segmentsToText(slice);
      const chapter = chapterOf(first);
      out.push({
        index: out.length,
        startSec: slice[0].startSec,
        endSec: slice[slice.length - 1].endSec,
        text,
        tokens: estimateTokens(text),
        ...(chapter ? { chapterIndex: chapter.index, chapterTitle: chapter.title } : {}),
        segmentRange: [start, last],
        overlapSegments: first - start,
      });
    });
  }
  return out;
}

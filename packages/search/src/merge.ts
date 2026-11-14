/**
 * Post-processing of ranked chunks into hits a person or agent can use:
 * neighbouring chunks of one video that both rank well become one time
 * range (chunks overlap by design, so this also removes duplicate text), and
 * each hit gets a snippet with the matched words highlighted.
 */
import { segmentsToText } from '@vid2context/core';
import type { Segment } from '@vid2context/core';
import type { SearchSide } from './fuse.ts';
import { indexTerms, stem, words } from './tokenize.ts';

export interface RankedChunk {
  id: string;
  videoId: string;
  startSec: number;
  endSec: number;
  segmentRange: [number, number];
  chapterTitle?: string;
  score: number;
  sources: SearchSide[];
}

export interface MergedRange {
  videoId: string;
  startSec: number;
  endSec: number;
  segmentRange: [number, number];
  chapterTitle?: string;
  score: number;
  sources: SearchSide[];
  /** Chunk ids merged into this range, best first. */
  chunkIds: string[];
  /** Position of the best member in the ranked input (0-based). */
  rank: number;
}

export interface MergeOptions {
  /** Chunks this close (seconds) or overlapping merge. Default 1. */
  adjacentSec?: number;
  /** A merged range never grows past this many seconds. Default 150. */
  maxRangeSec?: number;
}

function union(a: SearchSide[], b: SearchSide[]): SearchSide[] {
  const out = [...a];
  for (const s of b) if (!out.includes(s)) out.push(s);
  return out.sort();
}

function touches(a: { startSec: number; endSec: number }, b: { startSec: number; endSec: number }, gap: number): boolean {
  return a.startSec <= b.endSec + gap && b.startSec <= a.endSec + gap;
}

/**
 * Merge adjacent or overlapping chunks of the same video. Input must be best
 * first; the output keeps that order by each range's best member, with the
 * range's score being its best member's score.
 */
export function mergeAdjacent(ranked: RankedChunk[], opts: MergeOptions = {}): MergedRange[] {
  const gap = opts.adjacentSec ?? 1;
  const maxRange = opts.maxRangeSec ?? 150;
  const out: MergedRange[] = [];
  ranked.forEach((c, rank) => {
    const target = out.find(
      (r) =>
        r.videoId === c.videoId &&
        touches(r, c, gap) &&
        Math.max(r.endSec, c.endSec) - Math.min(r.startSec, c.startSec) <= maxRange,
    );
    if (!target) {
      out.push({
        videoId: c.videoId,
        startSec: c.startSec,
        endSec: c.endSec,
        segmentRange: [...c.segmentRange],
        ...(c.chapterTitle ? { chapterTitle: c.chapterTitle } : {}),
        score: c.score,
        sources: [...c.sources].sort(),
        chunkIds: [c.id],
        rank,
      });
      return;
    }
    if (c.startSec < target.startSec && c.chapterTitle) target.chapterTitle = c.chapterTitle;
    target.startSec = Math.min(target.startSec, c.startSec);
    target.endSec = Math.max(target.endSec, c.endSec);
    target.segmentRange = [Math.min(target.segmentRange[0], c.segmentRange[0]), Math.max(target.segmentRange[1], c.segmentRange[1])];
    target.sources = union(target.sources, c.sources);
    target.chunkIds.push(c.id);
  });
  // Growing one range can make it touch another of the same video: coalesce until stable.
  let changed = true;
  while (changed) {
    changed = false;
    for (let i = 0; i < out.length && !changed; i++) {
      for (let j = i + 1; j < out.length; j++) {
        const a = out[i] as MergedRange;
        const b = out[j] as MergedRange;
        if (a.videoId !== b.videoId || !touches(a, b, gap)) continue;
        if (Math.max(a.endSec, b.endSec) - Math.min(a.startSec, b.startSec) > maxRange) continue;
        if (b.startSec < a.startSec && b.chapterTitle) a.chapterTitle = b.chapterTitle;
        a.startSec = Math.min(a.startSec, b.startSec);
        a.endSec = Math.max(a.endSec, b.endSec);
        a.segmentRange = [Math.min(a.segmentRange[0], b.segmentRange[0]), Math.max(a.segmentRange[1], b.segmentRange[1])];
        a.sources = union(a.sources, b.sources);
        a.chunkIds.push(...b.chunkIds);
        out.splice(j, 1);
        changed = true;
        break;
      }
    }
  }
  return out;
}

/** Transcript text for a merged range, from the raw segments (overlap is never repeated). */
export function rangeText(segments: Segment[], range: [number, number]): string {
  return segmentsToText(segments.slice(range[0], range[1] + 1));
}

export interface HighlightOptions {
  /** Longest snippet in characters before trimming to the densest window. Default 320. */
  maxChars?: number;
  /** Marker around matched words. Default "**" (Markdown bold). */
  mark?: string;
}

/**
 * A snippet of `text` with every word whose stem is a query term wrapped in
 * `mark`. Long texts are cut to the window with the most matches, on word
 * boundaries, with "..." where text was cut.
 */
export function highlight(text: string, queryTerms: string[], opts: HighlightOptions = {}): string {
  const maxChars = opts.maxChars ?? 320;
  const mark = opts.mark ?? '**';
  const want = new Set(queryTerms);
  const tokens: { start: number; end: number; hit: boolean }[] = [];
  for (const m of text.matchAll(/[\p{L}\p{N}]+/gu)) {
    const word = m[0];
    const start = m.index ?? 0;
    const [norm] = words(word);
    const forms = norm ? [stem(norm), ...indexTerms(word)] : [];
    tokens.push({ start, end: start + word.length, hit: forms.some((f) => want.has(f)) });
  }

  let from = 0;
  let to = text.length;
  if (text.length > maxChars) {
    // Slide a window over the tokens; keep the one with most hits (earliest on ties).
    let best = { hits: -1, from: 0, to: maxChars };
    let j = 0;
    let hits = 0;
    for (let i = 0; i < tokens.length; i++) {
      const ti = tokens[i] as (typeof tokens)[number];
      while (j < tokens.length && (tokens[j] as (typeof tokens)[number]).end - ti.start <= maxChars) {
        if ((tokens[j] as (typeof tokens)[number]).hit) hits++;
        j++;
      }
      if (hits > best.hits) best = { hits, from: ti.start, to: (tokens[j - 1] ?? ti).end };
      if (ti.hit) hits--;
    }
    // Start a few words before the first hit for context when there is room.
    from = best.from;
    to = best.to;
    const firstHit = tokens.findIndex((t) => t.start >= from && t.hit);
    if (firstHit > 0 && from === (tokens[firstHit] as (typeof tokens)[number]).start) {
      const back = tokens[Math.max(0, firstHit - 4)] as (typeof tokens)[number];
      if (to - back.start <= maxChars) from = back.start;
    }
  }

  let out = '';
  let pos = from;
  for (const t of tokens) {
    if (t.start < from || t.end > to) continue;
    if (!t.hit) continue;
    out += text.slice(pos, t.start) + mark + text.slice(t.start, t.end) + mark;
    pos = t.end;
  }
  out += text.slice(pos, to);
  return `${from > 0 ? '...' : ''}${out.trim()}${to < text.length ? '...' : ''}`;
}

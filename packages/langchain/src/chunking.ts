/**
 * Split a VideoContext into document-sized chunks with timestamp metadata.
 * Same modes and metadata as the Python client (clients/python/src/vid2context/chunking.py).
 *
 * - chapters: one chunk per chapter; a video without chapters falls back to windows,
 *   and its chunks carry `chunking: 'window'`, `chunking_requested: 'chapters'`.
 * - segments: one chunk per transcript segment (caption line).
 * - window: about `windowSec` seconds each. A window starts at its first segment and
 *   takes each segment that starts before start + windowSec, so none is empty and
 *   segments are never split.
 *
 * Chunk text is the raw transcript text (whitespace collapsed), never a summary.
 */
import { type Segment, segmentsToText, timestampUrl, type VideoContext, Vid2ContextError } from '@vid2context/core';

export type Chunking = 'chapters' | 'segments' | 'window';
export const CHUNKING_MODES: readonly Chunking[] = ['chapters', 'segments', 'window'];

export type ChunkMetadata = Record<string, string | number>;

export interface Chunk {
  text: string;
  metadata: ChunkMetadata;
}

function baseMetadata(ctx: VideoContext): Record<string, string | number | undefined> {
  const { metadata: m, transcript: t } = ctx;
  return {
    source: m.ref.url ?? m.ref.input,
    title: m.title,
    channel: m.channel?.name,
    video_id: m.ref.id,
    platform: m.ref.platform,
    transcript_origin: t.origin,
    language: t.language,
    published_at: m.publishedAt,
  };
}

function makeChunk(
  ctx: VideoContext,
  segs: Segment[],
  startSec: number,
  endSec: number,
  extra: Record<string, string | number>,
): Chunk {
  const base = baseMetadata(ctx);
  const all = { ...base, start_sec: startSec, end_sec: endSec, url: timestampUrl(ctx.metadata.ref, startSec) ?? base.source, ...extra };
  // Vector stores (Chroma, Pinecone and others) reject null and undefined values, so unknown fields are left out.
  const metadata: ChunkMetadata = {};
  for (const [k, v] of Object.entries(all)) if (v !== undefined) metadata[k] = v;
  return { text: segmentsToText(segs), metadata };
}

function assertWindow(windowSec: number): void {
  if (!(windowSec > 0)) {
    throw new Vid2ContextError('bad-request', `windowSec must be positive, got ${windowSec}.`, { hint: 'Use a value such as 60.' });
  }
}

export function byWindow(ctx: VideoContext, windowSec: number, fellBack = false): Chunk[] {
  assertWindow(windowSec);
  const extra: Record<string, string> = fellBack ? { chunking: 'window', chunking_requested: 'chapters' } : { chunking: 'window' };
  const out: Chunk[] = [];
  let current: Segment[] = [];
  const flush = () => {
    const first = current[0];
    const last = current[current.length - 1];
    if (first && last) out.push(makeChunk(ctx, current, first.startSec, last.endSec, { ...extra, window_index: out.length }));
    current = [];
  };
  for (const s of ctx.transcript.segments) {
    if (!s.text.trim()) continue;
    const first = current[0];
    if (first && s.startSec >= first.startSec + windowSec) flush();
    current.push(s);
  }
  flush();
  return out;
}

export function bySegments(ctx: VideoContext): Chunk[] {
  const out: Chunk[] = [];
  ctx.transcript.segments.forEach((s, i) => {
    if (s.text.trim()) out.push(makeChunk(ctx, [s], s.startSec, s.endSec, { chunking: 'segments', segment_index: i }));
  });
  return out;
}

export function byChapters(ctx: VideoContext, windowSec = 60): Chunk[] {
  const chapters = [...ctx.metadata.chapters].sort((a, b) => a.startSec - b.startSec);
  if (chapters.length === 0) return byWindow(ctx, windowSec, true);
  const segs = ctx.transcript.segments;
  const lastEnd = Math.max(ctx.metadata.durationSec ?? 0, ...segs.map((s) => s.endSec));
  const out: Chunk[] = [];
  chapters.forEach((ch, i) => {
    const next = chapters[i + 1];
    const start = ch.startSec;
    const end = Math.max(ch.endSec ?? next?.startSec ?? lastEnd, start);
    // Each segment belongs to the chapter its start falls in, so nothing repeats. Text before
    // the first chapter mark goes to the first chapter, text after the last mark to the last.
    const mine = segs.filter((s) => (i === 0 || s.startSec >= start) && (!next || s.startSec < next.startSec));
    if (!segmentsToText(mine)) return;
    out.push(makeChunk(ctx, mine, start, end, { chunking: 'chapters', chapter: ch.title, chapter_index: i }));
  });
  return out;
}

/** Split one VideoContext. See the file comment for the modes. */
export function chunkContext(ctx: VideoContext, chunking: Chunking = 'chapters', windowSec = 60): Chunk[] {
  assertWindow(windowSec);
  if (chunking === 'chapters') return byChapters(ctx, windowSec);
  if (chunking === 'segments') return bySegments(ctx);
  if (chunking === 'window') return byWindow(ctx, windowSec);
  throw new Vid2ContextError('bad-request', `Unknown chunking "${String(chunking)}".`, {
    hint: `Use one of: ${CHUNKING_MODES.join(', ')}.`,
  });
}

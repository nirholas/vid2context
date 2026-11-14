/**
 * Split transcripts into chunks for map-reduce digests.
 *
 * Chapters are natural boundaries: each chapter is a unit, consecutive units
 * are packed into one chunk while they fit the token budget, and a chapter
 * larger than the budget is cut into even time windows. Without chapters the
 * whole transcript is one unit, so it is cut into even time windows sized to
 * the budget. Token counts come from `estimateTokens` in core (about four
 * characters per token), a budgeting heuristic with headroom, not a tokenizer.
 *
 * Chunk text keeps a `[m:ss]` marker at the start of every line so the model
 * can cite moments and the validator can check them against real segments.
 */
import { estimateTokens, formatTimestamp, type Segment, type VideoContext } from '@vid2context/core';

export const DEFAULT_MAX_TOKENS_PER_CHUNK = 6000;
/** Smallest budget accepted; below this the per-line overhead dominates. */
export const MIN_TOKENS_PER_CHUNK = 500;

/** A transcript line groups consecutive segments up to this many seconds. */
const LINE_MAX_SEC = 15;
/** ...or up to this many characters, whichever comes first. */
const LINE_MAX_CHARS = 280;

export interface TranscriptChunk {
  /** VideoRef id of the source, e.g. youtube:cCPsdFdlshc. */
  videoId: string;
  /** 0-based position of the video in the digest. */
  videoIndex: number;
  /** 0-based position of the chunk within its video. */
  index: number;
  /** Number of chunks this video was cut into. */
  of: number;
  fromSec: number;
  toSec: number;
  /** Titles of the chapters this chunk covers (empty when the video has none). */
  chapters: string[];
  /** Transcript lines, each starting with a [m:ss] marker, with chapter headings. */
  text: string;
  estimatedTokens: number;
}

interface Line {
  startSec: number;
  endSec: number;
  text: string;
}

interface Piece {
  chapter?: string;
  continued: boolean;
  lines: Line[];
  tokens: number;
}

/** The video's length: metadata duration, else the end of the last segment. */
export function videoDuration(context: VideoContext): number {
  return context.metadata.durationSec ?? context.transcript.segments.at(-1)?.endSec ?? 0;
}

/** True when timestamps for this video need the h:mm:ss form. */
export function needsHours(context: VideoContext): boolean {
  return videoDuration(context) >= 3600;
}

function toLines(segments: Segment[], long: boolean): Line[] {
  const lines: Line[] = [];
  let cur: { startSec: number; endSec: number; parts: string[]; chars: number } | undefined;
  const flush = () => {
    if (!cur) return;
    lines.push({
      startSec: cur.startSec,
      endSec: cur.endSec,
      text: `[${formatTimestamp(cur.startSec, long)}] ${cur.parts.join(' ').replace(/\s+/g, ' ').trim()}`,
    });
    cur = undefined;
  };
  for (const s of segments) {
    const t = s.text.trim();
    if (!t) continue;
    if (cur && (s.startSec - cur.startSec >= LINE_MAX_SEC || cur.chars + t.length > LINE_MAX_CHARS)) flush();
    if (!cur) cur = { startSec: s.startSec, endSec: s.endSec, parts: [], chars: 0 };
    cur.parts.push(t);
    cur.chars += t.length + 1;
    cur.endSec = Math.max(cur.endSec, s.endSec);
  }
  flush();
  return lines;
}

function heading(chapter: string, startSec: number, long: boolean, continued: boolean): string {
  return `## Chapter: ${chapter} (${formatTimestamp(startSec, long)})${continued ? ' (continued)' : ''}`;
}

function pieceTokens(p: Omit<Piece, 'tokens'>, long: boolean): number {
  const head = p.chapter ? estimateTokens(heading(p.chapter, p.lines[0]?.startSec ?? 0, long, p.continued)) + 1 : 0;
  return head + p.lines.reduce((n, l) => n + estimateTokens(l.text) + 1, 0);
}

/** Cut lines into `n` windows of roughly equal token size, never splitting a line. */
function evenWindows(lines: Line[], budget: number): Line[][] {
  const total = lines.reduce((n, l) => n + estimateTokens(l.text) + 1, 0);
  const n = Math.max(1, Math.ceil(total / budget));
  const target = total / n;
  const out: Line[][] = [];
  let cur: Line[] = [];
  let tokens = 0;
  for (const l of lines) {
    const t = estimateTokens(l.text) + 1;
    if (cur.length > 0 && (tokens + t > budget || (tokens >= target && out.length < n - 1))) {
      out.push(cur);
      cur = [];
      tokens = 0;
    }
    cur.push(l);
    tokens += t;
  }
  if (cur.length > 0) out.push(cur);
  return out;
}

/** Chapter units: segments belong to the chapter in which they start; anything before the first chapter joins it. */
function units(context: VideoContext): { chapter?: string; segments: Segment[] }[] {
  const segs = context.transcript.segments;
  const chapters = [...context.metadata.chapters].sort((a, b) => a.startSec - b.startSec);
  if (chapters.length === 0) return [{ segments: segs }];
  const out = chapters.map((c) => ({ chapter: c.title, segments: [] as Segment[] }));
  for (const s of segs) {
    let i = 0;
    for (let k = 0; k < chapters.length; k++) {
      if ((chapters[k]?.startSec ?? 0) <= s.startSec) i = k;
    }
    out[i]?.segments.push(s);
  }
  return out.filter((u) => u.segments.length > 0);
}

/** Split one video's transcript into chunks of at most `maxTokens` estimated tokens each. */
export function chunkTranscript(
  context: VideoContext,
  videoIndex: number,
  opts: { maxTokens?: number } = {},
): TranscriptChunk[] {
  const budget = Math.max(MIN_TOKENS_PER_CHUNK, Math.floor(opts.maxTokens ?? DEFAULT_MAX_TOKENS_PER_CHUNK));
  const long = needsHours(context);

  const pieces: Piece[] = [];
  for (const u of units(context)) {
    const lines = toLines(u.segments, long);
    if (lines.length === 0) continue;
    const whole = { chapter: u.chapter, continued: false, lines };
    const tokens = pieceTokens(whole, long);
    if (tokens <= budget) {
      pieces.push({ ...whole, tokens });
      continue;
    }
    // Leave room for the repeated chapter heading in every window.
    const room = u.chapter ? budget - estimateTokens(heading(u.chapter, 0, long, true)) - 1 : budget;
    evenWindows(lines, Math.max(1, room)).forEach((w, i) => {
      const p = { chapter: u.chapter, continued: i > 0, lines: w };
      pieces.push({ ...p, tokens: pieceTokens(p, long) });
    });
  }

  const groups: Piece[][] = [];
  let cur: Piece[] = [];
  let tokens = 0;
  for (const p of pieces) {
    if (cur.length > 0 && tokens + p.tokens > budget) {
      groups.push(cur);
      cur = [];
      tokens = 0;
    }
    cur.push(p);
    tokens += p.tokens;
  }
  if (cur.length > 0) groups.push(cur);

  return groups.map((g, index) => {
    const text = g
      .map((p) => {
        const body = p.lines.map((l) => l.text).join('\n');
        return p.chapter ? `${heading(p.chapter, p.lines[0]?.startSec ?? 0, long, p.continued)}\n${body}` : body;
      })
      .join('\n\n');
    const first = g[0]?.lines[0];
    const last = g.at(-1)?.lines.at(-1);
    return {
      videoId: context.metadata.ref.id,
      videoIndex,
      index,
      of: groups.length,
      fromSec: first?.startSec ?? 0,
      toSec: last?.endSec ?? 0,
      chapters: [...new Set(g.map((p) => p.chapter).filter((c): c is string => Boolean(c)))],
      text,
      estimatedTokens: estimateTokens(text),
    };
  });
}

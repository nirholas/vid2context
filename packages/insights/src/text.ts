/**
 * Text helpers shared by prompts and verification: normalization for fuzzy
 * matching, timestamp parsing, and compact timestamped transcript lines.
 */
import type { Segment } from '@vid2context/core';

/**
 * Lowercase, strip diacritics, drop apostrophes inside words ("you're" ->
 * "youre"), turn every other non-letter, non-digit character into a space and
 * collapse whitespace. Auto-captions have no punctuation or case, so model
 * quotes must be compared in this form.
 */
export function normalize(s: string): string {
  return s
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/(\p{L})['’](\p{L})/gu, '$1$2')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

export function tokens(s: string): string[] {
  const n = normalize(s);
  return n ? n.split(' ') : [];
}

/** Seconds from a number, "83", "83s", "1:23" or "1:02:03". NaN when it is none of those. */
export function parseSeconds(v: unknown): number {
  if (typeof v === 'number') return Number.isFinite(v) && v >= 0 ? v : Number.NaN;
  if (typeof v !== 'string') return Number.NaN;
  const s = v.trim().replace(/s$/i, '');
  if (/^\d+(\.\d+)?$/.test(s)) return Number(s);
  const m = /^(?:(\d+):)?(\d{1,2}):(\d{2})(?:\.\d+)?$/.exec(s);
  if (!m) return Number.NaN;
  return Number(m[1] ?? 0) * 3600 + Number(m[2]) * 60 + Number(m[3]);
}

export interface Line {
  startSec: number;
  endSec: number;
  text: string;
}

/** Merge segments into lines of about `lineSec` seconds: compact, and each line start is a real segment start. */
export function compactLines(segments: Segment[], lineSec = 10): Line[] {
  const out: Line[] = [];
  let cur: { start: number; end: number; parts: string[] } | null = null;
  for (const s of segments) {
    const text = s.text.replace(/\s+/g, ' ').trim();
    if (!text) continue;
    if (!cur || s.startSec - cur.start >= lineSec) {
      if (cur) out.push({ startSec: cur.start, endSec: cur.end, text: cur.parts.join(' ') });
      cur = { start: s.startSec, end: s.endSec, parts: [] };
    }
    cur.parts.push(text);
    cur.end = s.endSec;
  }
  if (cur) out.push({ startSec: cur.start, endSec: cur.end, text: cur.parts.join(' ') });
  return out;
}

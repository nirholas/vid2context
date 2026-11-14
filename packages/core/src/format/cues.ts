/**
 * Caption cues for SRT and WebVTT. Each segment becomes one or more cues of
 * at most 2 lines of at most 42 characters, broken on word boundaries, with
 * the segment's time shared out in proportion to text length. Timings are
 * then made safe for players: in order, never overlapping, never zero-length,
 * and at least 0.5 s long whenever the gap to the next cue allows it.
 */
import type { Segment } from '../types.ts';
import { cleanText } from './paragraphs.ts';

export const MAX_LINE = 42;
export const MAX_LINES = 2;
const MIN_MS = 500;

export interface Cue {
  startMs: number;
  endMs: number;
  lines: string[];
  speaker?: string;
}

/** Greedy word wrap to lines of at most `max` characters. A single longer word is split. */
export function wrapWords(text: string, max = MAX_LINE): string[] {
  const lines: string[] = [];
  let line = '';
  for (let word of text.split(' ').filter(Boolean)) {
    while (word.length > max) {
      if (line) {
        lines.push(line);
        line = '';
      }
      lines.push(word.slice(0, max));
      word = word.slice(max);
    }
    if (!line) line = word;
    else if (line.length + 1 + word.length <= max) line += ` ${word}`;
    else {
      lines.push(line);
      line = word;
    }
  }
  if (line) lines.push(line);
  return lines;
}

/** Split words into `k` contiguous parts of about equal character length. */
function splitBalanced(words: string[], k: number): string[][] {
  const total = words.reduce((n, w) => n + w.length + 1, 0);
  const parts: string[][] = Array.from({ length: k }, () => []);
  let pos = 0;
  for (const w of words) {
    const mid = pos + (w.length + 1) / 2;
    pos += w.length + 1;
    parts[Math.min(k - 1, Math.floor((mid * k) / total))]?.push(w);
  }
  return parts.filter((p) => p.length);
}

/** Lay out one cue's words on at most 2 lines, as even as possible; null when they do not fit. */
function layout(words: string[]): string[] | null {
  const one = words.join(' ');
  if (one.length <= MAX_LINE) return [one];
  let best: string[] | null = null;
  for (let i = 1; i < words.length; i++) {
    const a = words.slice(0, i).join(' ');
    const b = words.slice(i).join(' ');
    if (a.length > MAX_LINE || b.length > MAX_LINE) continue;
    if (!best || Math.max(a.length, b.length) < Math.max(best[0]?.length ?? 0, best[1]?.length ?? 0)) best = [a, b];
  }
  return best;
}

/**
 * `text` as cue line groups of about equal length, so the time shared out to
 * each cue is about equal too. With `prefix` (an SRT speaker label), the
 * label counts toward the first line's length.
 */
function chunk(text: string, prefix = ''): string[][] {
  // Words longer than a line are cut into line-sized pieces first.
  const words = wrapWords(prefix + text)
    .join(' ')
    .split(' ')
    .filter(Boolean)
    .flatMap((w) => (w.length > MAX_LINE ? wrapWords(w) : [w]));
  for (let k = Math.ceil(wrapWords(words.join(' ')).length / MAX_LINES); k <= words.length; k++) {
    const groups = splitBalanced(words, k).map(layout);
    if (groups.every((g) => g !== null)) return groups as string[][];
  }
  return words.map((w) => [w]);
}

/**
 * Build cues from segments. `speakerPrefix` writes `Name: ` before the text
 * of the first cue of each speaker turn (SRT has no voice markup; VTT uses
 * `<v Name>` instead and passes false).
 */
export function buildCues(segments: Segment[], speakerPrefix: boolean): Cue[] {
  const raw: Cue[] = [];
  const sorted = [...segments].sort((a, b) => a.startSec - b.startSec);
  let lastSpeaker: string | undefined;
  for (const seg of sorted) {
    const text = cleanText(seg.text);
    if (!text) continue;
    const prefix = speakerPrefix && seg.speaker && seg.speaker !== lastSpeaker ? `${cleanText(seg.speaker)}: ` : '';
    lastSpeaker = seg.speaker;
    const groups = chunk(text, prefix);
    const startMs = Math.round(seg.startSec * 1000);
    const endMs = Math.max(startMs, Math.round(seg.endSec * 1000));
    const total = groups.reduce((n, g) => n + g.join(' ').length, 0);
    let at = startMs;
    let used = 0;
    for (const g of groups) {
      used += g.join(' ').length;
      const end = startMs + Math.round(((endMs - startMs) * used) / total);
      raw.push({ startMs: at, endMs: end, lines: g, ...(seg.speaker ? { speaker: seg.speaker } : {}) });
      at = end;
    }
  }
  return fixTimings(raw);
}

/**
 * Make cue timings safe: each cue starts no earlier than the previous one
 * ends, ends no later than the next one starts, lasts at least 0.5 s when the
 * gap allows (borrowing from the silence after it), and never has zero length.
 */
export function fixTimings(cues: Cue[]): Cue[] {
  for (let i = 0; i < cues.length; i++) {
    const c = cues[i] as Cue;
    const prev = cues[i - 1];
    const next = cues[i + 1];
    if (prev && c.startMs < prev.endMs) c.startMs = prev.endMs;
    const limit = next ? next.startMs : Number.POSITIVE_INFINITY;
    let end = Math.min(Math.max(c.endMs, c.startMs + MIN_MS), limit);
    // The next cue starts at (or before) this one: there is no room at all, so
    // take a minimal slot and let the next cue start after it.
    if (end <= c.startMs) end = c.startMs + Math.min(MIN_MS, Math.max(1, c.endMs - c.startMs));
    c.endMs = end;
  }
  return cues;
}

/** 3723.5 s -> "01:02:03.500" (VTT) or "01:02:03,500" (SRT). */
export function cueTime(ms: number, sep: '.' | ','): string {
  const t = Math.max(0, Math.round(ms));
  const h = Math.floor(t / 3_600_000);
  const m = Math.floor((t % 3_600_000) / 60_000);
  const s = Math.floor((t % 60_000) / 1000);
  const f = t % 1000;
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${p(h)}:${p(m)}:${p(s)}${sep}${p(f, 3)}`;
}

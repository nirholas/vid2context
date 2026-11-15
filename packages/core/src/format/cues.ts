/**
 * Caption cues for every subtitle format (srt, vtt, ass, ttml, sbv, lrc).
 * Each segment becomes one or more cues of at most `maxLines` lines of at
 * most `maxLineChars` characters (default 2 lines of 42), broken on word
 * boundaries, with the segment's time shared out in proportion to text
 * length. Timings are then made safe for players: in order, never
 * overlapping, never zero-length, and at least 0.5 s long whenever the gap to
 * the next cue allows it.
 *
 * Bilingual subtitles: with `secondary` segments (a translated or second
 * language track), each primary segment takes the secondary text it overlaps
 * most in time (see secondary.ts), and that text is shared out over the
 * segment's cues the same way, so both languages respect the line limits.
 */
import { Vid2ContextError } from '../errors.ts';
import type { Segment, Transcript } from '../types.ts';
import { cleanText } from './paragraphs.ts';
import { alignSecondary } from './secondary.ts';

export const MAX_LINE = 42;
export const MAX_LINES = 2;
const MIN_MS = 500;

/** Accepted ranges for the layout options; values outside are clamped. */
export const LINE_CHARS_RANGE = { min: 10, max: 200 } as const;
export const LINES_RANGE = { min: 1, max: 4 } as const;

export interface Cue {
  startMs: number;
  endMs: number;
  lines: string[];
  speaker?: string;
  /** Lines of the secondary (second language) text for this cue, when there is any. */
  secondary?: string[];
}

export interface CueLayout {
  maxLineChars: number;
  maxLines: number;
}

export interface CueOptions {
  /** Longest line in characters. Default 42, clamped to 10..200. */
  maxLineChars?: number;
  /** Most lines per cue. Default 2, clamped to 1..4. */
  maxLines?: number;
  /** A second-language transcript shown under the primary text of each cue. */
  secondary?: Transcript;
}

function clampOption(name: string, value: number | undefined, fallback: number, range: { min: number; max: number }): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Vid2ContextError('bad-request', `${name} must be a number.`, {
      hint: `Pass ${name} as a whole number from ${range.min} to ${range.max}, or leave it out for ${fallback}.`,
    });
  }
  return Math.min(range.max, Math.max(range.min, Math.round(value)));
}

/** The line layout from format options: defaults filled in, out-of-range values clamped. */
export function resolveLayout(opts: CueOptions = {}): CueLayout {
  return {
    maxLineChars: clampOption('maxLineChars', opts.maxLineChars, MAX_LINE, LINE_CHARS_RANGE),
    maxLines: clampOption('maxLines', opts.maxLines, MAX_LINES, LINES_RANGE),
  };
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

/** Split words into exactly `k` contiguous parts of about equal character length (a part may be empty). */
function splitInto(words: string[], k: number): string[][] {
  const total = words.reduce((n, w) => n + w.length + 1, 0);
  const parts: string[][] = Array.from({ length: k }, () => []);
  let pos = 0;
  for (const w of words) {
    const mid = pos + (w.length + 1) / 2;
    pos += w.length + 1;
    parts[Math.min(k - 1, Math.floor((mid * k) / total))]?.push(w);
  }
  return parts;
}

/** Split words into at most `k` contiguous non-empty parts of about equal character length. */
function splitBalanced(words: string[], k: number): string[][] {
  return splitInto(words, k).filter((p) => p.length);
}

/**
 * Lay out one cue's words on at most `maxLines` lines, as even as possible;
 * null when they do not fit. Two lines are balanced by trying every break;
 * three or four lines split the words evenly by length.
 */
function layout(words: string[], l: CueLayout): string[] | null {
  const max = l.maxLineChars;
  const one = words.join(' ');
  if (one.length <= max) return [one];
  if (l.maxLines === 1) return null;
  if (l.maxLines === 2) {
    let best: string[] | null = null;
    for (let i = 1; i < words.length; i++) {
      const a = words.slice(0, i).join(' ');
      const b = words.slice(i).join(' ');
      if (a.length > max || b.length > max) continue;
      if (!best || Math.max(a.length, b.length) < Math.max(best[0]?.length ?? 0, best[1]?.length ?? 0)) best = [a, b];
    }
    return best;
  }
  for (let n = 2; n <= l.maxLines && n <= words.length; n++) {
    const lines = splitBalanced(words, n).map((p) => p.join(' '));
    if (lines.every((x) => x.length <= max)) return lines;
  }
  const greedy = wrapWords(one, max);
  return greedy.length <= l.maxLines ? greedy : null;
}

/** Words of `text`, with words longer than a line cut into line-sized pieces. */
function lineWords(text: string, max: number): string[] {
  return wrapWords(text, max)
    .join(' ')
    .split(' ')
    .filter(Boolean)
    .flatMap((w) => (w.length > max ? wrapWords(w, max) : [w]));
}

/** Fewest cues that hold `words` within the layout. */
function cuesNeeded(words: string[], l: CueLayout): number {
  for (let k = Math.ceil(wrapWords(words.join(' '), l.maxLineChars).length / l.maxLines); k <= words.length; k++) {
    if (splitInto(words, k).every((p) => p.length === 0 || layout(p, l) !== null)) return k;
  }
  return words.length;
}

/**
 * `text` as cue line groups of about equal length, so the time shared out to
 * each cue is about equal too. With `prefix` (an SRT speaker label), the
 * label counts toward the first line's length. At least `minGroups` groups
 * when the words allow it (room for the secondary text).
 */
function chunk(text: string, l: CueLayout, prefix = '', minGroups = 1): string[][] {
  const words = lineWords(prefix + text, l.maxLineChars);
  for (
    let k = Math.max(minGroups, Math.ceil(wrapWords(words.join(' '), l.maxLineChars).length / l.maxLines));
    k <= words.length;
    k++
  ) {
    const groups = splitBalanced(words, k).map((g) => layout(g, l));
    if (groups.every((g) => g !== null)) return groups as string[][];
  }
  return words.map((w) => [w]);
}

/**
 * Build cues from segments. `speakerPrefix` writes `Name: ` before the text
 * of the first cue of each speaker turn (SRT, SBV and LRC have no voice
 * markup; VTT uses `<v Name>` and ASS the Dialogue Name field, and pass
 * false). `opts` sets the line layout and the secondary transcript.
 */
export function buildCues(segments: Segment[], speakerPrefix: boolean, opts: CueOptions = {}): Cue[] {
  const l = resolveLayout(opts);
  const raw: Cue[] = [];
  const sorted = segments.filter((s) => cleanText(s.text)).sort((a, b) => a.startSec - b.startSec);
  const secondary = opts.secondary ? alignSecondary(sorted, opts.secondary.segments) : [];
  let lastSpeaker: string | undefined;
  sorted.forEach((seg, idx) => {
    const text = cleanText(seg.text);
    const prefix = speakerPrefix && seg.speaker && seg.speaker !== lastSpeaker ? `${cleanText(seg.speaker)}: ` : '';
    lastSpeaker = seg.speaker;
    const secWords = lineWords(secondary[idx] ?? '', l.maxLineChars);
    const groups = chunk(text, l, prefix, secWords.length ? cuesNeeded(secWords, l) : 1);
    const secGroups = secWords.length
      ? splitInto(secWords, groups.length).map((p) => (p.length ? (layout(p, l) ?? wrapWords(p.join(' '), l.maxLineChars)) : []))
      : [];
    const startMs = Math.round(seg.startSec * 1000);
    const endMs = Math.max(startMs, Math.round(seg.endSec * 1000));
    const total = groups.reduce((n, g) => n + g.join(' ').length, 0);
    let at = startMs;
    let used = 0;
    groups.forEach((g, i) => {
      used += g.join(' ').length;
      const end = startMs + Math.round(((endMs - startMs) * used) / total);
      const sec = secGroups[i];
      raw.push({
        startMs: at,
        endMs: end,
        lines: g,
        ...(seg.speaker ? { speaker: seg.speaker } : {}),
        ...(sec?.length ? { secondary: sec } : {}),
      });
      at = end;
    });
  });
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

/** Cue options from format options (the subset buildCues reads). */
export function cueOptions(opts: CueOptions): CueOptions {
  return {
    ...(opts.maxLineChars !== undefined ? { maxLineChars: opts.maxLineChars } : {}),
    ...(opts.maxLines !== undefined ? { maxLines: opts.maxLines } : {}),
    ...(opts.secondary ? { secondary: opts.secondary } : {}),
  };
}

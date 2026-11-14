/**
 * Repetition guard for speech-to-text output. Whisper-style decoders can get
 * stuck and emit the same token or phrase over and over ("ギギギギ...",
 * "really, really, really, ..."), and they invent sign-off lines on silence
 * at the end of audio ("Thanks for watching", "I'll see you next time").
 *
 * Loops: an n-gram (n = 1..6) repeated more than `maxRepeats` times in a row,
 * inside one segment or running on across neighbours, is cut back to two
 * occurrences. Segments that lose text get a low confidence; segments left
 * empty are dropped.
 *
 * Dominant token: a segment of 8 or more tokens where one token makes up over
 * 70 percent is flagged (confidence lowered, text kept).
 *
 * Sign-off hallucinations: flagged, never deleted, and only when they sit in
 * one of the last two segments and carry little information (under one word
 * per second, or after a pause of 2 s or more), so a creator who really says
 * "thanks for watching" at normal speed is left alone.
 *
 * Thresholds were tuned on real data: the 521 auto-caption segments of
 * tests/fixtures/contexts/youtube-cCPsdFdlshc.json contain natural repeats
 * such as "it it it happens", "really really well" and "yes yes", and the
 * guard leaves all of them alone; the recorded OVH loop repeats one token 19
 * times.
 */
import type { Segment } from '../types.ts';
import { addCleanExample, type CleanReport, cleanSplitWords, emptyCleanReport } from './report.ts';

export interface GuardRepetitionOptions {
  /** An n-gram repeated more than this many times in a row is a loop. Default 4. */
  maxRepeats?: number;
  /** Longest n-gram checked. Default 6. */
  maxNgram?: number;
  /** Confidence given to collapsed and flagged segments. Default 0.2. */
  lowConfidence?: number;
  /** Flag known sign-off hallucinations in the tail. Default true. */
  flagHallucinations?: boolean;
}

interface Token {
  text: string;
  key: string;
  /** Separator written before this token: ' ' between words, '' inside a run of CJK characters. */
  sep: string;
  seg: number;
}

/** Scripts written without spaces: each character is its own token. */
const CHAR_SCRIPT = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u;

function tokenKey(text: string): string {
  const k = text.toLowerCase().replace(/[^\p{L}\p{N}']/gu, '');
  return k || text;
}

function tokenize(text: string, seg: number): Token[] {
  const out: Token[] = [];
  for (const word of cleanSplitWords(text)) {
    if (!CHAR_SCRIPT.test(word)) {
      out.push({ text: word, key: tokenKey(word), sep: ' ', seg });
      continue;
    }
    let first = true;
    let buf = '';
    const flush = () => {
      if (!buf) return;
      out.push({ text: buf, key: tokenKey(buf), sep: first ? ' ' : '', seg });
      first = false;
      buf = '';
    };
    for (const ch of word) {
      if (CHAR_SCRIPT.test(ch)) {
        flush();
        out.push({ text: ch, key: ch, sep: first ? ' ' : '', seg });
        first = false;
      } else {
        buf += ch;
      }
    }
    flush();
  }
  return out;
}

function join(tokens: Token[]): string {
  return tokens.map((t, i) => (i === 0 ? '' : t.sep) + t.text).join('');
}

/** How many times tokens[i..i+n) repeats back to back starting at i. */
function repeats(tokens: Token[], i: number, n: number): number {
  let count = 1;
  for (let j = i + n; j + n <= tokens.length; j += n) {
    for (let m = 0; m < n; m++) {
      if (tokens[j + m]?.key !== tokens[i + m]?.key) return count;
    }
    count++;
  }
  return count;
}

const SIGN_OFFS = [
  'thanks for watching',
  'thank you for watching',
  'thank you so much for watching',
  'thank you very much for watching',
  'thank you',
  'thanks',
  'subtitles by',
  'captions by',
  'transcribed by',
  'transcription by',
  'please subscribe',
  'like and subscribe',
  "don't forget to subscribe",
  'see you next time',
  "i'll see you next time",
  'see you in the next video',
  'bye',
  'bye bye',
];

function signOff(text: string): boolean {
  const norm = text
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/[^\p{L}\p{N}' ]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!norm || cleanSplitWords(norm).length > 12) return false;
  return SIGN_OFFS.some((p) => norm === p || norm.startsWith(`${p} `));
}

function lower(seg: Segment, to: number): Segment {
  return { ...seg, confidence: Math.min(seg.confidence ?? 1, to) };
}

export function guardRepetition(
  segments: readonly Segment[],
  opts: GuardRepetitionOptions = {},
): { segments: Segment[]; report: CleanReport } {
  const maxRepeats = opts.maxRepeats ?? 4;
  const maxNgram = opts.maxNgram ?? 6;
  const low = opts.lowConfidence ?? 0.2;
  const report = emptyCleanReport('guard-repetition');

  const tokens = segments.flatMap((s, i) => tokenize(s.text, i));
  const drop = new Set<number>();
  for (let i = 0; i < tokens.length; ) {
    let best = { n: 0, count: 0 };
    for (let n = 1; n <= maxNgram && i + n * (maxRepeats + 1) <= tokens.length; n++) {
      const count = repeats(tokens, i, n);
      if (count > maxRepeats && count * n > best.count * best.n) best = { n, count };
    }
    if (best.n === 0) {
      i++;
      continue;
    }
    for (let j = i + 2 * best.n; j < i + best.count * best.n; j++) drop.add(j);
    i += best.count * best.n;
  }

  const bySeg = new Map<number, Token[]>();
  tokens.forEach((t, i) => {
    if (drop.has(i)) return;
    const list = bySeg.get(t.seg) ?? [];
    list.push(t);
    bySeg.set(t.seg, list);
  });
  const touched = new Set(tokens.filter((_, i) => drop.has(i)).map((t) => t.seg));

  const out: Segment[] = [];
  segments.forEach((seg, i) => {
    if (!touched.has(i)) {
      out.push({ ...seg });
      return;
    }
    const kept = bySeg.get(i) ?? [];
    if (kept.length === 0) {
      report.removed++;
      addCleanExample(report, { atSec: seg.startSec, before: seg.text, after: '', rule: 'repetition-loop' });
      return;
    }
    const text = join(kept).replace(/[,;:]+$/, '');
    out.push(lower({ ...seg, text }, low));
    report.rewritten++;
    addCleanExample(report, { atSec: seg.startSec, before: seg.text, after: text, rule: 'repetition-loop' });
  });

  // Dominant token, on segments the loop pass left alone.
  for (let i = 0; i < out.length; i++) {
    const seg = out[i];
    if (!seg || (seg.confidence !== undefined && seg.confidence <= low)) continue;
    const toks = tokenize(seg.text, 0);
    if (toks.length < 8) continue;
    const counts = new Map<string, number>();
    for (const t of toks) counts.set(t.key, (counts.get(t.key) ?? 0) + 1);
    const top = Math.max(...counts.values());
    if (top / toks.length > 0.7) {
      out[i] = lower(seg, low);
      report.flagged++;
      addCleanExample(report, { atSec: seg.startSec, before: seg.text, after: seg.text, rule: 'dominant-token' });
    }
  }

  if (opts.flagHallucinations ?? true) {
    for (let i = Math.max(0, out.length - 2); i < out.length; i++) {
      const seg = out[i];
      if (!seg || !signOff(seg.text)) continue;
      const words = cleanSplitWords(seg.text).length;
      const dur = Math.max(0, seg.endSec - seg.startSec);
      const prev = out[i - 1];
      const gap = prev ? seg.startSec - prev.endSec : 0;
      const sparse = dur > 0 && words / dur < 1;
      if (!sparse && gap < 2) continue;
      if (seg.confidence !== undefined && seg.confidence <= low) continue;
      out[i] = lower(seg, low);
      report.flagged++;
      addCleanExample(report, { atSec: seg.startSec, before: seg.text, after: seg.text, rule: 'hallucination-tail' });
    }
  }

  return { segments: out, report };
}

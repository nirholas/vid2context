/**
 * Stitching chunk transcripts into one. Each chunk after the first repeats
 * the last `overlapSec` of the previous chunk, so the words spoken in that
 * window appear twice. For each seam we:
 *
 *   1. give every word a time (see below),
 *   2. find the longest run of identical normalized words between the end of
 *      chunk N and the start of chunk N+1,
 *   3. keep chunk N up to the middle of that run and chunk N+1 from there on.
 *
 * When either side has no words inside the overlap (the cut fell in a pause,
 * or the model heard nothing there), there is nothing to deduplicate: both
 * sides keep every word and the seam is reported as `silence`. When both
 * sides have words but no run of at least two matches, both are cut at the
 * middle of the overlap by time and the seam is reported as `time-cut`.
 *
 * Word times come from the rung when it reports them per segment
 * (`words: [{ startSec, endSec }]`, shifted to the global timeline here);
 * otherwise they are spread across the segment by character count.
 *
 * Segments that keep all their words keep their original text and times, so
 * the raw transcript survives everywhere except the trimmed seam segments.
 */
import type { Segment } from '../types.ts';

export interface ChunkTranscript {
  /** Where the chunk starts in the original audio, seconds. */
  startSec: number;
  durationSec: number;
  overlapSec: number;
  /** Segments with chunk-local times (0 = chunk start). */
  segments: Segment[];
}

export interface SeamReport {
  /** Seam between chunk `index - 1` and chunk `index` (0-based). */
  index: number;
  method: 'aligned' | 'silence' | 'time-cut' | 'no-overlap';
  /** Words matched in the overlap (0 unless aligned). */
  matchedWords: number;
  /** Where the seam was cut on the global timeline, seconds. */
  cutSec: number;
}

interface Word {
  token: string;
  norm: string;
  start: number;
  end: number;
  seg: number;
  /** The rung's own word entry (shifted to the global timeline) when it reported word times. */
  timed?: TimedWord;
}

/** Word timings some rungs attach to a segment (`words: [{ word, startSec, endSec }]`). */
interface TimedWord {
  startSec: number;
  endSec: number;
  [k: string]: unknown;
}

function timedWords(s: Segment): TimedWord[] | undefined {
  const w = (s as Segment & { words?: unknown }).words;
  if (!Array.isArray(w)) return undefined;
  return w.every((x) => typeof x?.startSec === 'number' && typeof x?.endSec === 'number') ? (w as TimedWord[]) : undefined;
}

export function normalizeWord(w: string): string {
  return w
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\p{L}\p{N}]+/gu, '');
}

/** Words of a chunk on the global timeline, times clamped to the chunk. */
function wordsOf(chunk: ChunkTranscript): { words: Word[]; segs: Segment[] } {
  const lo = chunk.startSec;
  const hi = chunk.startSec + chunk.durationSec;
  const clamp = (t: number) => Math.min(hi, Math.max(lo, t));
  const segs: Segment[] = chunk.segments.map((s) => {
    const out: Segment & { words?: TimedWord[] } = {
      ...s,
      startSec: clamp(s.startSec + lo),
      endSec: clamp(Math.max(s.endSec, s.startSec) + lo),
    };
    const tw = timedWords(s);
    if (tw) out.words = tw.map((w) => ({ ...w, startSec: clamp(w.startSec + lo), endSec: clamp(w.endSec + lo) }));
    return out;
  });
  const words: Word[] = [];
  segs.forEach((s, seg) => {
    const tokens = s.text.split(/\s+/).filter(Boolean);
    const tw = timedWords(s);
    // Real word times when the rung gave one per token; otherwise spread the segment by character count.
    if (tw && tw.length === tokens.length) {
      tokens.forEach((token, k) => {
        const t = tw[k] as TimedWord;
        words.push({ token, norm: normalizeWord(token), start: t.startSec, end: t.endSec, seg, timed: t });
      });
      return;
    }
    const chars = tokens.reduce((n, t) => n + t.length, 0) || 1;
    let acc = 0;
    for (const token of tokens) {
      const start = s.startSec + ((s.endSec - s.startSec) * acc) / chars;
      acc += token.length;
      const end = s.startSec + ((s.endSec - s.startSec) * acc) / chars;
      words.push({ token, norm: normalizeWord(token), start, end, seg });
    }
  });
  return { words, segs };
}

/** Longest common contiguous run of non-empty normalized words: [startA, startB, length]. */
function longestRun(a: Word[], b: Word[]): [number, number, number] {
  let best: [number, number, number] = [0, 0, 0];
  let prev = new Array<number>(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    const cur = new Array<number>(b.length + 1).fill(0);
    for (let j = 1; j <= b.length; j++) {
      const wa = a[i - 1] as Word;
      const wb = b[j - 1] as Word;
      if (wa.norm !== '' && wa.norm === wb.norm) {
        cur[j] = (prev[j - 1] as number) + 1;
        const run = cur[j] as number;
        if (run > best[2]) best = [i - run, j - run, run];
      }
    }
    prev = cur;
  }
  return best;
}

/** Rebuild segments from the kept word range [from, to) of one chunk. */
function keptSegments(words: Word[], segs: Segment[], from: number, to: number): Segment[] {
  const out: Segment[] = [];
  const totals = new Map<number, number>();
  for (const w of words) totals.set(w.seg, (totals.get(w.seg) ?? 0) + 1);
  let i = from;
  while (i < to) {
    const seg = (words[i] as Word).seg;
    let j = i;
    while (j < to && (words[j] as Word).seg === seg) j++;
    const original = segs[seg] as Segment;
    if (j - i === totals.get(seg)) {
      out.push(original);
    } else {
      const first = words[i] as Word;
      const last = words[j - 1] as Word;
      const kept = words.slice(i, j);
      const trimmed: Segment & { words?: TimedWord[] } = {
        ...original,
        startSec: first.start,
        endSec: last.end,
        text: kept.map((w) => w.token).join(' '),
      };
      if (timedWords(original)) {
        if (kept.every((w) => w.timed)) trimmed.words = kept.map((w) => w.timed as TimedWord);
        else delete trimmed.words;
      }
      out.push(trimmed);
    }
    i = j;
  }
  return out;
}

/** Stitch chunk transcripts (in order) into one global segment list. */
export function stitchChunks(chunks: ChunkTranscript[]): { segments: Segment[]; seams: SeamReport[] } {
  const parsed = chunks.map(wordsOf);
  // Kept word range per chunk; seams narrow them.
  const from = parsed.map(() => 0);
  const to = parsed.map((p) => p.words.length);
  const seams: SeamReport[] = [];

  for (let n = 1; n < chunks.length; n++) {
    const prevChunk = chunks[n - 1] as ChunkTranscript;
    const chunk = chunks[n] as ChunkTranscript;
    const A = (parsed[n - 1] as { words: Word[] }).words;
    const B = (parsed[n] as { words: Word[] }).words;
    const winStart = chunk.startSec;
    const winEnd = prevChunk.startSec + prevChunk.durationSec;
    if (chunk.overlapSec <= 0 || winEnd <= winStart) {
      seams.push({ index: n, method: 'no-overlap', matchedWords: 0, cutSec: winStart });
      continue;
    }
    // Candidate words: a little slack either side, since word times are estimates.
    const slack = Math.max(1, chunk.overlapSec);
    const aLo = Math.max(
      from[n - 1] as number,
      A.findIndex((w) => w.end >= winStart - slack),
    );
    const aIdx = aLo < 0 ? A.length : aLo;
    let bHi = B.findIndex((w) => w.start > winEnd + slack);
    if (bHi < 0) bHi = B.length;
    const aWin = A.slice(aIdx, to[n - 1]);
    const bWin = B.slice(0, bHi);
    const [ra, rb, len] = longestRun(aWin, bWin);
    if (len >= 2) {
      const mid = Math.floor(len / 2);
      const cutA = aIdx + ra + mid; // first dropped word of chunk N-1
      const cutB = rb + mid; // first kept word of chunk N
      to[n - 1] = cutA;
      from[n] = cutB;
      const cutWord = B[cutB];
      seams.push({ index: n, method: 'aligned', matchedWords: len, cutSec: cutWord ? cutWord.start : winEnd });
    } else {
      const cut = (winStart + winEnd) / 2;
      const inside = (w: Word) => (w.start + w.end) / 2 >= winStart && (w.start + w.end) / 2 <= winEnd;
      if (!aWin.some(inside) || !bWin.some(inside)) {
        // One side heard nothing in the overlap, so nothing is duplicated: keep every word on both sides.
        seams.push({ index: n, method: 'silence', matchedWords: 0, cutSec: cut });
        continue;
      }
      const ia = A.findIndex((w, i) => i >= (from[n - 1] as number) && (w.start + w.end) / 2 >= cut);
      to[n - 1] = Math.min(to[n - 1] as number, ia < 0 ? A.length : ia);
      const ib = B.findIndex((w) => (w.start + w.end) / 2 >= cut);
      from[n] = ib < 0 ? B.length : ib;
      seams.push({ index: n, method: 'time-cut', matchedWords: 0, cutSec: cut });
    }
  }

  const segments: Segment[] = [];
  let lastStart = 0;
  parsed.forEach((p, n) => {
    for (const s of keptSegments(p.words, p.segs, from[n] as number, Math.max(from[n] as number, to[n] as number))) {
      // Keep the timeline monotonic even when a lane reports overlapping segment times.
      const startSec = Math.max(s.startSec, lastStart);
      const endSec = Math.max(s.endSec, startSec);
      lastStart = startSec;
      segments.push(startSec === s.startSec && endSec === s.endSec ? s : { ...s, startSec, endSec });
    }
  });
  return { segments, seams };
}

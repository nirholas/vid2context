/**
 * Overlap handling. Each chunk repeats the last couple of seconds of the
 * previous one so a word cut at the boundary is heard whole once. That means
 * the start of a chunk's transcript usually repeats the end of the previous
 * chunk's, and the repeat has to go.
 *
 * Speech-to-text segments rarely carry word timings, so the match is on
 * words: find the longest run at the head of the new chunk that equals the
 * tail of what was already emitted, allowing the new chunk to start with up
 * to two garbled words (a word cut at the chunk start) and the old tail to
 * end with one cut word. When nothing matches, fall back to time: drop new
 * segments that lie entirely inside the overlap.
 */
import type { Segment } from '@vid2context/core';

/** Lowercase letters, digits and inner apostrophes only, so "Pricing," and "pricing" match. */
export function normalizeWord(word: string): string {
  return word
    .toLowerCase()
    .replace(/[^\p{L}\p{N}']/gu, '')
    .replace(/^'+|'+$/g, '');
}

/** The normalized words of some segments, dropping tokens that are only punctuation. */
export function wordsOf(segments: Segment[]): string[] {
  return segments.flatMap((s) => s.text.split(/\s+/).map(normalizeWord)).filter(Boolean);
}

interface HeadToken {
  seg: number;
  /** Index of the raw token inside its segment. */
  tok: number;
  norm: string;
}

export interface OverlapResult {
  segments: Segment[];
  /** Words removed as duplicates of the previous chunk. */
  droppedWords: number;
  /** 'words' when a duplicated run was found, 'time' when segments inside the overlap were dropped instead, 'none' otherwise. */
  method: 'words' | 'time' | 'none';
}

const MAX_RUN = 12;
const MAX_LEAD = 2;
const MAX_TAIL_CUT = 1;

function findRun(prevTail: string[], head: HeadToken[]): { k: number; j: number } | null {
  const n = prevTail.length;
  for (let k = Math.min(MAX_RUN, n, head.length); k >= 1; k--) {
    for (let j = 0; j <= MAX_LEAD && j + k <= head.length; j++) {
      for (let i = 0; i <= MAX_TAIL_CUT && n - i - k >= 0; i++) {
        const from = n - i - k;
        let same = true;
        for (let t = 0; t < k && same; t++) same = prevTail[from + t] === head[j + t]?.norm;
        if (!same) continue;
        // A single matching word only counts as the very first word, and not a short filler like "the".
        if (k === 1 && (j > 0 || i > 0 || (head[0]?.norm.length ?? 0) < 4)) continue;
        return { k, j };
      }
    }
  }
  return null;
}

/**
 * Remove the words at the start of `segments` that repeat the end of `prevTail`
 * (normalized words already emitted). `boundarySec` is where the previous
 * chunk ended, in the same time base as the segments: everything before it in
 * the new chunk is overlap.
 */
export function dedupeOverlap(prevTail: string[], segments: Segment[], boundarySec: number): OverlapResult {
  if (prevTail.length === 0 || segments.length === 0) return { segments, droppedWords: 0, method: 'none' };
  const raw = segments.map((s) => s.text.split(/\s+/).filter(Boolean));
  const head: HeadToken[] = [];
  for (let seg = 0; seg < raw.length && head.length < MAX_RUN + MAX_LEAD; seg++) {
    const tokens = raw[seg] ?? [];
    for (let tok = 0; tok < tokens.length && head.length < MAX_RUN + MAX_LEAD; tok++) {
      const norm = normalizeWord(tokens[tok] ?? '');
      if (norm) head.push({ seg, tok, norm });
    }
  }

  const run = findRun(prevTail, head);
  const last = run ? head[run.j + run.k - 1] : undefined;
  if (last) {
    const out: Segment[] = [];
    let dropped = 0;
    segments.forEach((s, seg) => {
      const tokens = raw[seg] ?? [];
      if (seg < last.seg) {
        dropped += tokens.length;
        return;
      }
      if (seg > last.seg) {
        out.push(s);
        return;
      }
      const keep = tokens.slice(last.tok + 1);
      dropped += last.tok + 1;
      if (keep.length > 0)
        out.push({ ...s, startSec: Math.min(Math.max(s.startSec, boundarySec), s.endSec), text: keep.join(' ') });
    });
    return { segments: out, droppedWords: dropped, method: 'words' };
  }

  const inside = (s: Segment) => s.endSec <= boundarySec + 0.25;
  const removed = segments.filter(inside);
  if (removed.length === 0) return { segments, droppedWords: 0, method: 'none' };
  return { segments: segments.filter((s) => !inside(s)), droppedWords: wordsOf(removed).length, method: 'time' };
}

/**
 * BM25 over sliding windows of transcript segments. A window spans about
 * `windowSec` seconds of speech and windows start every `strideSec` seconds,
 * so a passage that straddles one window boundary still lands whole inside
 * the next window. Statistics (document frequency, average length) are taken
 * over every window of every video in the request, so a word common to all
 * the videos counts for less than a word only one of them uses.
 */
import type { Segment } from '@vid2context/core';
import { containsSequence, type ParsedQuery, STOP_WORDS, stem, tokenize } from './text.ts';

export interface Window {
  /** Index of the video this window belongs to. */
  doc: number;
  /** First and last segment index, inclusive. */
  first: number;
  last: number;
  startSec: number;
  endSec: number;
  /** Stemmed tokens with stop words kept, for exact-phrase matching. */
  sequence: string[];
  /** Term -> count, stop words removed. */
  tf: Map<string, number>;
  length: number;
}

export interface WindowOptions {
  windowSec?: number;
  strideSec?: number;
}

export const DEFAULT_WINDOW_SEC = 30;

/** Cut one transcript into overlapping windows of whole segments. */
export function buildWindows(segments: Segment[], doc: number, opts: WindowOptions = {}): Window[] {
  const windowSec = opts.windowSec ?? DEFAULT_WINDOW_SEC;
  const strideSec = opts.strideSec ?? windowSec / 2;
  const segs = segments;
  if (segs.length === 0) return [];
  const stems = segs.map((s) => tokenize(s.text).map(stem));
  const startOf = segs[0]?.startSec ?? 0;
  const endOf = segs.reduce((m, s) => Math.max(m, s.endSec), startOf);
  const out: Window[] = [];
  let lo = 0;
  let prevKey = '';
  for (let t = startOf; t < endOf; t += strideSec) {
    while (lo < segs.length && (segs[lo]?.endSec ?? 0) <= t) lo++;
    if (lo >= segs.length) break;
    let hi = lo;
    while (hi + 1 < segs.length && (segs[hi + 1]?.startSec ?? Number.POSITIVE_INFINITY) < t + windowSec) hi++;
    const key = `${lo}-${hi}`;
    if (key === prevKey) continue;
    prevKey = key;
    const sequence: string[] = [];
    const tf = new Map<string, number>();
    let length = 0;
    for (let i = lo; i <= hi; i++) {
      for (const tok of stems[i] ?? []) {
        sequence.push(tok);
        if (STOP_WORDS.has(tok)) continue;
        tf.set(tok, (tf.get(tok) ?? 0) + 1);
        length++;
      }
    }
    out.push({
      doc,
      first: lo,
      last: hi,
      startSec: segs[lo]?.startSec ?? t,
      endSec: segs[hi]?.endSec ?? t + windowSec,
      sequence,
      tf,
      length,
    });
  }
  return out;
}

export interface ScoredWindow {
  window: Window;
  score: number;
  /** Query terms (stems) found in the window. */
  matched: string[];
  /** Quoted phrases found verbatim. */
  phrases: number;
}

export interface Bm25Options {
  k1?: number;
  b?: number;
  /** Each quoted phrase found verbatim multiplies the score by (1 + phraseBoost). Default 1, so one phrase doubles it. */
  phraseBoost?: number;
}

/** Document frequency of every term across windows. */
export function documentFrequency(windows: Window[]): Map<string, number> {
  const df = new Map<string, number>();
  for (const w of windows) for (const t of w.tf.keys()) df.set(t, (df.get(t) ?? 0) + 1);
  return df;
}

/** Okapi BM25 with the Lucene IDF (never negative). Windows that match no query term are left out. */
export function scoreWindows(windows: Window[], query: ParsedQuery, opts: Bm25Options = {}): ScoredWindow[] {
  const k1 = opts.k1 ?? 1.2;
  const b = opts.b ?? 0.75;
  const boost = opts.phraseBoost ?? 1;
  const n = windows.length;
  if (n === 0 || query.terms.length === 0) return [];
  const df = documentFrequency(windows);
  const avgdl = windows.reduce((sum, w) => sum + w.length, 0) / n || 1;
  const idf = new Map(query.terms.map((t) => [t, Math.log(1 + (n - (df.get(t) ?? 0) + 0.5) / ((df.get(t) ?? 0) + 0.5))]));
  const out: ScoredWindow[] = [];
  for (const w of windows) {
    let score = 0;
    const matched: string[] = [];
    for (const t of query.terms) {
      const f = w.tf.get(t) ?? 0;
      if (f === 0) continue;
      matched.push(t);
      score += (idf.get(t) ?? 0) * ((f * (k1 + 1)) / (f + k1 * (1 - b + (b * w.length) / avgdl)));
    }
    if (score <= 0) continue;
    const phrases = query.phrases.filter((p) => containsSequence(w.sequence, p)).length;
    if (phrases > 0) score *= 1 + boost * phrases;
    out.push({ window: w, score, matched, phrases });
  }
  return out.sort((x, y) => y.score - x.score || x.window.doc - y.window.doc || x.window.startSec - y.window.startSec);
}

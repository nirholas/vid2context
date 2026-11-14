/**
 * Rolling-caption dedupe. Platform auto-captions show text in overlapping
 * windows, so a cue often starts with the words the previous cue ended on.
 * For each pair of neighbours we find the longest run of words that ends the
 * previous segment and starts the next one, and drop it from the next: those
 * words keep the earlier segment and its earlier start time.
 */
import type { Segment } from '../types.ts';
import { addCleanExample, type CleanReport, cleanSplitWords, cleanWordKey, emptyCleanReport } from './report.ts';

export interface DedupeRollingOptions {
  /**
   * Shortest overlap, in words, that counts as a rolling duplicate. Default 2.
   * One shared word at a cue boundary ("so this | this generation") is as
   * likely a speaker repeating themselves as a caption artifact, so it stays.
   */
  minWords?: number;
}

function overlap(prev: string[], next: string[], minWords: number): number {
  for (let k = Math.min(prev.length, next.length); k >= minWords; k--) {
    let same = true;
    for (let i = 0; i < k; i++) {
      if (prev[prev.length - k + i] !== next[i]) {
        same = false;
        break;
      }
    }
    if (same) return k;
  }
  return 0;
}

export function dedupeRollingCaptions(
  segments: readonly Segment[],
  opts: DedupeRollingOptions = {},
): { segments: Segment[]; report: CleanReport } {
  const minWords = Math.max(1, opts.minWords ?? 2);
  const report = emptyCleanReport('dedupe-rolling');
  const out: Segment[] = [];
  /** Normalized words of the previous cue as it was shown, before any dedupe: the next window rolls on from it. */
  let prevKeys: string[] = [];
  for (const seg of segments) {
    const words = cleanSplitWords(seg.text);
    const keys = words.map(cleanWordKey);
    const last = out[out.length - 1];
    const k = last ? overlap(prevKeys, keys, minWords) : 0;
    prevKeys = keys;
    if (k === 0 || !last) {
      out.push({ ...seg });
      continue;
    }
    const rest = words.slice(k);
    if (rest.length === 0) {
      out[out.length - 1] = { ...last, endSec: Math.max(last.endSec, seg.endSec) };
      report.merged++;
      addCleanExample(report, { atSec: seg.startSec, before: seg.text, after: '', rule: 'rolling-duplicate' });
      continue;
    }
    const text = rest.join(' ');
    out.push({ ...seg, text });
    report.rewritten++;
    addCleanExample(report, { atSec: seg.startSec, before: seg.text, after: text, rule: 'rolling-duplicate' });
  }
  return { segments: out, report };
}

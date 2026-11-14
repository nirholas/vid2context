/**
 * Citation accuracy: does the quoted text really occur in the transcript
 * near the cited second?
 *
 * A citation passes when its quote, normalized as for WER but keeping
 * fillers, is a contiguous word sequence of the transcript text spoken
 * within `toleranceSec` of the cited time. "Spoken within" uses the
 * interpolated word start times from `timedWords`, so a quote that starts
 * mid-segment is placed correctly. A quote shorter than `minWords` fails:
 * one or two common words would match almost anywhere.
 *
 * This is the same check prompt 32's `verifyCitations` performs; the eval
 * keeps its own copy so it scores briefs and answers from any producer.
 */
import type { Segment } from '@vid2context/core';
import { normalizeWords } from './normalize.ts';
import { type TimedWord, timedWords } from './timing.ts';

export interface Citation {
  /** Video id (`platform:nativeId`) when citing across a collection. */
  videoId?: string;
  atSec: number;
  quote: string;
}

export interface CitationCheck {
  citation: Citation;
  ok: boolean;
  /** Why it failed: 'quote-too-short', 'no-transcript', 'not-found', 'wrong-time'. */
  reason?: string;
  /** Start time of the closest occurrence when the quote exists somewhere else in the transcript. */
  foundAtSec?: number;
}

export interface CitationAccuracy {
  total: number;
  verified: number;
  rate: number;
  checks: CitationCheck[];
}

export interface CitationOptions {
  toleranceSec?: number;
  minWords?: number;
  language?: string;
}

function occurrences(words: readonly TimedWord[], quote: readonly string[]): number[] {
  const starts: number[] = [];
  outer: for (let i = 0; i + quote.length <= words.length; i++) {
    for (let k = 0; k < quote.length; k++) if ((words[i + k] as TimedWord).word !== quote[k]) continue outer;
    starts.push((words[i] as TimedWord).startSec);
  }
  return starts;
}

/** Check one citation against one transcript. */
export function checkCitation(segments: readonly Segment[], citation: Citation, opts: CitationOptions = {}): CitationCheck {
  const toleranceSec = opts.toleranceSec ?? 30;
  const quote = normalizeWords(citation.quote, { language: opts.language, fillers: true });
  if (quote.length < (opts.minWords ?? 3)) return { citation, ok: false, reason: 'quote-too-short' };
  if (segments.length === 0) return { citation, ok: false, reason: 'no-transcript' };
  const starts = occurrences(timedWords(segments, { language: opts.language, fillers: true }), quote);
  if (starts.length === 0) return { citation, ok: false, reason: 'not-found' };
  const closest = starts.reduce((best, s) => (Math.abs(s - citation.atSec) < Math.abs(best - citation.atSec) ? s : best));
  if (Math.abs(closest - citation.atSec) <= toleranceSec) return { citation, ok: true, foundAtSec: closest };
  return { citation, ok: false, reason: 'wrong-time', foundAtSec: closest };
}

/** Score many citations. `transcripts` maps video id to segments; a citation without a video id uses `defaultVideoId`. */
export function citationAccuracy(
  citations: readonly Citation[],
  transcripts: ReadonlyMap<string, readonly Segment[]>,
  opts: CitationOptions & { defaultVideoId?: string } = {},
): CitationAccuracy {
  const checks = citations.map((c) => {
    const id = c.videoId ?? opts.defaultVideoId ?? '';
    return checkCitation(transcripts.get(id) ?? [], c, opts);
  });
  const verified = checks.filter((c) => c.ok).length;
  return { total: checks.length, verified, rate: checks.length === 0 ? 0 : verified / checks.length, checks };
}

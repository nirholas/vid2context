/**
 * The evidence rule: a speaker name is accepted only when the model quotes
 * transcript text that really exists near the time it cites, and the name
 * itself appears in the transcript or the video's own metadata. This is what
 * keeps the model from inventing names.
 */
import type { Segment, VideoMetadata } from '@vid2context/core';

/** Lowercase, fold curly quotes, drop punctuation, collapse whitespace. */
export function normalizeText(s: string): string {
  return s
    .toLowerCase()
    .replace(/[\u2018\u2019\u02bc]/g, "'")
    .replace(/[^\p{L}\p{N}']+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Default distance in seconds between a cited time and the segments searched for its quote. */
export const DEFAULT_TOLERANCE_SEC = 30;

/**
 * True when `quote` appears (normalized) in the transcript text of the
 * segments that start within `toleranceSec` of `startSec`. Neighbouring
 * segments are joined so a quote may span a segment boundary.
 */
export function quoteAppearsNear(
  segments: Segment[],
  quote: string,
  startSec: number,
  toleranceSec: number = DEFAULT_TOLERANCE_SEC,
): boolean {
  const q = normalizeText(quote);
  if (q.length < 3 || !Number.isFinite(startSec)) return false;
  const window = segments
    .filter((s) => s.endSec >= startSec - toleranceSec && s.startSec <= startSec + toleranceSec)
    .map((s) => s.text)
    .join(' ');
  return ` ${normalizeText(window)} `.includes(` ${q} `);
}

const HONORIFICS = new Set(['mr', 'mrs', 'ms', 'miss', 'dr', 'prof', 'sir', 'dame', 'mister', 'doctor', 'professor']);

/** Words that describe a role, not a person. A "name" made only of these is rejected. */
const GENERIC = new Set([
  'speaker',
  'unknown',
  'unnamed',
  'unidentified',
  'host',
  'cohost',
  'co',
  'guest',
  'narrator',
  'interviewer',
  'interviewee',
  'moderator',
  'panelist',
  'caller',
  'audience',
  'member',
  'man',
  'woman',
  'male',
  'female',
  'voice',
  'person',
  'none',
  'null',
  'n',
  'a',
  'the',
]);

/** Name words worth matching: no honorifics, no single letters, no role words. */
export function nameTokens(name: string): string[] {
  return normalizeText(name)
    .split(' ')
    .filter((t) => t.length >= 2 && !HONORIFICS.has(t) && !GENERIC.has(t) && !/^\d+$/.test(t));
}

/** A usable person name: short, not a diarization label, not only role words. */
export function isPlausibleName(name: string): boolean {
  const n = name.trim();
  if (n.length < 2 || n.length > 80) return false;
  if (/^speaker\s*[\w-]{0,3}$/i.test(n)) return false;
  return nameTokens(n).length > 0;
}

/** True when at least one word of the name appears in the transcript, title, channel or description. */
export function nameIsGrounded(name: string, segments: Segment[], metadata: VideoMetadata): boolean {
  const haystack = ` ${normalizeText(
    [metadata.title, metadata.channel?.name ?? '', metadata.description ?? '', ...segments.map((s) => s.text)].join(' '),
  )} `;
  return nameTokens(name).some((t) => haystack.includes(` ${t} `));
}

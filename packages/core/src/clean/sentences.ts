/**
 * Rule-based sentences for unpunctuated text (platform auto-captions).
 * Only punctuation and letter case change; words are never added, removed
 * or reordered.
 *
 *   A sentence ends where a segment ends and either the next segment starts
 *   after a pause of 0.8 s or more or opens with a discourse marker ("so",
 *   "okay", "well", "anyway", ...), unless the segment ends on a word that
 *   cannot close a sentence ("the", "and", "of", ...). The last segment
 *   always ends a sentence.
 *   The first word of each sentence and the pronoun "I" are capitalized.
 *
 * Text that already has punctuation (two or more marks per hundred words) is
 * returned unchanged: creator captions and speech-to-text output are left as
 * their producer wrote them. So is text with no lowercase letters at all
 * (scripts without letter case, such as Japanese or Chinese).
 */
import type { Segment } from '../types.ts';
import { addCleanExample, type CleanReport, cleanSplitWords, cleanWordKey, emptyCleanReport } from './report.ts';

export interface RestoreSentencesOptions {
  /** Pause, in seconds, that ends a sentence. Default 0.8. */
  pauseSec?: number;
  /** Punctuation marks per word at or above which text counts as already punctuated. Default 0.02. */
  punctuatedDensity?: number;
}

const MARKERS = new Set(['so', 'okay', 'ok', 'alright', 'now', 'well', 'anyway', 'anyways', 'yeah', 'yep', 'basically']);
const NO_END = new Set([
  'the',
  'a',
  'an',
  'and',
  'or',
  'but',
  'of',
  'to',
  'with',
  'for',
  'in',
  'on',
  'at',
  'by',
  'from',
  'is',
  'are',
  'was',
  'my',
  'your',
  'our',
  'their',
  'his',
  'her',
  'its',
  "it's",
  'this',
  'that',
  'these',
  'those',
  'if',
  'because',
  'than',
  'as',
]);
const PRONOUN_I = /^i(?:'(?:m|ve|ll|d|s))?$/;
const PUNCT_END = /[.,!?;:…]["')\]]*$/;

/** Share of words that end in punctuation, across all segments. */
export function punctuationDensity(segments: readonly Segment[]): number {
  let words = 0;
  let marks = 0;
  for (const s of segments) {
    for (const w of cleanSplitWords(s.text)) {
      words++;
      if (PUNCT_END.test(w)) marks++;
    }
  }
  return words === 0 ? 0 : marks / words;
}

function capitalize(word: string): string {
  const i = word.search(/\p{L}/u);
  if (i < 0) return word;
  return word.slice(0, i) + word.charAt(i).toUpperCase() + word.slice(i + 1);
}

export function restoreSentences(
  segments: readonly Segment[],
  opts: RestoreSentencesOptions = {},
): { segments: Segment[]; report: CleanReport } {
  const report = emptyCleanReport('restore-sentences');
  if (punctuationDensity(segments) >= (opts.punctuatedDensity ?? 0.02)) {
    report.steps = ['restore-sentences (skipped: already punctuated)'];
    return { segments: segments.map((s) => ({ ...s })), report };
  }
  if (!segments.some((s) => /\p{Ll}/u.test(s.text))) {
    // Scripts without letter case (Japanese, Chinese, ...) have their own sentence marks: leave them alone.
    report.steps = ['restore-sentences (skipped: no lowercase letters)'];
    return { segments: segments.map((s) => ({ ...s })), report };
  }
  const pause = opts.pauseSec ?? 0.8;
  const out: Segment[] = [];
  let atStart = true;
  segments.forEach((seg, i) => {
    const words = cleanSplitWords(seg.text);
    if (words.length === 0) {
      out.push({ ...seg });
      return;
    }
    const next = segments[i + 1];
    const nextFirst = next ? cleanWordKey(cleanSplitWords(next.text)[0] ?? '') : '';
    const lastKey = cleanWordKey(words[words.length - 1] ?? '');
    const longPause = next !== undefined && next.startSec - seg.endSec >= pause;
    const ends = !next || ((longPause || MARKERS.has(nextFirst)) && !NO_END.has(lastKey));
    const fixed = words.map((w, j) => {
      let word = w;
      if (PRONOUN_I.test(cleanWordKey(w))) word = capitalize(word);
      if (j === 0 && atStart) word = capitalize(word);
      if (j === words.length - 1 && ends && !PUNCT_END.test(word)) word = `${word}.`;
      return word;
    });
    atStart = ends;
    const text = fixed.join(' ');
    if (text !== seg.text) {
      report.rewritten++;
      addCleanExample(report, { atSec: seg.startSec, before: seg.text, after: text, rule: 'sentence' });
    }
    out.push({ ...seg, text });
  });
  return { segments: out, report };
}

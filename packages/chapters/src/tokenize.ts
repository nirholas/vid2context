/**
 * Turn timed transcript segments into content terms for lexical cohesion:
 * lowercase words, stopwords removed, English lightly stemmed so "engines"
 * and "engine" count as one term. Each term remembers the segment it came
 * from, so boundaries can snap back to real segment starts.
 */
import type { Segment } from '@vid2context/core';
import { stopwordsFor } from './stopwords.ts';

export interface Term {
  /** Stemmed form used for comparison. */
  stem: string;
  /** The word as spoken (lowercase), for building titles. */
  word: string;
  /** Index of the segment the word came from. */
  seg: number;
}

const WORD = /[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu;

/** Light English suffix stripping. Enough to merge plurals and common verb forms; not a full stemmer. */
export function stemEnglish(word: string): string {
  let w = word.replace(/['’]s$/, '');
  if (w.length > 4 && w.endsWith('ies')) return `${w.slice(0, -3)}y`;
  if (w.length > 4 && w.endsWith('sses')) return w.slice(0, -2);
  if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss') && !w.endsWith('us') && !w.endsWith('is')) w = w.slice(0, -1);
  if (w.length > 5 && w.endsWith('ing')) w = w.slice(0, -3);
  else if (w.length > 4 && w.endsWith('ed')) w = w.slice(0, -2);
  return w;
}

export function tokenize(segments: Segment[], language: string | undefined): Term[] {
  const stop = stopwordsFor(language);
  const english = (language ?? 'en').toLowerCase().startsWith('en');
  const out: Term[] = [];
  segments.forEach((s, seg) => {
    for (const m of s.text.toLowerCase().matchAll(WORD)) {
      const word = m[0].replace(/['’-]+$/, '');
      if (word.length < 3 || stop.has(word) || (/^\d+$/.test(word) && !/^(19|20)\d\d$/.test(word))) continue;
      // Drop music and sound tags that captions carry: [music], [applause].
      if (word === 'music' && /\[music\]/i.test(s.text)) continue;
      out.push({ stem: english ? stemEnglish(word) : word, word, seg });
    }
  });
  return out;
}

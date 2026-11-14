/**
 * Tokenizer for keyword search. The same steps run on transcripts and on
 * queries, so "chains" in a query finds "Chains" in a caption:
 *
 *   1. Unicode NFKD, strip combining marks ("cafe" matches "café"), lowercase.
 *   2. Split into runs of Unicode letters and digits. Model codes such as
 *      "g550" or "m113" stay whole, and also add their letter and digit parts
 *      as index terms, so "M113" finds a speaker who said "the 113 motor".
 *   3. Drop English stop words and caption filler ("um", "uh", "yeah").
 *   4. Light English stemming: plurals, -ing, -ed, -ly, -ness. Words with
 *      digits or non-ASCII letters pass through unchanged.
 *
 * Deliberately small and dependency-free so it runs in Node, Workers and the
 * browser alike.
 */

const STOP = new Set(
  (
    'a about above after again against all am an and any are as at be because been before being below between both but by ' +
    'can could did do does doing down during each few for from further had has have having he her here hers herself him ' +
    'himself his how i if in into is it its itself just me more most my myself no nor not now of off on once only or other ' +
    'our ours ourselves out over own same she should so some such than that the their theirs them themselves then there ' +
    'these they this those through to too under until up very was we were what when where which while who whom why will ' +
    'with would you your yours yourself yourselves ' +
    's t d ll m re ve don didn doesn isn wasn aren weren won wouldn couldn shouldn ' +
    'um uh yeah yep okay ok oh gonna wanna gotta mhm'
  ).split(/\s+/),
);

export function isStopWord(word: string): boolean {
  return STOP.has(word);
}

/** Lowercased runs of letters and digits, diacritics folded. No stop word removal, no stemming. */
export function words(text: string): string[] {
  return (
    text
      .normalize('NFKD')
      .replace(/\p{M}+/gu, '')
      .toLowerCase()
      .match(/[\p{L}\p{N}]+/gu) ?? []
  );
}

const VOWEL = /[aeiouy]/;

function undouble(w: string): string {
  // stopped -> stopp -> stop; keep "ll", "ss", "zz" (fall, miss, buzz).
  const last = w.at(-1);
  if (w.length > 3 && last !== undefined && last === w.at(-2) && !'lsz'.includes(last) && !VOWEL.test(last)) return w.slice(0, -1);
  return w;
}

/** Strip common English suffixes from a plain ASCII word. Anything else is returned as is. */
export function stem(word: string): string {
  let w = word;
  if (w.length <= 3 || !/^[a-z]+$/.test(w)) return w;
  if (w.endsWith('ies') && w.length > 4) w = `${w.slice(0, -3)}y`;
  else if (w.endsWith('sses')) w = w.slice(0, -2);
  else if (w.endsWith('s') && !w.endsWith('ss') && !w.endsWith('us') && !w.endsWith('is')) w = w.slice(0, -1);

  if (w.endsWith('ness') && w.length > 6) w = w.slice(0, -4);
  else if (w.endsWith('ingly') && w.length > 7) w = undouble(w.slice(0, -5));
  else if (w.endsWith('ing') && w.length > 5 && VOWEL.test(w.slice(0, -3))) w = undouble(w.slice(0, -3));
  else if (w.endsWith('ed') && !w.endsWith('eed') && w.length > 4 && VOWEL.test(w.slice(0, -2))) w = undouble(w.slice(0, -2));
  else if (w.endsWith('ly') && w.length > 5) w = w.slice(0, -2);
  return w;
}

/** Stemmed terms in order, stop words removed. Used for scoring and highlighting. */
export function terms(text: string): string[] {
  const out: string[] = [];
  for (const w of words(text)) {
    if (STOP.has(w)) continue;
    out.push(stem(w));
  }
  return out;
}

/**
 * Terms to index for one piece of text: `terms(text)` plus the letter and
 * digit parts of mixed tokens ("w463a" adds "w", "463", "a" minus stop words
 * and single letters), so a code matches when spoken as separate words.
 */
export function indexTerms(text: string): string[] {
  const out: string[] = [];
  for (const w of words(text)) {
    if (STOP.has(w)) continue;
    out.push(stem(w));
    if (/\p{L}/u.test(w) && /\p{N}/u.test(w)) {
      for (const part of w.match(/\p{L}+|\p{N}+/gu) ?? []) {
        if (part.length > 1 && !STOP.has(part)) out.push(stem(part));
      }
    }
  }
  return out;
}

/** Stemmed word sequence with stop words kept, for exact phrase matching. */
export function phraseWords(text: string): string[] {
  return words(text).map(stem);
}

/** True when `needle` appears as a contiguous run in `hay`. */
export function containsSequence(hay: string[], needle: string[]): boolean {
  if (needle.length === 0) return true;
  outer: for (let i = 0; i + needle.length <= hay.length; i++) {
    for (let j = 0; j < needle.length; j++) if (hay[i + j] !== needle[j]) continue outer;
    return true;
  }
  return false;
}

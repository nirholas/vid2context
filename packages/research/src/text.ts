/**
 * Tokenizing, stop words and a small English stemmer for lexical ranking.
 * The same functions run on the query and on the transcripts, so a word and
 * its plural or -ing form land on the same stem. This is deliberately simple:
 * it handles the suffixes that matter for spoken English (plurals, -ing, -ed,
 * -ly, -ability) and leaves everything else alone.
 */

/** Common English function words, plus the contraction fragments auto-captions split off ("you're" -> "you", "re"). */
export const STOP_WORDS: ReadonlySet<string> = new Set(
  (
    'a about above after again against all am an and any are as at be because been before being below between both but by ' +
    'can could did do does doing down during each few for from further had has have having he her here hers herself him ' +
    'himself his how i if in into is it its itself just let me more most my myself no nor not now of off on once only or ' +
    'other our ours ourselves out over own same she should so some such than that the their theirs them themselves then ' +
    'there these they this those through to too under until up very was we were what when where which while who whom why ' +
    'will with would you your yours yourself yourselves ' +
    "s t d ll m re ve don didn doesn isn wasn aren weren won wouldn couldn shouldn can't " +
    'um uh yeah yep okay oh gonna wanna gotta like really also'
  ).split(/\s+/),
);

/** Lowercase words and numbers. Diacritics are folded so "café" matches "cafe"; letters of every script are kept. */
export function tokenize(text: string): string[] {
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
  // running -> runn -> run, stopped -> stopp -> stop; keep "ll", "ss", "zz" (fall, miss, buzz).
  const last = w.at(-1);
  if (w.length > 3 && last === w.at(-2) && last && !'lsz'.includes(last) && !VOWEL.test(last)) return w.slice(0, -1);
  return w;
}

/**
 * Strip common English suffixes. Only words of plain ASCII letters are
 * stemmed; numbers, model codes (g500, w463) and other scripts pass through.
 */
export function stem(word: string): string {
  let w = word;
  if (w.length <= 3 || !/^[a-z]+$/.test(w)) return w;
  if (w.endsWith("'s")) w = w.slice(0, -2);
  if (w.endsWith('ies') && w.length > 4) w = `${w.slice(0, -3)}y`;
  else if (w.endsWith('sses')) w = w.slice(0, -2);
  else if (w.endsWith('s') && !w.endsWith('ss') && !w.endsWith('us') && !w.endsWith('is')) w = w.slice(0, -1);

  if (w.endsWith('ability')) w = `${w.slice(0, -7)}able`;
  else if (w.endsWith('ness') && w.length > 6) w = w.slice(0, -4);
  else if (w.endsWith('ingly') && w.length > 7) w = undouble(w.slice(0, -5));
  else if (w.endsWith('edly') && w.length > 6) w = undouble(w.slice(0, -4));
  else if (w.endsWith('ing') && w.length > 5 && VOWEL.test(w.slice(0, -3))) w = undouble(w.slice(0, -3));
  else if (w.endsWith('ed') && !w.endsWith('eed') && w.length > 4 && VOWEL.test(w.slice(0, -2))) w = undouble(w.slice(0, -2));
  else if (w.endsWith('ly') && w.length > 5) w = w.slice(0, -2);

  if (w.endsWith('e') && w.length > 3) w = w.slice(0, -1);
  if (w.endsWith('y') && w.length > 3 && !VOWEL.test(w.at(-2) ?? '')) w = `${w.slice(0, -1)}i`;
  return w;
}

/** Stemmed tokens with stop words removed: what BM25 counts. */
export function terms(text: string): string[] {
  return tokenize(text)
    .filter((t) => !STOP_WORDS.has(t))
    .map(stem);
}

export interface ParsedQuery {
  /** Distinct stemmed terms used for scoring, in query order. */
  terms: string[];
  /** Quoted phrases as stemmed token sequences (stop words kept, so "out of warranty" stays exact). */
  phrases: string[][];
  /** The quoted phrases as the user wrote them. */
  phraseText: string[];
  /** Stem -> the first query word that produced it, for showing which words matched. */
  display: Map<string, string>;
}

/** Split a query into scoring terms and quoted phrases. Straight and curly double quotes both work. */
export function parseQuery(query: string): ParsedQuery {
  const phraseText: string[] = [];
  const phrases: string[][] = [];
  const re = /["“”]([^"“”]+)["“”]/g;
  for (const m of query.matchAll(re)) {
    const raw = (m[1] ?? '').trim();
    const seq = tokenize(raw).map(stem);
    if (seq.length > 1) {
      phrases.push(seq);
      phraseText.push(raw);
    }
  }
  const display = new Map<string, string>();
  const out: string[] = [];
  for (const word of tokenize(query)) {
    if (STOP_WORDS.has(word)) continue;
    const s = stem(word);
    if (!display.has(s)) {
      display.set(s, word);
      out.push(s);
    }
  }
  return { terms: out, phrases, phraseText, display };
}

/** True when `needle` occurs as a contiguous run inside `hay`. */
export function containsSequence(hay: readonly string[], needle: readonly string[]): boolean {
  if (needle.length === 0 || needle.length > hay.length) return false;
  outer: for (let i = 0; i <= hay.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) if (hay[i + j] !== needle[j]) continue outer;
    return true;
  }
  return false;
}

/** Levenshtein distance with an early exit once it exceeds `max`. */
export function editDistance(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      const v = Math.min((prev[j] ?? 0) + 1, (cur[j - 1] ?? 0) + 1, (prev[j - 1] ?? 0) + (a[i - 1] === b[j - 1] ? 0 : 1));
      cur.push(v);
      if (v < rowMin) rowMin = v;
    }
    if (rowMin > max) return max + 1;
    prev = cur;
  }
  return prev[b.length] ?? max + 1;
}

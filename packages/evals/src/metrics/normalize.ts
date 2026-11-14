/**
 * Text normalization applied before every word and character error rate.
 * Scoring raw strings would count "Hello," against "hello" as an error, which
 * measures formatting, not recognition. The rules, in order:
 *
 *   1. Unicode NFKC, lowercase, curly apostrophes made straight.
 *   2. Drop bracketed and parenthesized tags ([Music], [Applause], (laughs))
 *      and music notes. Speaker markers at a line start (">> ", "- ") go too.
 *   3. English only: expand contractions ("don't" to "do not", "gonna" to
 *      "going to") so either spelling scores the same.
 *   4. Numbers: strip thousands separators ("1,000" to "1000"); in English,
 *      "%" becomes "percent" and integers 0 to 9999 are spelled out
 *      ("21" to "twenty one"), so "21" and "twenty-one" agree. Other
 *      languages keep their digits.
 *   5. Every character that is not a letter, digit or combining mark (in any
 *      script) becomes a space; whitespace collapses.
 *   6. English fillers (um, uh, er, erm, ah, hmm, mm, mhm) are removed unless
 *      `fillers: true`: creator captions usually omit them, speech-to-text
 *      often keeps them, and neither choice is a recognition error.
 */

export interface NormalizeOptions {
  /** BCP-47 language of the text. Contractions, number spelling and fillers apply to English only. Default 'en'. */
  language?: string;
  /** Keep filler words. Default false. */
  fillers?: boolean;
}

const WHOLE_WORDS: Record<string, string> = {
  "won't": 'will not',
  "can't": 'can not',
  cannot: 'can not',
  "shan't": 'shall not',
  "ain't": 'is not',
  "let's": 'let us',
  "y'all": 'you all',
  gonna: 'going to',
  wanna: 'want to',
  gotta: 'got to',
};

const SUFFIXES: [RegExp, string][] = [
  [/n't\b/g, ' not'],
  [/'re\b/g, ' are'],
  [/'ve\b/g, ' have'],
  [/'ll\b/g, ' will'],
  [/'d\b/g, ' would'],
  [/'m\b/g, ' am'],
];

const FILLERS = new Set(['um', 'umm', 'uh', 'uhh', 'er', 'erm', 'ah', 'hmm', 'mm', 'mhm']);

const ONES = [
  'zero',
  'one',
  'two',
  'three',
  'four',
  'five',
  'six',
  'seven',
  'eight',
  'nine',
  'ten',
  'eleven',
  'twelve',
  'thirteen',
  'fourteen',
  'fifteen',
  'sixteen',
  'seventeen',
  'eighteen',
  'nineteen',
];
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];

/** Spell an integer 0 to 9999 in English words without hyphens ("twenty one"). Anything else comes back as digits. */
export function spellNumber(n: number): string {
  if (!Number.isInteger(n) || n < 0 || n > 9999) return String(n);
  if (n < 20) return ONES[n] as string;
  if (n < 100) {
    const tens = TENS[Math.floor(n / 10)] as string;
    return n % 10 === 0 ? tens : `${tens} ${ONES[n % 10]}`;
  }
  if (n < 1000) {
    const rest = n % 100;
    return `${ONES[Math.floor(n / 100)]} hundred${rest ? ` ${spellNumber(rest)}` : ''}`;
  }
  const rest = n % 1000;
  return `${spellNumber(Math.floor(n / 1000))} thousand${rest ? ` ${spellNumber(rest)}` : ''}`;
}

/** True when a BCP-47 tag is English (en, en-US, en-GB, ...). Missing means English. */
export function isEnglish(language: string | undefined): boolean {
  return (language ?? 'en').toLowerCase().split(/[-_]/)[0] === 'en';
}

/** Normalize transcript text for scoring. Pure and deterministic. */
export function normalizeText(text: string, opts: NormalizeOptions = {}): string {
  const english = isEnglish(opts.language);
  let s = text.normalize('NFKC').toLowerCase();
  s = s.replace(/[‘’ʼ`]/g, "'");
  s = s.replace(/\[[^\]]*\]/g, ' ').replace(/\([^)]*\)/g, ' ').replace(/[♪♫♬]/g, ' ');
  s = s.replace(/(^|\n)\s*(>>|-)\s*/g, '$1');
  s = s.replace(/(\d),(?=\d{3}\b)/g, '$1');
  if (english) {
    s = s.replace(/[a-z']+/g, (w) => WHOLE_WORDS[w] ?? w);
    for (const [re, rep] of SUFFIXES) s = s.replace(re, rep);
    s = s.replace(/(\d)\s?%/g, '$1 percent');
    s = s.replace(/\d+/g, (d) => ` ${spellNumber(Number(d))} `);
  } else {
    s = s.replace(/(\d)[.  ](?=\d{3}\b)/g, '$1');
  }
  s = s.replace(/[^\p{L}\p{N}\p{M}]+/gu, ' ').trim();
  if (!s) return '';
  const words = s.split(' ');
  return (english && !opts.fillers ? words.filter((w) => !FILLERS.has(w)) : words).join(' ');
}

/** Normalized words of a text. */
export function normalizeWords(text: string, opts: NormalizeOptions = {}): string[] {
  const n = normalizeText(text, opts);
  return n ? n.split(' ') : [];
}

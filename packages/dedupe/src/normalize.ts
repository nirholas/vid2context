/**
 * Transcript normalization for duplicate detection.
 *
 * Two uploads of the same speech rarely have identical captions: one has
 * creator captions with punctuation and digits, another has auto-captions
 * from a different year of YouTube's speech recognizer ("um", "trunks" heard
 * as "fronts", "twenty five" against "25"). Matching runs on a normalized
 * vocabulary so formatting and disfluencies never count as differences:
 *
 *   lowercase, drop [Music] style annotations, numbers as digits, punctuation
 *   removed, a few spoken variants folded together, fillers removed.
 *
 * Content words that the recognizer heard differently stay different; the
 * gap tolerance in align.ts absorbs those.
 */

/** Words dropped before shingling: disfluencies that recognizers insert or omit at will. */
export const FILLERS: ReadonlySet<string> = new Set([
  'um',
  'umm',
  'uh',
  'uhh',
  'uhm',
  'er',
  'erm',
  'ah',
  'ahh',
  'eh',
  'hmm',
  'hm',
  'mm',
  'mmm',
  'mhm',
  'oh',
  'ooh',
  'huh',
]);

/** Spoken variants folded to one form. Values may be several words. */
const CANONICAL: Record<string, string[]> = {
  gonna: ['going', 'to'],
  wanna: ['want', 'to'],
  gotta: ['got', 'to'],
  alright: ['all', 'right'],
  okay: ['ok'],
  cause: ['because'],
  cuz: ['because'],
  til: ['until'],
  till: ['until'],
};

const UNITS: Record<string, number> = {
  zero: 0,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
};
const TEENS: Record<string, number> = {
  ten: 10,
  eleven: 11,
  twelve: 12,
  thirteen: 13,
  fourteen: 14,
  fifteen: 15,
  sixteen: 16,
  seventeen: 17,
  eighteen: 18,
  nineteen: 19,
};
const TENS: Record<string, number> = {
  twenty: 20,
  thirty: 30,
  forty: 40,
  fifty: 50,
  sixty: 60,
  seventy: 70,
  eighty: 80,
  ninety: 90,
};
const SCALES: Record<string, number> = { thousand: 1_000, million: 1_000_000, billion: 1_000_000_000 };

type NumKind = 'unit' | 'teen' | 'tens' | 'hundred' | 'scale';

function numKind(w: string): NumKind | undefined {
  if (w in UNITS) return 'unit';
  if (w in TEENS) return 'teen';
  if (w in TENS) return 'tens';
  if (w === 'hundred') return 'hundred';
  if (w in SCALES) return 'scale';
  return undefined;
}

/** Which number word may follow which inside one number ("twenty five", "one hundred and five", "two thousand twelve"). */
function continues(prev: NumKind, next: NumKind): boolean {
  switch (next) {
    case 'unit':
      return prev === 'tens' || prev === 'hundred' || prev === 'scale';
    case 'teen':
    case 'tens':
      return prev === 'hundred' || prev === 'scale';
    case 'hundred':
      return prev === 'unit' || prev === 'teen' || prev === 'tens';
    case 'scale':
      return true;
  }
}

/**
 * Replace runs of English number words with digits: "twenty five" -> "25",
 * "one hundred and five" -> "105", "two thousand twelve" -> "2012".
 * Separate numbers stay separate: "one two three" -> "1 2 3".
 */
export function numberWordsToDigits(words: string[]): string[] {
  const out: string[] = [];
  let total = 0;
  let current = 0;
  let prev: NumKind | undefined;
  const flush = () => {
    if (prev !== undefined) out.push(String(total + current));
    total = 0;
    current = 0;
    prev = undefined;
  };
  for (let i = 0; i < words.length; i++) {
    const w = words[i] as string;
    const kind = numKind(w);
    if (!kind) {
      // "one hundred and five": keep going across "and" when a number word follows.
      const nextKind = i + 1 < words.length ? numKind(words[i + 1] as string) : undefined;
      if (w === 'and' && (prev === 'hundred' || prev === 'scale') && nextKind && nextKind !== 'hundred' && nextKind !== 'scale') {
        continue;
      }
      flush();
      out.push(w);
      continue;
    }
    if (prev !== undefined && !continues(prev, kind)) flush();
    if (kind === 'unit') current += UNITS[w] as number;
    else if (kind === 'teen') current += TEENS[w] as number;
    else if (kind === 'tens') current += TENS[w] as number;
    else if (kind === 'hundred') current = (current || 1) * 100;
    else {
      total += (current || 1) * (SCALES[w] as number);
      current = 0;
    }
    prev = kind;
  }
  flush();
  return out;
}

/**
 * Normalize caption text into comparable words. Pure; the same input always
 * gives the same output.
 */
export function normalizeWords(text: string): string[] {
  const cleaned = text
    .toLowerCase()
    .replace(/[‘’ʼ`]/g, "'")
    // Annotations: [Music], [Applause], (laughs), and the >> speaker-change marker.
    .replace(/\[[^\]]*\]|\([^)]*\)|>>|♪|♫/g, ' ')
    // Numbers as digits: 1,000 -> 1000, $5 -> 5 dollars, 10% -> 10 percent, 1.5 -> 1 5.
    .replace(/(\d),(?=\d{3}\b)/g, '$1')
    .replace(/\$\s?(\d+)/g, '$1 dollars ')
    .replace(/%/g, ' percent ')
    .replace(/&/g, ' and ')
    // Apostrophes vanish inside words (that's -> thats); everything else that is not a letter or digit splits.
    .replace(/'/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ');
  const words: string[] = [];
  for (const w of cleaned.split(' ')) {
    if (!w) continue;
    const canon = CANONICAL[w];
    if (canon) words.push(...canon);
    else words.push(w);
  }
  return numberWordsToDigits(words).filter((w) => !FILLERS.has(w));
}

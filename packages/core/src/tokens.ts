/**
 * Token estimates for budgeting: context packs, chunking, fitting text into a
 * model's window. A fast heuristic, not a tokenizer. Use it for budgets with
 * headroom, never for billing.
 *
 * Created from docs/prompts/SHARED-CONTRACTS.md. Prompt 03 (chunking) owns
 * its accuracy and may improve the implementation, but must keep this
 * signature.
 *
 * How it works: modern BPE tokenizers (OpenAI o200k, Llama 3) first split
 * text into letter runs, digit groups of up to three, and punctuation, then
 * spend a roughly predictable number of tokens on each piece depending on its
 * script. This walks the text once, splits it the same way and adds a
 * per-piece cost measured against those tokenizers on real transcripts. The
 * rates sit between o200k and Llama 3. Measured error per script is in
 * docs/chunking.md; the report is packages/core/test/chunk/token-accuracy.json.
 */

/** Tokens per character for scripts without spaces between words (or with short syllable blocks). */
const HAN = 0.95;
const KANA = 0.8;
const HANGUL = 0.73;
/** Tokens per letter for alphabetic scripts other than Latin. */
const CYRILLIC = 0.37;
const ARABIC = 0.38;
const INDIC = 0.53;
const OTHER = 0.5;

type Kind = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12;
const SPACE: Kind = 0;
const NEWLINE: Kind = 1;
const DIGIT: Kind = 2;
const PUNCT: Kind = 3;
const ASCII: Kind = 4;
const LATIN_EXT: Kind = 5;
const CYR: Kind = 6;
const ARAB: Kind = 7;
const IND: Kind = 8;
const OTHER_LETTER: Kind = 9;
/** Han, kana and Hangul are costed per character, at a rate looked up per char. */
const CJK: Kind = 10;
/** Combining marks continue the current letter run. */
const MARK: Kind = 11;
/** Run kind shared by letters of every alphabetic script; the word's script is tracked separately. */
const LETTER: Kind = 12;

function isLetterKind(k: Kind): boolean {
  return k === ASCII || k === LATIN_EXT || k === CYR || k === ARAB || k === IND || k === OTHER_LETTER;
}

const LETTER_RE = /\p{L}/u;
const MARK_RE = /\p{M}/u;
const DIGIT_RE = /\p{N}/u;

function cjkRate(cp: number): number {
  if ((cp >= 0x3040 && cp <= 0x30ff) || (cp >= 0x31f0 && cp <= 0x31ff) || (cp >= 0xff66 && cp <= 0xff9f)) return KANA;
  if ((cp >= 0xac00 && cp <= 0xd7af) || (cp >= 0x1100 && cp <= 0x11ff) || (cp >= 0x3130 && cp <= 0x318f)) return HANGUL;
  if (
    (cp >= 0x3400 && cp <= 0x4dbf) ||
    (cp >= 0x4e00 && cp <= 0x9fff) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0x20000 && cp <= 0x3134f)
  )
    return HAN;
  return 0;
}

function kindOf(cp: number, ch: string): Kind {
  if (cp === 0x0a || cp === 0x0d) return NEWLINE;
  if (cp === 0x20 || cp === 0x09 || cp === 0xa0 || cp === 0x3000) return SPACE;
  if (cp < 0x80) {
    if ((cp >= 0x41 && cp <= 0x5a) || (cp >= 0x61 && cp <= 0x7a)) return ASCII;
    if (cp >= 0x30 && cp <= 0x39) return DIGIT;
    if (cp < 0x20) return SPACE;
    return PUNCT;
  }
  if (cjkRate(cp) > 0) return CJK;
  if (LETTER_RE.test(ch)) {
    if (cp <= 0x024f || (cp >= 0x1e00 && cp <= 0x1eff)) return LATIN_EXT;
    if (cp >= 0x0400 && cp <= 0x052f) return CYR;
    if ((cp >= 0x0600 && cp <= 0x06ff) || (cp >= 0x0750 && cp <= 0x077f) || (cp >= 0xfb50 && cp <= 0xfeff)) return ARAB;
    if (cp >= 0x0900 && cp <= 0x0dff) return IND;
    return OTHER_LETTER;
  }
  if (MARK_RE.test(ch)) return MARK;
  if (DIGIT_RE.test(ch)) return DIGIT;
  if (/\s/u.test(ch)) return SPACE;
  return PUNCT;
}

/** Cost of one alphabetic word of `letters` letters, `parts` pieces split by apostrophes. */
function wordCost(kind: Kind, letters: number, parts: number): number {
  switch (kind) {
    case ASCII:
      // Common English words are one token up to about 6 letters, then grow slowly.
      return 1 + Math.max(0, letters - 6) * 0.1 + (parts - 1) * 0.5;
    case LATIN_EXT:
      // Words with diacritics (French, Spanish, Portuguese, ...) split more often.
      return 1.4 + Math.max(0, letters - 5) * 0.12 + (parts - 1) * 0.5;
    case CYR:
      return Math.max(1, letters * CYRILLIC);
    case ARAB:
      return Math.max(1, letters * ARABIC);
    case IND:
      return Math.max(1, letters * INDIC);
    default:
      return Math.max(1, letters * OTHER);
  }
}

export function estimateTokens(text: string): number {
  if (!text) return 0;
  let total = 0;
  /** Kind of the run being built (letters of every alphabetic script share LETTER), or -1 before the first char. */
  let run = -1 as Kind | -1;
  let runLen = 0;
  /** Whether the char before the current run was whitespace (or the run starts the text). */
  let runAfterSpace = true;
  /** For letter runs: the script of the word and its apostrophe-separated parts. */
  let wordKind: Kind = ASCII;
  let parts = 1;
  /** An apostrophe right after a letter, not yet known to be inside a contraction. */
  let apostrophe = false;
  let last = -1 as Kind | -1;

  const flush = (): void => {
    if (runLen > 0) {
      if (run === LETTER) total += wordCost(wordKind, runLen, parts);
      else if (run === DIGIT) total += Math.ceil(runLen / 3) + (runAfterSpace ? 1 : 0);
      else if (run === PUNCT) total += 1 + (runLen - 1) * 0.5;
      else if (run === NEWLINE) total += 1;
      else if (run === SPACE && runLen > 1) total += 1;
    }
    if (apostrophe) total += 1;
    apostrophe = false;
    runLen = 0;
    parts = 1;
  };
  const start = (k: Kind): void => {
    flush();
    runAfterSpace = last === -1 || last === SPACE || last === NEWLINE;
    run = k;
  };

  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0;
    let k = kindOf(cp, ch);
    if (k === CJK) {
      // Costed per character; ends any other run.
      if (run !== CJK) start(CJK);
      total += cjkRate(cp);
      last = CJK;
      continue;
    }
    if (k === MARK) k = run === LETTER ? LETTER : PUNCT;
    if (k === LETTER || isLetterKind(k)) {
      if (run === LETTER) {
        if (apostrophe) {
          parts++;
          apostrophe = false;
        }
        if (wordKind === ASCII && k !== ASCII && k !== LETTER) wordKind = k;
      } else {
        start(LETTER);
        wordKind = k === LETTER ? ASCII : k;
      }
      runLen++;
      last = LETTER;
      continue;
    }
    // An apostrophe between letters joins a contraction ("don't", "l'eau").
    if ((cp === 0x27 || cp === 0x2019) && run === LETTER && !apostrophe) {
      apostrophe = true;
      last = PUNCT;
      continue;
    }
    if (k !== run || apostrophe) start(k);
    runLen++;
    last = k;
  }
  flush();
  return Math.max(1, Math.ceil(total));
}

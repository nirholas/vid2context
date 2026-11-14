/**
 * Punctuation and capitalization F1 of a hypothesis (raw auto-captions or the
 * cleanup output) against creator captions.
 *
 * Both texts are split into words. Each word gets two labels: the
 * punctuation mark that ends it (one of `.` `,` `?` `!`, or none; `;` and
 * `:` count as `,`, and `...` as `.`) and whether its first letter is upper
 * case. The words are aligned on their lowercase letters and digits, and the
 * labels of exactly matched words are compared:
 *
 *   punctuation  TP: same mark; FP: hypothesis has a mark the reference does
 *                not (or a different one); FN: reference has a mark the
 *                hypothesis lacks (or a different one)
 *   capital      TP: both upper; FP: only hypothesis upper; FN: only reference upper
 *
 * The first word of a text is skipped for capitalization (sentence starts
 * are trivially upper case in most cleanups and would inflate the score).
 */
import { align } from './align.ts';
import { prf } from './stats.ts';

export interface LabelScore {
  tp: number;
  fp: number;
  fn: number;
  precision: number;
  recall: number;
  f1: number;
}

export interface PunctuationScore {
  /** Words matched exactly and compared. */
  matched: number;
  punctuation: LabelScore;
  capitalization: LabelScore;
}

interface Token {
  key: string;
  mark: string;
  upper: boolean;
}

function markOf(trailing: string): string {
  if (/[?？]/.test(trailing)) return '?';
  if (/[!！]/.test(trailing)) return '!';
  if (/[.。…]/.test(trailing)) return '.';
  if (/[,，;；:：、]/.test(trailing)) return ',';
  return '';
}

/** Split text into tokens with their punctuation and capitalization labels. Bracketed and parenthesized tags are dropped. */
export function punctuationTokens(text: string): Token[] {
  const clean = text
    .normalize('NFKC')
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/\([^)]*\)/g, ' ')
    .replace(/[♪♫♬]/g, ' ')
    .replace(/(^|\n)\s*>>\s*/g, '$1');
  const out: Token[] = [];
  for (const raw of clean.split(/\s+/)) {
    const key = raw.toLowerCase().replace(/[^\p{L}\p{N}\p{M}']/gu, '');
    if (!key) {
      // A stray mark separated by a space belongs to the previous word.
      const last = out[out.length - 1];
      if (last && !last.mark) last.mark = markOf(raw);
      continue;
    }
    const firstLetter = raw.match(/\p{L}/u)?.[0] ?? '';
    const trailing = raw.match(/[^\p{L}\p{N}\p{M}']+$/u)?.[0] ?? '';
    out.push({ key, mark: markOf(trailing), upper: firstLetter !== '' && firstLetter !== firstLetter.toLowerCase() });
  }
  return out;
}

function score(tp: number, fp: number, fn: number): LabelScore {
  return { tp, fp, fn, ...prf(tp, fp, fn) };
}

export function punctuationF1(reference: string, hypothesis: string): PunctuationScore {
  const r = punctuationTokens(reference);
  const h = punctuationTokens(hypothesis);
  const a = align(
    r.map((t) => t.key),
    h.map((t) => t.key),
  );
  let matched = 0;
  const p = { tp: 0, fp: 0, fn: 0 };
  const c = { tp: 0, fp: 0, fn: 0 };
  for (const step of a.steps) {
    if (step.op !== 'match') continue;
    matched++;
    const rt = r[step.ref as number] as Token;
    const ht = h[step.hyp as number] as Token;
    if (rt.mark && rt.mark === ht.mark) p.tp++;
    else {
      if (ht.mark) p.fp++;
      if (rt.mark) p.fn++;
    }
    if (step.ref === 0 || step.hyp === 0) continue;
    if (rt.upper && ht.upper) c.tp++;
    else if (ht.upper) c.fp++;
    else if (rt.upper) c.fn++;
  }
  return { matched, punctuation: score(p.tp, p.fp, p.fn), capitalization: score(c.tp, c.fp, c.fn) };
}

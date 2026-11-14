/**
 * Word and character error rates.
 *
 *   WER = (substitutions + deletions + insertions) / reference words
 *   CER = the same over characters of the normalized text with spaces removed
 *
 * CER drops spaces so it means the same thing for languages written without
 * them (Japanese, Chinese, Thai). Both can exceed 1 when the hypothesis has
 * many insertions (a looping speech-to-text rung, for example).
 */
import { type EditCounts, editCounts } from './align.ts';
import { type NormalizeOptions, normalizeText } from './normalize.ts';

export interface ErrorRate extends EditCounts {
  /** Errors over reference length (see `rate`). */
  rate: number;
  errors: number;
}

/** Errors over reference length. An empty reference scores 0 against an empty hypothesis and 1 otherwise. */
export function rate(c: EditCounts): number {
  const errors = c.substitutions + c.deletions + c.insertions;
  if (c.refLength === 0) return c.hypLength === 0 ? 0 : 1;
  return errors / c.refLength;
}

function withRate(c: EditCounts): ErrorRate {
  return { ...c, errors: c.substitutions + c.deletions + c.insertions, rate: rate(c) };
}

/** WER on normalized words. */
export function wordErrorRate(reference: string, hypothesis: string, opts: NormalizeOptions = {}): ErrorRate {
  const r = normalizeText(reference, opts);
  const h = normalizeText(hypothesis, opts);
  return withRate(editCounts(r ? r.split(' ') : [], h ? h.split(' ') : []));
}

/** CER on normalized text with spaces removed. */
export function characterErrorRate(reference: string, hypothesis: string, opts: NormalizeOptions = {}): ErrorRate {
  const r = [...normalizeText(reference, opts).replace(/ /g, '')];
  const h = [...normalizeText(hypothesis, opts).replace(/ /g, '')];
  return withRate(editCounts(r, h));
}

/** Pool several items into one corpus-level rate: total errors over total reference length. */
export function pooledRate(items: readonly EditCounts[]): ErrorRate {
  const sum: EditCounts = { matches: 0, substitutions: 0, deletions: 0, insertions: 0, refLength: 0, hypLength: 0 };
  for (const c of items) {
    sum.matches += c.matches;
    sum.substitutions += c.substitutions;
    sum.deletions += c.deletions;
    sum.insertions += c.insertions;
    sum.refLength += c.refLength;
    sum.hypLength += c.hypLength;
  }
  return withRate(sum);
}

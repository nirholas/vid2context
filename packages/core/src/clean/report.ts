/**
 * The audit trail every cleanup step returns. Counts say how much changed;
 * a bounded list of examples lets a human check what changed and why.
 */
import type { Attempt } from '../types.ts';

/** Rule ids used in report examples. Stable: surfaces may filter on them. */
export type CleanRule =
  | 'normalize'
  | 'tag-removed'
  | 'rolling-duplicate'
  | 'repetition-loop'
  | 'dominant-token'
  | 'hallucination-tail'
  | 'sentence'
  | 'filler'
  | 'llm-punctuation'
  | 'llm-rejected';

export interface CleanExample {
  atSec: number;
  before: string;
  after: string;
  rule: CleanRule;
}

export interface CleanLlmStats {
  chunks: number;
  /** Chunks whose punctuated text passed word-sequence verification and were applied. */
  accepted: number;
  /** Chunks whose returned words differed from the input: the original text was kept. */
  rejected: number;
  /** Chunks whose request failed after the rung chain gave up: the original text was kept. */
  failed: number;
  /** Rung ids that produced accepted chunks. */
  rungs: string[];
  attempts: Attempt[];
}

export interface CleanReport {
  /** Steps that ran, in order. */
  steps: string[];
  /** Segments folded into a neighbour (a rolling duplicate that left nothing new). */
  merged: number;
  /** Segments dropped because nothing was left (only tags, only loop repeats). */
  removed: number;
  /** Segments whose confidence was lowered without deleting their text. */
  flagged: number;
  /** Segments whose text changed. */
  rewritten: number;
  /** At most MAX_CLEAN_EXAMPLES, in the order they happened. */
  examples: CleanExample[];
  llm?: CleanLlmStats;
}

export const MAX_CLEAN_EXAMPLES = 20;

export function emptyCleanReport(step?: string): CleanReport {
  return { steps: step ? [step] : [], merged: 0, removed: 0, flagged: 0, rewritten: 0, examples: [] };
}

export function addCleanExample(report: CleanReport, example: CleanExample): void {
  if (report.examples.length < MAX_CLEAN_EXAMPLES) report.examples.push(example);
}

/** Combine reports from steps that ran one after another. */
export function mergeCleanReports(...reports: CleanReport[]): CleanReport {
  const out = emptyCleanReport();
  for (const r of reports) {
    out.steps.push(...r.steps);
    out.merged += r.merged;
    out.removed += r.removed;
    out.flagged += r.flagged;
    out.rewritten += r.rewritten;
    for (const e of r.examples) addCleanExample(out, e);
    if (r.llm) out.llm = r.llm;
  }
  return out;
}

/** Lowercase a word and drop everything but letters, digits and apostrophes, for comparing words. */
export function cleanWordKey(word: string): string {
  return word
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/[^\p{L}\p{N}']/gu, '');
}

/** Split text on whitespace. */
export function cleanSplitWords(text: string): string[] {
  return text.split(/\s+/).filter(Boolean);
}

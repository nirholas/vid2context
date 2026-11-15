/**
 * Regression thresholds (packages/evals/thresholds.json). `--check` compares
 * each summary row with the limits for its suite and rung and exits nonzero
 * on any breach, so a local CI step can opt in.
 *
 * Shape: { "<suite>": { "<rung or producer id>": { "maxWer": 0.2, ... } } }
 * A rung with no entry is not checked. Rows with no successful items are
 * not checked either (a missing key or an outage is not a regression).
 */
import { readFileSync } from 'node:fs';
import { Vid2ContextError } from '@vid2context/core';
import type { RungSummary, SuiteName } from './results.ts';

export interface Limits {
  maxWer?: number;
  maxCer?: number;
  maxP90LatencyMs?: number;
  maxTimingMedianSec?: number;
  minPunctuationF1?: number;
  /** Chapters: lowest allowed pooled boundary F1. */
  minBoundaryF1?: number;
}

export type Thresholds = Partial<Record<SuiteName, Record<string, Limits>>>;

export interface Violation {
  suite: SuiteName;
  rung: string;
  metric: keyof Limits;
  limit: number;
  actual: number;
}

export const THRESHOLDS_FILE = new URL('../thresholds.json', import.meta.url);

export function loadThresholds(file: string | URL = THRESHOLDS_FILE): Thresholds {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as Thresholds;
  } catch (err) {
    throw new Vid2ContextError('bad-request', `Cannot read thresholds: ${(err as Error).message}`, {
      hint: 'Fix packages/evals/thresholds.json (see docs/evals.md, "Regression checks").',
    });
  }
}

export function checkThresholds(suite: SuiteName, rows: readonly RungSummary[], thresholds: Thresholds): Violation[] {
  const limits = thresholds[suite] ?? {};
  const out: Violation[] = [];
  for (const row of rows) {
    const l = limits[row.rung];
    if (!l || row.ok === 0) continue;
    const over = (metric: keyof Limits, limit: number | undefined, actual: number | undefined) => {
      if (limit !== undefined && actual !== undefined && actual > limit)
        out.push({ suite, rung: row.rung, metric, limit, actual });
    };
    over('maxWer', l.maxWer, row.wer);
    over('maxCer', l.maxCer, row.cer);
    over('maxP90LatencyMs', l.maxP90LatencyMs, row.p90LatencyMs);
    over('maxTimingMedianSec', l.maxTimingMedianSec, row.timingMedianSec);
    if (l.minBoundaryF1 !== undefined && row.boundaryF1 !== undefined && row.boundaryF1 < l.minBoundaryF1) {
      out.push({ suite, rung: row.rung, metric: 'minBoundaryF1', limit: l.minBoundaryF1, actual: row.boundaryF1 });
    }
    if (l.minPunctuationF1 !== undefined && row.punctuationF1 !== undefined && row.punctuationF1 < l.minPunctuationF1) {
      out.push({ suite, rung: row.rung, metric: 'minPunctuationF1', limit: l.minPunctuationF1, actual: row.punctuationF1 });
    }
  }
  return out;
}

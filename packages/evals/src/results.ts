/**
 * The JSON written to packages/evals/results/<YYYY-MM-DD>-<suite>.json, and
 * the per-rung summary computed from it. Raw per-item scores are kept so a
 * later reader can recompute any aggregate.
 */
import type { Attempt, Tier } from '@vid2context/core';
import type { EditCounts } from './metrics/align.ts';
import type { PunctuationScore } from './metrics/punctuation.ts';
import { percentile } from './metrics/stats.ts';
import type { TimingError } from './metrics/timing.ts';
import { pooledRate } from './metrics/wer.ts';

export type SuiteName = 'stt' | 'captions' | 'cleanup' | 'citations' | 'search';

export interface ItemResult {
  /** Dataset item id. */
  item: string;
  videoId: string;
  language: string;
  /** Rung id, or a fixed producer name such as 'youtube-auto-captions'. */
  rung: string;
  tier?: Tier;
  outcome: 'ok' | 'error' | 'skipped';
  reason?: string;
  detail?: string;
  wer?: EditCounts & { rate: number };
  cer?: EditCounts & { rate: number };
  timing?: TimingError;
  punctuation?: PunctuationScore;
  /** Sum of `ms` over successful speech-to-text attempts. */
  latencyMs?: number;
  /** Wall-clock time of the whole call, including splitting and rate-limit waits. */
  wallMs?: number;
  audioSec?: number;
  /** USD; 0 for free, keyless and local rungs, null when a paid rung has no listed price. */
  costUsd?: number | null;
  attempts?: Attempt[];
}

export interface SkippedRung {
  rung: string;
  reason: string;
  /** Env vars that would enable it. */
  envVars?: string[];
}

export interface Environment {
  node: string;
  platform: string;
  policy: string;
  keyless: boolean;
  /** Rung ids evaluated. */
  rungs: string[];
  /** Number of env files loaded (paths and values are never recorded). */
  envFiles: number;
}

export interface EvalResult {
  suite: SuiteName;
  /** YYYY-MM-DD (UTC) the run started. */
  date: string;
  startedAt: string;
  finishedAt: string;
  dataset: { file: string; items: number; evaluated: number };
  environment: Environment;
  skippedRungs: SkippedRung[];
  /** Things the suite could not do and why (a missing package, no audio source). */
  notes: string[];
  items: ItemResult[];
}

export interface RungSummary {
  rung: string;
  tier?: Tier;
  items: number;
  ok: number;
  /** Pooled over items: total errors over total reference words. */
  wer?: number;
  cer?: number;
  substitutions?: number;
  deletions?: number;
  insertions?: number;
  refWords?: number;
  /** Median over items of each item's median word start difference. */
  timingMedianSec?: number;
  punctuationF1?: number;
  capitalizationF1?: number;
  p50LatencyMs?: number;
  p90LatencyMs?: number;
  /** Speech-to-text latency over audio length, pooled. */
  realTimeFactor?: number;
  /** Total USD, null when any item was unpriced. */
  costUsd?: number | null;
}

/** One summary row per rung, in first-seen order. */
export function summarize(items: readonly ItemResult[]): RungSummary[] {
  const byRung = new Map<string, ItemResult[]>();
  for (const it of items) byRung.set(it.rung, [...(byRung.get(it.rung) ?? []), it]);
  return [...byRung.entries()].map(([rung, list]) => {
    const ok = list.filter((i) => i.outcome === 'ok');
    const row: RungSummary = { rung, tier: list[0]?.tier, items: list.length, ok: ok.length };
    const wers = ok.map((i) => i.wer).filter((w): w is NonNullable<typeof w> => Boolean(w));
    if (wers.length > 0) {
      const pooled = pooledRate(wers);
      row.wer = pooled.rate;
      row.substitutions = pooled.substitutions;
      row.deletions = pooled.deletions;
      row.insertions = pooled.insertions;
      row.refWords = pooled.refLength;
    }
    const cers = ok.map((i) => i.cer).filter((c): c is NonNullable<typeof c> => Boolean(c));
    if (cers.length > 0) row.cer = pooledRate(cers).rate;
    const timings = ok.map((i) => i.timing?.medianSec).filter((t): t is number => t !== undefined);
    if (timings.length > 0) row.timingMedianSec = percentile(timings, 50);
    const punct = ok.map((i) => i.punctuation).filter((p): p is PunctuationScore => Boolean(p));
    if (punct.length > 0) {
      const sum = (f: (p: PunctuationScore) => { tp: number; fp: number; fn: number }) => {
        const t = punct.reduce((a, p) => ({ tp: a.tp + f(p).tp, fp: a.fp + f(p).fp, fn: a.fn + f(p).fn }), {
          tp: 0,
          fp: 0,
          fn: 0,
        });
        const pr = t.tp + t.fp === 0 ? 0 : t.tp / (t.tp + t.fp);
        const rc = t.tp + t.fn === 0 ? 0 : t.tp / (t.tp + t.fn);
        return pr + rc === 0 ? 0 : (2 * pr * rc) / (pr + rc);
      };
      row.punctuationF1 = sum((p) => p.punctuation);
      row.capitalizationF1 = sum((p) => p.capitalization);
    }
    const lat = ok.map((i) => i.latencyMs).filter((l): l is number => l !== undefined);
    if (lat.length > 0) {
      row.p50LatencyMs = percentile(lat, 50);
      row.p90LatencyMs = percentile(lat, 90);
      const audio = ok.reduce((s, i) => s + (i.latencyMs !== undefined ? (i.audioSec ?? 0) : 0), 0);
      if (audio > 0) row.realTimeFactor = lat.reduce((s, l) => s + l, 0) / 1000 / audio;
    }
    const costs = ok.map((i) => i.costUsd);
    if (costs.some((c) => c !== undefined))
      row.costUsd = costs.some((c) => c === null) ? null : costs.reduce<number>((s, c) => s + (c ?? 0), 0);
    return row;
  });
}

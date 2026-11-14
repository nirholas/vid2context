/** In-memory cumulative metrics: counters and explicit-bucket histograms keyed by name and attribute set. */
import { nowMs } from './ids.ts';
import type { Attrs, AttrValue } from './types.ts';

/** Millisecond buckets wide enough for a cache hit (5 ms) and a long transcription (5 min). */
export const DURATION_BOUNDS_MS = [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10_000, 30_000, 60_000, 120_000, 300_000];

/** Units of the metrics vid2context records. Unknown names have no unit. */
export const METRIC_UNITS: Record<string, string> = {
  'vid2context.rung.attempts': '{attempt}',
  'vid2context.rung.duration': 'ms',
  'vid2context.stage.duration': 'ms',
  'vid2context.llm.tokens': '{token}',
  'vid2context.stt.audio_seconds': 's',
  'vid2context.paid.usd': 'USD',
  'vid2context.events': '{event}',
  'vid2context.telemetry.dropped': '{item}',
};

export interface CounterPoint {
  attrs: Record<string, AttrValue>;
  value: number;
}

export interface HistogramPoint {
  attrs: Record<string, AttrValue>;
  count: number;
  sum: number;
  min: number;
  max: number;
  /** One count per bound plus the overflow bucket. */
  buckets: number[];
}

export function cleanAttrs(attrs: Attrs): Record<string, AttrValue> {
  const out: Record<string, AttrValue> = {};
  for (const [k, v] of Object.entries(attrs)) if (v !== undefined) out[k] = v;
  return out;
}

function keyOf(attrs: Record<string, AttrValue>): string {
  return JSON.stringify(Object.keys(attrs).sort().map((k) => [k, attrs[k]]));
}

export class MetricStore {
  readonly startMs = nowMs();
  readonly counters = new Map<string, Map<string, CounterPoint>>();
  readonly histograms = new Map<string, Map<string, HistogramPoint>>();
  readonly bounds = new Map<string, number[]>();

  counter(name: string, value: number, attrs: Attrs): void {
    if (!Number.isFinite(value)) return;
    const clean = cleanAttrs(attrs);
    const key = keyOf(clean);
    let series = this.counters.get(name);
    if (!series) this.counters.set(name, (series = new Map()));
    const point = series.get(key);
    if (point) point.value += value;
    else series.set(key, { attrs: clean, value });
  }

  histogram(name: string, value: number, attrs: Attrs): void {
    if (!Number.isFinite(value)) return;
    const bounds = this.boundsFor(name);
    const clean = cleanAttrs(attrs);
    const key = keyOf(clean);
    let series = this.histograms.get(name);
    if (!series) this.histograms.set(name, (series = new Map()));
    let point = series.get(key);
    if (!point) {
      point = { attrs: clean, count: 0, sum: 0, min: value, max: value, buckets: new Array(bounds.length + 1).fill(0) };
      series.set(key, point);
    }
    point.count++;
    point.sum += value;
    point.min = Math.min(point.min, value);
    point.max = Math.max(point.max, value);
    let i = bounds.findIndex((b) => value <= b);
    if (i === -1) i = bounds.length;
    point.buckets[i] = (point.buckets[i] ?? 0) + 1;
  }

  boundsFor(name: string): number[] {
    return this.bounds.get(name) ?? DURATION_BOUNDS_MS;
  }

  /** Sum of a counter across series whose attributes include every given pair. */
  total(name: string, match: Attrs = {}): number {
    let sum = 0;
    for (const p of this.counters.get(name)?.values() ?? []) {
      if (Object.entries(match).every(([k, v]) => v === undefined || p.attrs[k] === v)) sum += p.value;
    }
    return sum;
  }
}

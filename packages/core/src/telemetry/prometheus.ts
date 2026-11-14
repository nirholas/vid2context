/**
 * Prometheus text exposition (format 0.0.4) of the metric store, for a
 * `GET /metrics` route. Names: dots become underscores, millisecond
 * histograms get `_milliseconds`, counters get `_total`.
 */
import { METRIC_UNITS, type MetricStore } from './metrics.ts';
import type { AttrValue } from './types.ts';

function metricName(name: string): string {
  const base = name.replace(/[^a-zA-Z0-9_:]/g, '_');
  return /^[a-zA-Z_:]/.test(base) ? base : `_${base}`;
}

function labelName(name: string): string {
  const base = name.replace(/[^a-zA-Z0-9_]/g, '_');
  return /^[a-zA-Z_]/.test(base) ? base : `_${base}`;
}

function escapeLabel(v: AttrValue): string {
  return String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

function labels(attrs: Record<string, AttrValue>, extra?: [string, string]): string {
  const parts = Object.entries(attrs).map(([k, v]) => `${labelName(k)}="${escapeLabel(v)}"`);
  if (extra) parts.push(`${extra[0]}="${extra[1]}"`);
  return parts.length > 0 ? `{${parts.join(',')}}` : '';
}

function num(n: number): string {
  if (n === Number.POSITIVE_INFINITY) return '+Inf';
  if (n === Number.NEGATIVE_INFINITY) return '-Inf';
  return Number.isNaN(n) ? 'NaN' : String(n);
}

/** Render every counter and histogram. Accepts the telemetry returned by createTelemetry, or its metric store. */
export function renderPrometheus(source: { metrics: MetricStore } | MetricStore): string {
  const store = 'counters' in source ? source : source.metrics;
  const lines: string[] = [];
  for (const [name, series] of store.counters) {
    const n = `${metricName(name)}_total`;
    lines.push(`# HELP ${n} ${name}${METRIC_UNITS[name] ? ` (${METRIC_UNITS[name]})` : ''}`, `# TYPE ${n} counter`);
    for (const p of series.values()) lines.push(`${n}${labels(p.attrs)} ${num(p.value)}`);
  }
  for (const [name, series] of store.histograms) {
    const unit = METRIC_UNITS[name];
    const n = `${metricName(name)}${unit === 'ms' ? '_milliseconds' : ''}`;
    const bounds = store.boundsFor(name);
    lines.push(`# HELP ${n} ${name}${unit ? ` (${unit})` : ''}`, `# TYPE ${n} histogram`);
    for (const p of series.values()) {
      let cumulative = 0;
      bounds.forEach((b, i) => {
        cumulative += p.buckets[i] ?? 0;
        lines.push(`${n}_bucket${labels(p.attrs, ['le', num(b)])} ${cumulative}`);
      });
      lines.push(`${n}_bucket${labels(p.attrs, ['le', '+Inf'])} ${p.count}`);
      lines.push(`${n}_sum${labels(p.attrs)} ${num(p.sum)}`);
      lines.push(`${n}_count${labels(p.attrs)} ${p.count}`);
    }
  }
  return lines.length > 0 ? `${lines.join('\n')}\n` : '';
}

/** Content-Type for the exposition. */
export const PROMETHEUS_CONTENT_TYPE = 'text/plain; version=0.0.4; charset=utf-8';

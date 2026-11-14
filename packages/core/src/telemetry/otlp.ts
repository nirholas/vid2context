/**
 * OTLP/HTTP JSON exporter for traces and metrics, sent through the fetch it
 * is given (ctx.fetch). Spans are queued (bounded) and sent in batches on an
 * interval, when a batch fills, and on flush(). Metrics are sent as a
 * cumulative snapshot on every flush. Failures drop the batch and count it in
 * `vid2context.telemetry.dropped`; nothing here ever throws into a request.
 *
 * Encoding: https://opentelemetry.io/docs/specs/otlp/#json-protobuf-encoding
 * (hex trace and span ids, 64-bit integers and nanosecond timestamps as
 * decimal strings, lowerCamelCase field names).
 */
import type { Env, Logger } from '../types.ts';
import { msToNanoString, nowMs } from './ids.ts';
import { METRIC_UNITS, type MetricStore } from './metrics.ts';
import type { AttrValue, SpanData, TelemetryExporter } from './types.ts';

export interface OtlpKeyValue {
  key: string;
  value: { stringValue: string } | { boolValue: boolean } | { intValue: string } | { doubleValue: number };
}

export function encodeValue(v: AttrValue): OtlpKeyValue['value'] {
  if (typeof v === 'string') return { stringValue: v };
  if (typeof v === 'boolean') return { boolValue: v };
  if (Number.isInteger(v)) return { intValue: String(v) };
  return { doubleValue: v };
}

export function encodeAttrs(attrs: Record<string, AttrValue>): OtlpKeyValue[] {
  return Object.entries(attrs).map(([key, v]) => ({ key, value: encodeValue(v) }));
}

/** Parse the OTEL `k=v,k2=v2` list format (values percent-encoded), used by OTEL_EXPORTER_OTLP_HEADERS and OTEL_RESOURCE_ATTRIBUTES. */
export function parseKeyValueList(raw: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (raw ?? '').split(',')) {
    const i = part.indexOf('=');
    if (i <= 0) continue;
    const key = part.slice(0, i).trim();
    let value = part.slice(i + 1).trim();
    try {
      value = decodeURIComponent(value);
    } catch {
      // keep the raw value when it is not valid percent-encoding
    }
    if (key) out[key] = value;
  }
  return out;
}

export interface OtlpConfig {
  tracesUrl?: string;
  metricsUrl?: string;
  headers: Record<string, string>;
  resource: Record<string, AttrValue>;
  maxQueue: number;
  batchSize: number;
}

function signalUrl(base: string | undefined, specific: string | undefined, path: string): string | undefined {
  if (specific?.trim()) return specific.trim();
  if (base?.trim()) return `${base.trim().replace(/\/+$/, '')}${path}`;
  return undefined;
}

function positiveInt(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

/** Read the standard OTEL_* variables. Returns undefined when no endpoint is set or the SDK is disabled. */
export function otlpConfigFromEnv(env: Env, serviceVersion?: string): OtlpConfig | undefined {
  if (env.OTEL_SDK_DISABLED?.toLowerCase() === 'true') return undefined;
  const base = env.OTEL_EXPORTER_OTLP_ENDPOINT;
  const tracesUrl = signalUrl(base, env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT, '/v1/traces');
  const metricsUrl = signalUrl(base, env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT, '/v1/metrics');
  if (!tracesUrl && !metricsUrl) return undefined;
  const resource: Record<string, AttrValue> = { 'service.name': 'vid2context' };
  if (serviceVersion) resource['service.version'] = serviceVersion;
  Object.assign(resource, parseKeyValueList(env.OTEL_RESOURCE_ATTRIBUTES));
  if (env.OTEL_SERVICE_NAME?.trim()) resource['service.name'] = env.OTEL_SERVICE_NAME.trim();
  const maxQueue = positiveInt(env.OTEL_BSP_MAX_QUEUE_SIZE, 2048);
  return {
    tracesUrl,
    metricsUrl,
    headers: parseKeyValueList(env.OTEL_EXPORTER_OTLP_HEADERS),
    resource,
    maxQueue,
    batchSize: Math.min(positiveInt(env.OTEL_BSP_MAX_EXPORT_BATCH_SIZE, 512), maxQueue),
  };
}

const SCOPE = { name: 'vid2context' };

export function encodeSpans(spans: SpanData[], resource: Record<string, AttrValue>) {
  return {
    resourceSpans: [
      {
        resource: { attributes: encodeAttrs(resource) },
        scopeSpans: [
          {
            scope: SCOPE,
            spans: spans.map((s) => ({
              traceId: s.traceId,
              spanId: s.spanId,
              ...(s.parentSpanId ? { parentSpanId: s.parentSpanId } : {}),
              name: s.name,
              kind: 1, // SPAN_KIND_INTERNAL
              startTimeUnixNano: msToNanoString(s.startMs),
              endTimeUnixNano: msToNanoString(s.endMs),
              attributes: encodeAttrs(s.attributes),
              events: s.events.map((e) => ({
                timeUnixNano: msToNanoString(e.timeMs),
                name: e.name,
                attributes: encodeAttrs(e.attributes),
              })),
              status: s.status === 'error' ? { code: 2, message: s.statusMessage ?? '' } : {},
            })),
          },
        ],
      },
    ],
  };
}

export function encodeMetrics(store: MetricStore, resource: Record<string, AttrValue>, atMs = nowMs()) {
  const start = msToNanoString(store.startMs);
  const time = msToNanoString(atMs);
  const metrics: unknown[] = [];
  for (const [name, series] of store.counters) {
    metrics.push({
      name,
      unit: METRIC_UNITS[name] ?? '',
      sum: {
        aggregationTemporality: 2, // CUMULATIVE
        isMonotonic: true,
        dataPoints: [...series.values()].map((p) => ({
          attributes: encodeAttrs(p.attrs),
          startTimeUnixNano: start,
          timeUnixNano: time,
          ...(Number.isInteger(p.value) ? { asInt: String(p.value) } : { asDouble: p.value }),
        })),
      },
    });
  }
  for (const [name, series] of store.histograms) {
    const bounds = store.boundsFor(name);
    metrics.push({
      name,
      unit: METRIC_UNITS[name] ?? '',
      histogram: {
        aggregationTemporality: 2,
        dataPoints: [...series.values()].map((p) => ({
          attributes: encodeAttrs(p.attrs),
          startTimeUnixNano: start,
          timeUnixNano: time,
          count: String(p.count),
          sum: p.sum,
          min: p.min,
          max: p.max,
          bucketCounts: p.buckets.map(String),
          explicitBounds: bounds,
        })),
      },
    });
  }
  return { resourceMetrics: [{ resource: { attributes: encodeAttrs(resource) }, scopeMetrics: [{ scope: SCOPE, metrics }] }] };
}

export interface OtlpExporterOptions extends OtlpConfig {
  fetch: typeof fetch;
  log?: Logger;
  onDrop?: (count: number, signal: 'traces' | 'metrics') => void;
  /** Per request timeout. Default 10 s. */
  timeoutMs?: number;
}

export class OtlpExporter implements TelemetryExporter {
  private queue: SpanData[] = [];
  private inflight: Promise<void> | undefined;
  readonly stats = { spansExported: 0, spansDropped: 0, metricExports: 0, failures: 0, lastStatus: 0 };

  constructor(private readonly opts: OtlpExporterOptions) {}

  onSpanEnd(span: SpanData): void {
    if (!this.opts.tracesUrl) return;
    if (this.queue.length >= this.opts.maxQueue) {
      this.drop(1, 'traces');
      return;
    }
    this.queue.push(span);
    if (this.queue.length >= this.opts.batchSize && !this.inflight) {
      this.inflight = this.sendSpans().finally(() => {
        this.inflight = undefined;
      });
    }
  }

  async flush(metrics: MetricStore): Promise<void> {
    if (this.inflight) await this.inflight;
    await this.sendSpans();
    if (this.opts.metricsUrl && (metrics.counters.size > 0 || metrics.histograms.size > 0)) {
      const ok = await this.post(this.opts.metricsUrl, encodeMetrics(metrics, this.opts.resource));
      if (ok) this.stats.metricExports++;
      else this.drop(1, 'metrics');
    }
  }

  private drop(n: number, signal: 'traces' | 'metrics'): void {
    if (signal === 'traces') this.stats.spansDropped += n;
    this.opts.onDrop?.(n, signal);
  }

  private async sendSpans(): Promise<void> {
    const url = this.opts.tracesUrl;
    while (url && this.queue.length > 0) {
      const batch = this.queue.splice(0, this.opts.batchSize);
      const ok = await this.post(url, encodeSpans(batch, this.opts.resource));
      if (ok) this.stats.spansExported += batch.length;
      else this.drop(batch.length, 'traces');
    }
  }

  private async post(url: string, payload: unknown): Promise<boolean> {
    try {
      const res = await this.opts.fetch(url, {
        method: 'POST',
        headers: { ...this.opts.headers, 'content-type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(this.opts.timeoutMs ?? 10_000),
      });
      this.stats.lastStatus = res.status;
      await res.body?.cancel().catch(() => undefined);
      if (res.ok) return true;
      this.stats.failures++;
      this.opts.log?.debug('OTLP export rejected', { status: res.status });
      return false;
    } catch (err) {
      this.stats.failures++;
      this.opts.log?.debug('OTLP export failed', { error: err instanceof Error ? err.name : 'error' });
      return false;
    }
  }
}

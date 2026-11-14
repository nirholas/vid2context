import type { MetricStore } from './metrics.ts';
import type { SpanData, TelemetryExporter } from './types.ts';

/**
 * Keeps finished spans in an array. A real exporter, used by tests and by
 * surfaces that show a request's trace (a debug panel, `--verbose`).
 */
export class InMemoryExporter implements TelemetryExporter {
  readonly spans: SpanData[] = [];
  /** The metric store seen at the last flush. */
  metrics?: MetricStore;

  constructor(private readonly maxSpans = 10_000) {}

  onSpanEnd(span: SpanData): void {
    this.spans.push(span);
    if (this.spans.length > this.maxSpans) this.spans.shift();
  }

  async flush(metrics: MetricStore): Promise<void> {
    this.metrics = metrics;
  }

  /** Direct children of a span. */
  children(parent: SpanData): SpanData[] {
    return this.spans.filter((s) => s.parentSpanId === parent.spanId && s.traceId === parent.traceId);
  }

  byName(name: string): SpanData[] {
    return this.spans.filter((s) => s.name === name);
  }

  clear(): void {
    this.spans.length = 0;
  }
}

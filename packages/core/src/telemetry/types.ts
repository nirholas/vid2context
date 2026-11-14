/**
 * Telemetry contract. `ctx.telemetry` is optional: instrumentation in the
 * chain and the pipeline checks for it and does nothing at all when it is
 * absent. Attribute values are plain strings, numbers or booleans; never put
 * transcript text, prompts, URLs with query strings or env values in them.
 */
import type { UsageLedger } from './ledger.ts';

export type AttrValue = string | number | boolean;
/** Undefined values are dropped, so callers can pass optional fields directly. */
export type Attrs = Record<string, AttrValue | undefined>;

/** W3C trace context ids: 32 and 16 lowercase hex characters. */
export interface SpanContext {
  traceId: string;
  spanId: string;
}

export interface Span {
  readonly context: SpanContext;
  setAttributes(attrs: Attrs): void;
  /** Marks the span failed. Records the error type and code only, never its message (messages can carry URLs or text). */
  recordError(err: unknown): void;
  /** Idempotent. `Telemetry.span` ends the span for you. */
  end(): void;
}

export interface SpanEvent {
  name: string;
  timeMs: number;
  attributes: Record<string, AttrValue>;
}

/** A finished span, as exporters receive it. Times are epoch milliseconds with sub-millisecond precision. */
export interface SpanData {
  name: string;
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  startMs: number;
  endMs: number;
  attributes: Record<string, AttrValue>;
  events: SpanEvent[];
  status: 'unset' | 'error';
  /** Error code or type when status is error. */
  statusMessage?: string;
}

export interface Telemetry {
  /** Run `fn` inside a span that is a child of the innermost open span of this telemetry scope. */
  span<T>(name: string, attrs: Attrs, fn: (span: Span) => Promise<T>): Promise<T>;
  counter(name: string, value: number, attrs: Attrs): void;
  histogram(name: string, value: number, attrs: Attrs): void;
  /** Adds an event to the innermost open span; with no open span, counts it in `vid2context.events`. */
  event(name: string, attrs: Attrs): void;
  /** Export everything buffered. Never throws. */
  flush(): Promise<void>;
  /** Present when usage and cost are tracked; enables the daily paid guard. */
  readonly ledger?: UsageLedger;
  /** The innermost open span, used to stamp `trace_id` and `span_id` on JSON log lines. */
  active?(): SpanContext | undefined;
}

/** Receives finished spans and, on flush, the metric store. */
export interface TelemetryExporter {
  onSpanEnd?(span: SpanData): void;
  flush?(metrics: import('./metrics.ts').MetricStore): Promise<void>;
  shutdown?(): Promise<void>;
}

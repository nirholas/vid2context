/**
 * The Telemetry implementation and its factory.
 *
 * Parenting: there is no portable async-local storage (Workers and browsers
 * lack Node's AsyncLocalStorage), so a telemetry scope keeps its own list of
 * open spans and a new span's parent is the innermost one. That is exact for
 * sequential code, which is how the pipeline and the chain run. Give each
 * concurrent unit of work (an HTTP request, a batch item) its own
 * `scope()`, which shares metrics, exporters and the ledger.
 */
import type { Env, Logger } from '../types.ts';
import { newSpanId, newTraceId, nowMs } from './ids.ts';
import { UsageLedger } from './ledger.ts';
import { cleanAttrs, MetricStore } from './metrics.ts';
import { OtlpExporter, otlpConfigFromEnv } from './otlp.ts';
import type { Attrs, AttrValue, Span, SpanContext, SpanData, SpanEvent, Telemetry, TelemetryExporter } from './types.ts';

const MAX_STRING = 256;

/** Defence in depth: cap string length and strip query strings and fragments from URL-shaped values. */
function safeValue(v: AttrValue): AttrValue {
  if (typeof v !== 'string') return v;
  let s = v;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = s.replace(/[?#].*$/s, '');
  return s.length > MAX_STRING ? s.slice(0, MAX_STRING) : s;
}

function safeAttrs(attrs: Attrs): Record<string, AttrValue> {
  const out = cleanAttrs(attrs);
  for (const k of Object.keys(out)) out[k] = safeValue(out[k] as AttrValue);
  return out;
}

/** A short, non-sensitive label for an error: its code when it has one, else its type. */
export function errorLabel(err: unknown): string {
  const code = (err as { code?: unknown } | null)?.code;
  if (typeof code === 'string' && /^[a-z0-9-]{1,40}$/i.test(code)) return code;
  if (err instanceof Error) return err.name || 'Error';
  return typeof err;
}

interface Shared {
  metrics: MetricStore;
  exporters: TelemetryExporter[];
  ledger?: UsageLedger;
  log?: Logger;
}

class SpanImpl implements Span {
  readonly context: SpanContext;
  private readonly data: SpanData;
  private ended = false;

  constructor(
    private readonly owner: CoreTelemetry,
    name: string,
    attrs: Attrs,
    parent: SpanContext | undefined,
  ) {
    this.context = { traceId: parent?.traceId ?? newTraceId(), spanId: newSpanId() };
    this.data = {
      name,
      traceId: this.context.traceId,
      spanId: this.context.spanId,
      startMs: nowMs(),
      endMs: 0,
      attributes: safeAttrs(attrs),
      events: [],
      status: 'unset',
    };
    if (parent) this.data.parentSpanId = parent.spanId;
  }

  setAttributes(attrs: Attrs): void {
    if (!this.ended) Object.assign(this.data.attributes, safeAttrs(attrs));
  }

  addEvent(event: SpanEvent): void {
    if (!this.ended) this.data.events.push(event);
  }

  recordError(err: unknown): void {
    if (this.ended) return;
    const label = errorLabel(err);
    this.data.status = 'error';
    this.data.statusMessage = label;
    const type = err instanceof Error ? err.name || 'Error' : typeof err;
    this.data.events.push({ name: 'exception', timeMs: nowMs(), attributes: { 'exception.type': type, 'error.type': label } });
  }

  end(): void {
    if (this.ended) return;
    this.ended = true;
    this.data.endMs = nowMs();
    this.owner.finish(this, this.data);
  }
}

export class CoreTelemetry implements Telemetry {
  private readonly open: SpanImpl[] = [];

  constructor(
    private readonly shared: Shared,
    private readonly remoteParent?: SpanContext,
  ) {}

  get ledger(): UsageLedger | undefined {
    return this.shared.ledger;
  }

  get metrics(): MetricStore {
    return this.shared.metrics;
  }

  get exporters(): readonly TelemetryExporter[] {
    return this.shared.exporters;
  }

  /** A new scope sharing metrics, exporters and the ledger, optionally continuing an incoming trace. */
  scope(parent?: SpanContext): CoreTelemetry {
    return new CoreTelemetry(this.shared, parent);
  }

  active(): SpanContext | undefined {
    return this.open[this.open.length - 1]?.context ?? this.remoteParent;
  }

  startSpan(name: string, attrs: Attrs = {}): Span {
    const span = new SpanImpl(this, name, attrs, this.active());
    this.open.push(span);
    return span;
  }

  async span<T>(name: string, attrs: Attrs, fn: (span: Span) => Promise<T>): Promise<T> {
    const span = this.startSpan(name, attrs);
    try {
      return await fn(span);
    } catch (err) {
      span.recordError(err);
      throw err;
    } finally {
      span.end();
    }
  }

  /** Called by a span when it ends. */
  finish(span: SpanImpl, data: SpanData): void {
    const i = this.open.lastIndexOf(span);
    if (i !== -1) this.open.splice(i, 1);
    for (const e of this.shared.exporters) {
      try {
        e.onSpanEnd?.(data);
      } catch (err) {
        this.shared.log?.debug('telemetry exporter failed on span end', { error: errorLabel(err) });
      }
    }
  }

  counter(name: string, value: number, attrs: Attrs): void {
    this.shared.metrics.counter(name, value, safeAttrs(attrs));
  }

  histogram(name: string, value: number, attrs: Attrs): void {
    this.shared.metrics.histogram(name, value, safeAttrs(attrs));
  }

  event(name: string, attrs: Attrs): void {
    const span = this.open[this.open.length - 1];
    if (span) span.addEvent({ name, timeMs: nowMs(), attributes: safeAttrs(attrs) });
    else this.shared.metrics.counter('vid2context.events', 1, { event: name });
  }

  async flush(): Promise<void> {
    await Promise.all(
      this.shared.exporters.map(async (e) => {
        try {
          await e.flush?.(this.shared.metrics);
        } catch (err) {
          this.shared.log?.debug('telemetry flush failed', { error: errorLabel(err) });
        }
      }),
    );
  }
}

export interface CreateTelemetryOptions {
  /** Extra exporters, e.g. an InMemoryExporter in tests or a surface's own sink. */
  exporters?: TelemetryExporter[];
  /** Track usage and cost (default true). Pass a ledger to share one. */
  ledger?: boolean | UsageLedger;
  /** Reported as the `service.version` resource attribute. */
  serviceVersion?: string;
  /** Background flush interval in ms. Default OTEL_BSP_SCHEDULE_DELAY or 5000; 0 turns the timer off (call flush yourself, e.g. in Workers' waitUntil). */
  flushIntervalMs?: number;
  /** Continue an incoming trace (see parseTraceparent). */
  parent?: SpanContext;
}

export interface TelemetryHandle extends CoreTelemetry {
  /** Stop the background timer and flush once more. */
  shutdown(): Promise<void>;
}

/**
 * Build a Telemetry from env: the usage ledger, an OTLP/HTTP exporter when an
 * OTEL_EXPORTER_OTLP_*ENDPOINT is set (and OTEL_SDK_DISABLED is not true), and
 * any exporters passed in. Requests go through `ctxLike.fetch`.
 */
export function createTelemetry(
  ctxLike: { env: Env; fetch: typeof fetch; log?: Logger },
  opts: CreateTelemetryOptions = {},
): TelemetryHandle {
  const { env } = ctxLike;
  const metrics = new MetricStore();
  const exporters: TelemetryExporter[] = [...(opts.exporters ?? [])];
  const otlpConfig = otlpConfigFromEnv(env, opts.serviceVersion);
  let otlp: OtlpExporter | undefined;
  if (otlpConfig) {
    otlp = new OtlpExporter({
      ...otlpConfig,
      fetch: ctxLike.fetch,
      log: ctxLike.log,
      onDrop: (n, signal) => metrics.counter('vid2context.telemetry.dropped', n, { signal }),
    });
    exporters.push(otlp);
  }
  const ledger = opts.ledger instanceof UsageLedger ? opts.ledger : opts.ledger === false ? undefined : new UsageLedger({ env });
  const shared: Shared = { metrics, exporters, ledger, log: ctxLike.log };
  const tel = new CoreTelemetry(shared, opts.parent) as TelemetryHandle;

  let timer: ReturnType<typeof setInterval> | undefined;
  const envDelay = Number(env.OTEL_BSP_SCHEDULE_DELAY);
  const interval = opts.flushIntervalMs ?? (Number.isFinite(envDelay) && envDelay >= 0 ? envDelay : 5000);
  if (otlp && interval > 0) {
    timer = setInterval(() => void tel.flush(), interval);
    (timer as { unref?: () => void }).unref?.();
  }
  tel.shutdown = async () => {
    if (timer !== undefined) clearInterval(timer);
    timer = undefined;
    await tel.flush();
    await Promise.all(exporters.map((e) => e.shutdown?.().catch(() => undefined)));
  };
  return tel;
}

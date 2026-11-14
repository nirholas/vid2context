import { redact } from './security/redact.ts';
import type { SpanContext, Telemetry } from './telemetry/types.ts';
import type { Ctx, Env, Logger, Runtime } from './types.ts';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'silent';
const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40, silent: 99 };

/** `text` (default): `[vid2context] level: msg {data}`. `json`: one JSON object per line (VID2CONTEXT_LOG_FORMAT=json). */
export type LogFormat = 'text' | 'json';

export interface LoggerOptions {
  format?: LogFormat;
  /** The active span, stamped as `trace_id` and `span_id` on JSON lines. */
  trace?: () => SpanContext | undefined;
}

function jsonLine(lvl: string, msg: string, data: Record<string, unknown> | undefined, opts: LoggerOptions): string {
  const rec: Record<string, unknown> = { ts: new Date().toISOString(), level: lvl, msg };
  for (const [k, v] of Object.entries(data ?? {})) {
    if (k in rec) continue;
    rec[k] = v instanceof Error ? { name: v.name, message: v.message } : v;
  }
  const span = opts.trace?.();
  if (span) {
    rec.trace_id = span.traceId;
    rec.span_id = span.spanId;
  }
  try {
    return JSON.stringify(rec);
  } catch {
    return JSON.stringify({ ts: rec.ts, level: lvl, msg, data: '[unserializable]' });
  }
}

/**
 * Logger that writes to stderr. stdout is reserved for program output (and for
 * the MCP stdio transport, where a stray stdout line corrupts the protocol).
 * Messages and data are redacted: key shapes, auth headers, secret query
 * params and the literal values of secret env vars in `env` become [redacted].
 */
export function stderrLogger(level: LogLevel = 'warn', env?: Env, opts: LoggerOptions = {}): Logger {
  const min = LEVELS[level];
  const emit = (lvl: Exclude<LogLevel, 'silent'>, msg: string, data?: Record<string, unknown>) => {
    if (LEVELS[lvl] < min) return;
    if (opts.format === 'json') {
      console.error(jsonLine(lvl, redact(msg, env), data ? redact(data, env) : undefined, opts));
      return;
    }
    const line = redact(data ? `${msg} ${JSON.stringify(redact(data, env))}` : msg, env);
    console.error(`[vid2context] ${lvl}: ${line}`);
  };
  return {
    debug: (m, d) => emit('debug', m, d),
    info: (m, d) => emit('info', m, d),
    warn: (m, d) => emit('warn', m, d),
    error: (m, d) => emit('error', m, d),
  };
}

function loggerOptions(env: Env, telemetry: Telemetry | undefined): LoggerOptions {
  if (env.VID2CONTEXT_LOG_FORMAT !== 'json') return {};
  return { format: 'json', trace: telemetry?.active ? () => telemetry.active?.() : undefined };
}

export function createContext(opts: {
  runtime: Runtime;
  env?: Env;
  fetch?: typeof fetch;
  log?: Logger;
  signal?: AbortSignal;
  bindings?: Record<string, unknown>;
  telemetry?: Telemetry;
}): Ctx {
  const env = opts.env ?? {};
  const level = (env.VID2CONTEXT_LOG_LEVEL as LogLevel | undefined) ?? 'warn';
  return {
    runtime: opts.runtime,
    env,
    fetch: opts.fetch ?? globalThis.fetch.bind(globalThis),
    log: opts.log ?? stderrLogger(level in LEVELS ? level : 'warn', env, loggerOptions(env, opts.telemetry)),
    signal: opts.signal,
    ...(opts.bindings ? { bindings: opts.bindings } : {}),
    ...(opts.telemetry ? { telemetry: opts.telemetry } : {}),
  };
}

/** fetch with a per-call timeout that also honours the context's abort signal. */
export function fetchWithTimeout(ctx: Ctx, url: string, init: RequestInit = {}, timeoutMs = 30_000): Promise<Response> {
  const timeout = AbortSignal.timeout(timeoutMs);
  const signals = [timeout, ctx.signal, init.signal ?? undefined].filter((s): s is AbortSignal => Boolean(s));
  return ctx.fetch(url, { ...init, signal: AbortSignal.any(signals) });
}

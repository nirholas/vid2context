import type { Ctx, Env, Logger, Runtime } from './types.ts';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'silent';
const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40, silent: 99 };

/**
 * Logger that writes to stderr. stdout is reserved for program output (and for
 * the MCP stdio transport, where a stray stdout line corrupts the protocol).
 */
export function stderrLogger(level: LogLevel = 'warn'): Logger {
  const min = LEVELS[level];
  const emit = (lvl: Exclude<LogLevel, 'silent'>, msg: string, data?: Record<string, unknown>) => {
    if (LEVELS[lvl] < min) return;
    const line = data ? `${msg} ${JSON.stringify(data)}` : msg;
    console.error(`[vid2context] ${lvl}: ${line}`);
  };
  return {
    debug: (m, d) => emit('debug', m, d),
    info: (m, d) => emit('info', m, d),
    warn: (m, d) => emit('warn', m, d),
    error: (m, d) => emit('error', m, d),
  };
}

export function createContext(opts: {
  runtime: Runtime;
  env?: Env;
  fetch?: typeof fetch;
  log?: Logger;
  signal?: AbortSignal;
}): Ctx {
  const env = opts.env ?? {};
  const level = (env.VID2CONTEXT_LOG_LEVEL as LogLevel | undefined) ?? 'warn';
  return {
    runtime: opts.runtime,
    env,
    fetch: opts.fetch ?? globalThis.fetch.bind(globalThis),
    log: opts.log ?? stderrLogger(level in LEVELS ? level : 'warn'),
    signal: opts.signal,
  };
}

/** fetch with a per-call timeout that also honours the context's abort signal. */
export function fetchWithTimeout(ctx: Ctx, url: string, init: RequestInit = {}, timeoutMs = 30_000): Promise<Response> {
  const timeout = AbortSignal.timeout(timeoutMs);
  const signals = [timeout, ctx.signal, init.signal ?? undefined].filter((s): s is AbortSignal => Boolean(s));
  return ctx.fetch(url, { ...init, signal: AbortSignal.any(signals) });
}

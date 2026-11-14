/** Ids, clocks and W3C trace context helpers. Runtime-neutral: Web Crypto and `performance` exist on Node, Workers and browsers. */
import type { SpanContext } from './types.ts';

function randomHex(bytes: number): string {
  const buf = new Uint8Array(bytes);
  let hex = '';
  // An all-zero id is invalid in W3C trace context; redraw in that (astronomically rare) case.
  do {
    crypto.getRandomValues(buf);
    hex = Array.from(buf, (b) => b.toString(16).padStart(2, '0')).join('');
  } while (/^0+$/.test(hex));
  return hex;
}

export const newTraceId = (): string => randomHex(16);
export const newSpanId = (): string => randomHex(8);

/** Epoch milliseconds with sub-millisecond precision where the runtime offers it. */
export function nowMs(): number {
  const p = globalThis.performance;
  return p && typeof p.timeOrigin === 'number' ? p.timeOrigin + p.now() : Date.now();
}

/** Epoch milliseconds to the OTLP JSON encoding: nanoseconds as a decimal string. */
export function msToNanoString(ms: number): string {
  const whole = Math.floor(ms);
  const frac = Math.round((ms - whole) * 1e6);
  return (BigInt(whole) * 1_000_000n + BigInt(frac)).toString();
}

const TRACEPARENT = /^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})(-.*)?$/;

/** Parse a W3C `traceparent` header. Returns null for anything malformed, version ff, or all-zero ids. */
export function parseTraceparent(header: string | null | undefined): (SpanContext & { sampled: boolean }) | null {
  if (!header) return null;
  const m = TRACEPARENT.exec(header.trim().toLowerCase());
  if (!m) return null;
  const [, version, traceId, spanId, flags, rest] = m as unknown as [string, string, string, string, string, string | undefined];
  if (version === 'ff') return null;
  if (version === '00' && rest) return null;
  if (/^0+$/.test(traceId) || /^0+$/.test(spanId)) return null;
  return { traceId, spanId, sampled: (Number.parseInt(flags, 16) & 1) === 1 };
}

/** Format a W3C `traceparent` header for an outgoing request. */
export function formatTraceparent(ctx: SpanContext, sampled = true): string {
  return `00-${ctx.traceId}-${ctx.spanId}-${sampled ? '01' : '00'}`;
}

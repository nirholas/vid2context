/**
 * The playground's worker: runs a snippet with the real @vid2context/core in scope,
 * away from the page (a worker has no DOM, cookies or page storage). The page uses
 * one long-lived worker for the operations it writes and a fresh one for each run of
 * the reader's own code, so nothing a snippet changes outlives it.
 */
import * as core from '@vid2context/core';
import type { RunError, RunRequest, RunResponse } from './playground-state.ts';

type Fn = (...args: unknown[]) => Promise<unknown>;
const AsyncFunction = Object.getPrototypeOf(async () => undefined).constructor as new (...args: string[]) => Fn;

function replacer(_key: string, v: unknown): unknown {
  if (typeof v === 'bigint') return `${v}n`;
  if (typeof v === 'function') return `[Function ${v.name || 'anonymous'}]`;
  if (v instanceof Uint8Array) return `Uint8Array(${v.length})`;
  if (v instanceof ArrayBuffer) return `ArrayBuffer(${v.byteLength})`;
  if (v instanceof Map) return Object.fromEntries(v);
  if (v instanceof Set) return [...v];
  if (v instanceof Error) return { name: v.name, message: v.message };
  return v;
}

function present(value: unknown): { text: string; kind: 'text' | 'json' | 'empty' } {
  if (typeof value === 'string') return { text: value, kind: 'text' };
  if (value === undefined) return { text: '', kind: 'empty' };
  try {
    return { text: JSON.stringify(value, replacer, 2) ?? String(value), kind: 'json' };
  } catch {
    return { text: String(value), kind: 'text' };
  }
}

function describeError(err: unknown): RunError {
  if (err instanceof Error) {
    const e = err as Error & { code?: unknown; hint?: unknown };
    return {
      name: e.name || 'Error',
      message: e.message,
      ...(typeof e.code === 'string' ? { code: e.code } : {}),
      ...(typeof e.hint === 'string' ? { hint: e.hint } : {}),
    };
  }
  return { name: 'Thrown value', message: present(err).text || String(err) };
}

self.onmessage = async (event: MessageEvent<RunRequest>) => {
  const { id, code, context, secondary, wantValue } = event.data;
  const logs: string[] = [];
  const log = (...args: unknown[]) => {
    logs.push(args.map((a) => (typeof a === 'string' ? a : present(a).text)).join(' '));
  };
  const console = { log, info: log, warn: log, error: log, debug: log };
  const started = performance.now();
  let res: RunResponse;
  try {
    const fn = new AsyncFunction('core', 'context', 'secondary', 'console', code);
    const value = await fn(core, context, secondary, console);
    const shown = present(value);
    res = {
      id,
      ok: true,
      ...shown,
      ...(wantValue ? { value } : {}),
      logs,
      ms: performance.now() - started,
      tokens: core.estimateTokens(shown.text),
    };
  } catch (err) {
    res = { id, ok: false, error: describeError(err), logs, ms: performance.now() - started };
  }
  try {
    self.postMessage(res);
  } catch {
    // The value could not be cloned (wantValue is only set for the page's own plain-data queries).
    self.postMessage({ ...res, value: undefined });
  }
};

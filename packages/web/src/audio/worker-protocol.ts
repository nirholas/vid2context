/**
 * Messages between local.ts and transcribe.worker.ts. Errors cross
 * postMessage as plain data and are turned back into Vid2ContextError (with
 * their attempts) on the page.
 */
import { type Attempt, type ErrorCode, Vid2ContextError } from '@vid2context/core';
import type { LocalAudio, LocalOptions, ModelProgress } from './transcribe-core.ts';

export type WorkerRequest = { type: 'run'; id: number; audio: LocalAudio; opts: LocalOptions };

export type WorkerError = {
  name: string;
  message: string;
  code?: string;
  hint?: string;
  status?: number;
  retryAfterSec?: number;
  attempts: unknown[];
};

export type WorkerResponse =
  | { type: 'model'; id: number; progress: ModelProgress }
  | { type: 'done'; id: number; context: unknown }
  | { type: 'error'; id: number; error: WorkerError };

/** An error as plain data, keeping code, hint and attempts. */
export function serializeError(err: unknown): WorkerError {
  const attempts = (err as { attempts?: unknown[] })?.attempts ?? [];
  if (err instanceof Vid2ContextError) {
    return {
      name: 'Vid2ContextError',
      message: err.message,
      code: err.code,
      ...(err.hint ? { hint: err.hint } : {}),
      ...(err.status ? { status: err.status } : {}),
      ...(err.retryAfterSec ? { retryAfterSec: err.retryAfterSec } : {}),
      attempts,
    };
  }
  const e = err as Error;
  return { name: e?.name ?? 'Error', message: e?.message ?? String(err), attempts };
}

/** The plain-data error back as a Vid2ContextError (or Error) carrying its attempts. */
export function deserializeError(e: WorkerError): Error {
  const err =
    e.name === 'Vid2ContextError' && e.code
      ? new Vid2ContextError(e.code as ErrorCode, e.message, {
          ...(e.hint ? { hint: e.hint } : {}),
          ...(e.status ? { status: e.status } : {}),
          ...(e.retryAfterSec ? { retryAfterSec: e.retryAfterSec } : {}),
        })
      : Object.assign(new Error(e.message), { name: e.name });
  return Object.assign(err, { attempts: e.attempts as Attempt[] });
}

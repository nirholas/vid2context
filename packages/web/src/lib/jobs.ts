/**
 * Jobs (docs/contracts/http-api.md, Jobs): POST /jobs, then the job's
 * text/event-stream. The batch view runs each selected video as a `context`
 * job, which reports stage progress and retries transient failures on the
 * server, then reads the saved VideoContext with GET /context.
 */
import { Vid2ContextError, type VideoContext } from '@vid2context/core';
import { apiBase, type CallOptions, getContext, type RunOptions, unreachable } from './api.ts';
import { type AppError, fromApiBody, isAbort, isApiErrorBody, withAttempts } from './errors.ts';

export interface JobProgress {
  done: number;
  total?: number;
  message?: string;
}

export interface Job {
  id: string;
  kind: string;
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'canceled';
  progress?: JobProgress;
  result?: unknown;
  error?: { code: string; message: string; hint?: string };
  createdAt: string;
  updatedAt: string;
}

export interface SseEvent {
  id?: string;
  event: string;
  data: string;
}

/** Parse a text/event-stream body into events. Comment lines (": heartbeat") are skipped. */
export async function* parseSse(body: ReadableStream<Uint8Array>, signal?: AbortSignal): AsyncGenerator<SseEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const onAbort = () => void reader.cancel().catch(() => undefined);
  signal?.addEventListener('abort', onAbort, { once: true });
  let buf = '';
  let ev: { id?: string; event?: string; data: string[] } = { data: [] };
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl = buf.search(/\r?\n/);
      while (nl >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(buf[nl] === '\r' ? nl + 2 : nl + 1);
        if (line === '') {
          if (ev.data.length || ev.event) yield { id: ev.id, event: ev.event ?? 'message', data: ev.data.join('\n') };
          ev = { data: [] };
        } else if (!line.startsWith(':')) {
          const i = line.indexOf(':');
          const field = i < 0 ? line : line.slice(0, i);
          const v = i < 0 ? '' : line.slice(i + 1).replace(/^ /, '');
          if (field === 'data') ev.data.push(v);
          else if (field === 'event') ev.event = v;
          else if (field === 'id') ev.id = v;
        }
        nl = buf.search(/\r?\n/);
      }
    }
  } finally {
    signal?.removeEventListener('abort', onAbort);
    reader.releaseLock();
  }
}

/** API bases that answered they have no /jobs route; later items there go straight to GET /context. */
const jobsMissing = new Set<string>();

function isNoRoute(err: unknown): boolean {
  return err instanceof Vid2ContextError && err.code === 'not-found' && /^No route for /.test(err.message);
}

export async function postJob(
  kind: string,
  input: unknown,
  options: Record<string, unknown>,
  call: CallOptions = {},
): Promise<Job> {
  const base = call.base ?? apiBase();
  const doFetch = call.fetch ?? globalThis.fetch.bind(globalThis);
  let res: Response;
  try {
    res = await doFetch(`${base}/jobs`, {
      method: 'POST',
      signal: call.signal,
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ kind, input, options }),
    });
  } catch (err) {
    if (isAbort(err)) throw err;
    throw unreachable(base, err);
  }
  const body: unknown = await res.json().catch(() => undefined);
  if (!res.ok) {
    if (isApiErrorBody(body)) throw fromApiBody(body, res.status);
    throw unreachable(base);
  }
  return body as Job;
}

/**
 * No bytes for this long means the connection is dead even though it never
 * closed (a sleeping laptop, a proxy holding the socket). The server sends a
 * heartbeat every 15 s, so this is three missed heartbeats.
 */
export const SSE_IDLE_MS = 45_000;
/** Reconnects in a row without a new event before the job is given up on. */
export const SSE_MAX_RECONNECTS = 5;

export interface FollowOptions {
  /** Default SSE_IDLE_MS. */
  idleMs?: number;
  /** Default SSE_MAX_RECONNECTS. */
  maxReconnects?: number;
  /** Wait before reconnect n (1-based). Default 1 s, doubling, at most 10 s. */
  retryDelayMs?: (n: number) => number;
}

const defaultRetryDelay = (n: number) => Math.min(1000 * 2 ** (n - 1), 10_000);

/** AbortSignal.any where the browser has it, else the same by hand. */
function anySignal(signals: AbortSignal[]): AbortSignal {
  if (typeof AbortSignal.any === 'function') return AbortSignal.any(signals);
  const controller = new AbortController();
  for (const s of signals) {
    if (s.aborted) {
      controller.abort(s.reason);
      break;
    }
    s.addEventListener('abort', () => controller.abort(s.reason), { once: true });
  }
  return controller.signal;
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException('Aborted', 'AbortError');
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortReason(signal));
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    function onAbort() {
      clearTimeout(timer);
      reject(abortReason(signal as AbortSignal));
    }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Follow a job's events until `done` (returns its result) or `error` (throws
 * it, without attempts). A dropped or silent connection is not the job
 * failing: the job keeps running on the server, so this reconnects with
 * `Last-Event-ID` (the server then sends only newer events, no duplicates)
 * and gives up only after `maxReconnects` tries in a row bring no new event.
 */
export async function followJob(
  id: string,
  onProgress: (p: JobProgress) => void,
  call: CallOptions = {},
  opts: FollowOptions = {},
): Promise<unknown> {
  const base = call.base ?? apiBase();
  const doFetch = call.fetch ?? globalThis.fetch.bind(globalThis);
  const idleMs = opts.idleMs ?? SSE_IDLE_MS;
  const maxReconnects = opts.maxReconnects ?? SSE_MAX_RECONNECTS;
  const retryDelay = opts.retryDelayMs ?? defaultRetryDelay;
  const url = `${base}/jobs/${encodeURIComponent(id)}/events`;
  let lastEventId: string | undefined;
  let failures = 0;
  let lastError: unknown;

  for (;;) {
    if (call.signal?.aborted) throw abortReason(call.signal);
    const conn = new AbortController();
    const signal = call.signal ? anySignal([call.signal, conn.signal]) : conn.signal;
    let idle = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const arm = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        idle = true;
        conn.abort();
      }, idleMs);
    };
    const silent = () =>
      withAttempts(
        new Vid2ContextError('timeout', `No word from job ${id} for ${Math.round(idleMs / 1000)} s.`, {
          hint: 'Check the connection and run it again. If a proxy sits in front of the server, it must not buffer text/event-stream responses.',
        }),
      );
    try {
      arm();
      let res: Response | undefined;
      try {
        res = await doFetch(url, {
          signal,
          headers: { accept: 'text/event-stream', ...(lastEventId ? { 'last-event-id': lastEventId } : {}) },
        });
      } catch (err) {
        if (call.signal?.aborted) throw err;
        lastError = idle ? silent() : unreachable(base, err);
      }
      if (res && (!res.ok || !res.body)) {
        const body: unknown = await res.json().catch(() => undefined);
        const err = isApiErrorBody(body) ? fromApiBody(body, res.status) : unreachable(base);
        // The job is gone or the request is wrong: another try gives the same answer.
        if (res.status < 500 && res.status !== 429) throw err;
        lastError = err;
      } else if (res?.body) {
        const watched = res.body.pipeThrough(
          new TransformStream<Uint8Array, Uint8Array>({
            transform(chunk, controller) {
              arm();
              controller.enqueue(chunk);
            },
          }),
        );
        let outcome: { done: true; result: unknown } | { failed: true; error: unknown } | undefined;
        let dropped: unknown;
        try {
          for await (const ev of parseSse(watched, signal)) {
            if (ev.id) lastEventId = ev.id;
            failures = 0;
            const data = ev.data ? JSON.parse(ev.data) : {};
            if (ev.event === 'progress') onProgress(data as JobProgress);
            else if (ev.event === 'done') {
              outcome = { done: true, result: (data as { result?: unknown }).result };
              break;
            } else if (ev.event === 'error') {
              outcome = { failed: true, error: fromApiBody({ error: data, attempts: [] }, 0) };
              break;
            }
          }
        } catch (err) {
          // A broken body (network drop, the idle abort) is a lost connection, not a failed job.
          // Anything else (an unreadable event) is a real bug and surfaces as it is.
          if (call.signal?.aborted || !(isAbort(err) || err instanceof TypeError)) throw err;
          dropped = err;
        }
        if (outcome && 'done' in outcome) return outcome.result;
        if (outcome) throw outcome.error;
        if (call.signal?.aborted) throw abortReason(call.signal);
        lastError = idle
          ? silent()
          : dropped
            ? unreachable(base, dropped)
            : withAttempts(
                new Vid2ContextError('upstream', `The event stream of job ${id} ended before the job finished.`, {
                  hint: 'Run it again. If a proxy sits in front of the server, it must not buffer text/event-stream responses.',
                }),
              );
      }
    } finally {
      clearTimeout(timer);
    }
    failures++;
    if (failures > maxReconnects) throw lastError;
    await sleep(retryDelay(failures), call.signal);
  }
}

export interface ContextRunOptions extends RunOptions {
  comments?: boolean;
}

/**
 * One video through a `context` job, then the full VideoContext from
 * GET /context (saved by the job, so a cache hit). Without /jobs on the
 * server, GET /context alone. When the job fails, GET /context runs once more
 * so the error that is shown carries the attempts.
 */
export async function contextViaJob(
  input: string,
  opts: ContextRunOptions,
  onProgress: (p: JobProgress) => void,
  call: CallOptions = {},
): Promise<VideoContext> {
  const run = { mode: opts.mode, lang: opts.lang };
  const base = call.base ?? apiBase();
  if (jobsMissing.has(base)) return getContext(input, run, call);
  let job: Job;
  try {
    job = await postJob(
      'context',
      input,
      {
        ...(opts.mode ? { mode: opts.mode } : {}),
        ...(opts.lang ? { language: opts.lang } : {}),
        ...(opts.comments ? { comments: true } : {}),
      },
      call,
    );
  } catch (err) {
    if (!isNoRoute(err)) throw err;
    jobsMissing.add(base);
    return getContext(input, run, call);
  }
  try {
    await followJob(job.id, onProgress, call);
  } catch (err) {
    if (isAbort(err)) throw err;
    // The job's error has no attempts; a direct call either succeeds now or fails with them.
    return getContext(input, run, call).catch((direct: AppError) => {
      throw direct.attempts.length ? direct : err;
    });
  }
  return getContext(input, run, call);
}

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

/** Follow a job's events until `done` (returns its result) or `error` (throws it, without attempts). */
export async function followJob(id: string, onProgress: (p: JobProgress) => void, call: CallOptions = {}): Promise<unknown> {
  const base = call.base ?? apiBase();
  const doFetch = call.fetch ?? globalThis.fetch.bind(globalThis);
  let res: Response;
  try {
    res = await doFetch(`${base}/jobs/${encodeURIComponent(id)}/events`, {
      signal: call.signal,
      headers: { accept: 'text/event-stream' },
    });
  } catch (err) {
    if (isAbort(err)) throw err;
    throw unreachable(base, err);
  }
  if (!res.ok || !res.body) {
    const body: unknown = await res.json().catch(() => undefined);
    if (isApiErrorBody(body)) throw fromApiBody(body, res.status);
    throw unreachable(base);
  }
  for await (const ev of parseSse(res.body, call.signal)) {
    const data = ev.data ? JSON.parse(ev.data) : {};
    if (ev.event === 'progress') onProgress(data as JobProgress);
    else if (ev.event === 'done') return (data as { result?: unknown }).result;
    else if (ev.event === 'error') throw fromApiBody({ error: data, attempts: [] }, 0);
  }
  throw withAttempts(
    new Vid2ContextError('upstream', `The event stream of job ${id} ended before the job finished.`, {
      hint: 'Run it again. If a proxy sits in front of the server, it must not buffer text/event-stream responses.',
    }),
  );
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

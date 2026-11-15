/**
 * A job's live progress as Server-Sent Events. The stream first replays the
 * current state (item events so far and the latest progress, or the final
 * event of a finished job), then forwards live events, sends a heartbeat
 * comment every 15 s and closes after `done` or `error`. Every heartbeat also
 * re-reads the job, so a job run by another process still reaches the client.
 *
 * Event ids are the job's monotonic event sequence. A client that reconnects
 * with `Last-Event-ID: n` gets only events after n, so nothing is duplicated.
 */
import { Vid2ContextError } from '@vid2context/core';
import type { JobEventRecord, JobQueue, JobSnapshot } from './types.ts';

export interface SSEOptions {
  /** From the `Last-Event-ID` request header. */
  lastEventId?: number;
  /** Default 15000. */
  heartbeatMs?: number;
  /** Closes the stream (pass the request's signal). */
  signal?: AbortSignal;
}

export const SSE_HEADERS: Record<string, string> = {
  'content-type': 'text/event-stream; charset=utf-8',
  'cache-control': 'no-cache, no-transform',
  connection: 'keep-alive',
  'x-accel-buffering': 'no',
};

const encoder = new TextEncoder();

export function formatEvent(e: Pick<JobEventRecord, 'id' | 'type' | 'data'>): string {
  return `id: ${e.id}\nevent: ${e.type}\ndata: ${JSON.stringify(e.data)}\n\n`;
}

function isTerminal(e: Pick<JobEventRecord, 'type'>): boolean {
  return e.type === 'done' || e.type === 'error';
}

/** Parse a Last-Event-ID header value. Anything that is not a non-negative integer is ignored. */
export function parseLastEventId(raw: string | null | undefined): number | undefined {
  if (!raw || !/^\d{1,15}$/.test(raw.trim())) return undefined;
  return Number(raw.trim());
}

/** The events that bring a client from `after` (or from nothing) up to `snap.seq`. */
export function replayEvents(snap: JobSnapshot, after: number | undefined): Pick<JobEventRecord, 'id' | 'type' | 'data'>[] {
  const { job, seq, events } = snap;
  const oldest = events[0]?.id ?? seq + 1;
  if (after !== undefined && after >= seq) return [];
  if (after !== undefined && oldest <= after + 1) return events.filter((e) => e.id > after);

  // Fresh connection, or the log no longer reaches back to `after`: send the state.
  const out: Pick<JobEventRecord, 'id' | 'type' | 'data'>[] = events.filter((e) => e.type === 'item' && e.id > (after ?? 0));
  const terminal = [...events].reverse().find(isTerminal);
  if (job.status === 'succeeded') out.push(terminal ?? { id: seq, type: 'done', data: { result: job.result ?? null } });
  else if (job.status === 'failed' || job.status === 'canceled') {
    out.push(terminal ?? { id: seq, type: 'error', data: job.error ?? { code: job.status, message: `Job ${job.status}.` } });
  } else out.push({ id: seq, type: 'progress', data: job.progress ?? { done: 0, message: job.status } });
  return out;
}

/** Build the SSE response for one job. Throws `not-found` for unknown ids. */
export async function toSSE(queue: JobQueue, id: string, opts: SSEOptions = {}): Promise<Response> {
  const buffered: JobEventRecord[] = [];
  let push: ((e: JobEventRecord) => void) | null = null;
  // Subscribe before reading the snapshot so no event falls between the two.
  const unsubscribe = queue.subscribe(id, (e) => (push ? push(e) : buffered.push(e)));
  let snap: JobSnapshot | null;
  try {
    snap = await queue.snapshot(id);
  } catch (err) {
    unsubscribe();
    throw err;
  }
  if (!snap) {
    unsubscribe();
    throw new Vid2ContextError('not-found', `No job with id "${id}".`, {
      hint: 'Finished jobs expire after VID2CONTEXT_JOB_TTL_HOURS (default 72). Submit the job again.',
    });
  }
  const initial = snap;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let closed = false;
  let onAbort: (() => void) | undefined;

  const cleanup = () => {
    if (closed) return;
    closed = true;
    unsubscribe();
    if (heartbeat) clearInterval(heartbeat);
    if (onAbort) opts.signal?.removeEventListener('abort', onAbort);
  };

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let last = opts.lastEventId ?? 0;
      const send = (e: Pick<JobEventRecord, 'id' | 'type' | 'data'>) => {
        if (closed) return;
        if (e.id <= last) return;
        controller.enqueue(encoder.encode(formatEvent(e)));
        last = e.id;
        if (isTerminal(e)) {
          cleanup();
          controller.close();
        }
      };
      const close = () => {
        if (closed) return;
        cleanup();
        controller.close();
      };

      for (const e of replayEvents(initial, opts.lastEventId)) {
        // Replay is already filtered; write it as is (a fresh connection's progress may share the last id).
        if (closed) return;
        controller.enqueue(encoder.encode(formatEvent(e)));
        last = Math.max(last, e.id);
        if (isTerminal(e)) return close();
      }
      if (initial.job.status === 'succeeded' || initial.job.status === 'failed' || initial.job.status === 'canceled')
        return close();

      for (const e of buffered.splice(0)) send(e);
      if (closed) return;
      push = send;

      // Each heartbeat also re-reads the job from the store. Live events only reach this
      // process when the job runs here; a job run by another runner (Cloud Tasks, Queues,
      // a second server) or one whose runner died would otherwise leave the stream open
      // forever with nothing but heartbeats. The poll forwards what the store has and
      // closes the stream once the job is finished or gone.
      let polling = false;
      const poll = async () => {
        if (closed || polling) return;
        polling = true;
        try {
          const now = await queue.snapshot(id);
          if (closed) return;
          if (!now) return close();
          for (const e of now.events) if (e.id > last) send(e);
          const finished = now.job.status === 'succeeded' || now.job.status === 'failed' || now.job.status === 'canceled';
          if (finished && !closed) {
            for (const e of replayEvents(now, undefined)) if (isTerminal(e)) send({ ...e, id: Math.max(e.id, last + 1) });
            close();
          }
        } catch {
          // A store hiccup must not end the stream; the next heartbeat tries again.
        } finally {
          polling = false;
        }
      };
      heartbeat = setInterval(() => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(': heartbeat\n\n'));
        } catch {
          // The consumer is gone (the stream errored or was torn down without cancel): stop, do not throw from a timer.
          cleanup();
          return;
        }
        void poll();
      }, opts.heartbeatMs ?? 15_000);
      if (opts.signal) {
        onAbort = close;
        if (opts.signal.aborted) close();
        else opts.signal.addEventListener('abort', onAbort, { once: true });
      }
    },
    cancel() {
      cleanup();
    },
  });

  return new Response(stream, { status: 200, headers: SSE_HEADERS });
}

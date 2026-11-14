/**
 * Running one job, shared by every runner. `runJob` loads the record, calls
 * the kind's handler, persists every state change and event in order, and
 * decides between success, retry, failure and cancellation. Runners only
 * decide when to call it and what to do with a retry.
 */
import type { Ctx, Registry, Storage } from '@vid2context/core';
import type { JobKinds } from './kinds.ts';
import { publicError, retryDelayMs, toJobError } from './retry.ts';
import { isFinished, type JobStore, MAX_EVENTS, publicJob } from './store.ts';
import type { ItemEvent, Job, JobError, JobEvent, JobEventRecord, JobListener, JobProgress, JobRecord } from './types.ts';

/** Abort reason when a user cancels a job. */
export class JobCanceled extends Error {
  constructor() {
    super('Job canceled.');
    this.name = 'JobCanceled';
  }
}

/** Abort reason when the runner stops (close, deploy, crash handling). The job goes back to the queue. */
export class RunnerShutdown extends Error {
  constructor() {
    super('Job runner shutting down.');
    this.name = 'RunnerShutdown';
  }
}

export const CANCELED_ERROR: JobError = {
  code: 'canceled',
  message: 'Job canceled.',
  hint: 'Submit the job again to rerun it.',
};

/** Fan-out of live events inside one process. */
export class EventHub {
  private listeners = new Map<string, Set<JobListener>>();

  subscribe(id: string, listener: JobListener): () => void {
    let set = this.listeners.get(id);
    if (!set) {
      set = new Set();
      this.listeners.set(id, set);
    }
    set.add(listener);
    return () => {
      const s = this.listeners.get(id);
      if (!s) return;
      s.delete(listener);
      if (s.size === 0) this.listeners.delete(id);
    };
  }

  publish(id: string, event: JobEventRecord): void {
    for (const listener of [...(this.listeners.get(id) ?? [])]) {
      try {
        listener(event);
      } catch {
        // A broken listener must not break the job or other listeners.
      }
    }
  }
}

export interface RunDeps {
  store: JobStore;
  kinds: JobKinds;
  registry: Registry;
  storage: Storage;
  /** Base context; each run gets a copy with the job's signal. */
  ctx: Ctx;
  hub?: EventHub;
  random?: () => number;
}

export type RunOutcome =
  | { status: 'succeeded' | 'failed' | 'canceled'; job: Job }
  | { status: 'retry'; delayMs: number; job: Job }
  /** Nothing ran: the job is unknown, already finished, or the runner shut down mid-run (it is queued again). */
  | { status: 'skipped'; job: Job | null };

/**
 * Applies changes to one record in memory, then persists and publishes them
 * strictly in order. After `seal()` it ignores everything, so a handler that
 * keeps running after cancellation cannot overwrite the final state.
 */
export class RecordWriter {
  private chain: Promise<void> = Promise.resolve();
  private dirty = false;
  private sealed = false;
  /** Events waiting for the write that contains them; published only after it lands, so listeners never see state ahead of the store. */
  private unpublished: JobEventRecord[] = [];

  constructor(
    readonly rec: JobRecord,
    private store: JobStore,
    private log: Ctx['log'],
    private hub?: EventHub,
  ) {}

  emit(event: JobEvent): void {
    if (this.sealed) return;
    const rec = this.rec;
    rec.seq += 1;
    const stored = { ...event, id: rec.seq, at: new Date().toISOString() } as JobEventRecord;
    rec.events.push(stored);
    if (rec.events.length > MAX_EVENTS) rec.events.splice(0, rec.events.length - MAX_EVENTS);
    if (event.type === 'progress') rec.progress = event.data;
    rec.updatedAt = stored.at;
    this.unpublished.push(stored);
    this.schedule();
  }

  update(change: Partial<JobRecord>): void {
    if (this.sealed) return;
    Object.assign(this.rec, change, { updatedAt: new Date().toISOString() });
    this.schedule();
  }

  /** Stop accepting changes. Pending writes still complete. */
  seal(): void {
    this.sealed = true;
  }

  flush(): Promise<void> {
    return this.chain;
  }

  private schedule(): void {
    if (this.dirty) return;
    this.dirty = true;
    this.chain = this.chain.then(async () => {
      this.dirty = false;
      const batch = this.unpublished.splice(0);
      try {
        await this.store.put(this.rec);
      } catch (err) {
        this.log.error('jobs: could not persist job state', { id: this.rec.id, message: (err as Error).message });
      }
      for (const e of batch) this.hub?.publish(this.rec.id, e);
    });
  }
}

function validProgress(update: JobProgress): JobProgress {
  const out: JobProgress = { done: Number.isFinite(update.done) ? update.done : 0 };
  if (update.total !== undefined && Number.isFinite(update.total)) out.total = update.total;
  if (update.message) out.message = String(update.message).slice(0, 500);
  return out;
}

/** Resolve with the handler's value, or reject with the signal's reason as soon as it aborts. */
function raceAbort<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    work.then(
      (v) => {
        signal.removeEventListener('abort', onAbort);
        resolve(v);
      },
      (e) => {
        signal.removeEventListener('abort', onAbort);
        reject(e);
      },
    );
  });
}

/** Mark a job that is not running as canceled. Finished jobs are returned unchanged. */
export async function finishCanceled(rec: JobRecord, deps: Pick<RunDeps, 'store' | 'hub' | 'ctx'>): Promise<Job> {
  if (isFinished(rec.status)) return publicJob(rec);
  const w = new RecordWriter(rec, deps.store, deps.ctx.log, deps.hub);
  w.update({ status: 'canceled', error: CANCELED_ERROR, notBefore: undefined });
  w.emit({ type: 'error', data: CANCELED_ERROR });
  w.seal();
  await w.flush();
  return publicJob(rec);
}

/**
 * Run one attempt of a job. `signal` aborts it: with `JobCanceled` the job
 * ends canceled, with `RunnerShutdown` it goes back to `queued` untouched.
 */
export async function runJob(id: string, deps: RunDeps, signal: AbortSignal): Promise<RunOutcome> {
  const rec = await deps.store.get(id);
  if (!rec) return { status: 'skipped', job: null };
  if (isFinished(rec.status)) return { status: 'skipped', job: publicJob(rec) };
  if (await deps.store.cancelRequested(id)) return { status: 'canceled', job: await finishCanceled(rec, deps) };

  const log = deps.ctx.log;
  const writer = new RecordWriter(rec, deps.store, log, deps.hub);
  const kind = deps.kinds.get(rec.kind);
  if (!kind) {
    const error: JobError = {
      code: 'bad-request',
      message: `This runner has no handler for job kind "${rec.kind}".`,
      hint: `Register the kind on every runner. Registered here: ${deps.kinds.names().join(', ') || 'none'}.`,
    };
    writer.update({ status: 'failed', error });
    writer.emit({ type: 'error', data: error });
    writer.seal();
    await writer.flush();
    return { status: 'failed', job: publicJob(rec) };
  }

  const attempt = rec.attempts + 1;
  writer.update({ status: 'running', attempts: attempt, notBefore: undefined, error: undefined });
  const jobSignal = deps.ctx.signal ? AbortSignal.any([deps.ctx.signal, signal]) : signal;
  const ctx: Ctx = { ...deps.ctx, signal: jobSignal };

  try {
    const result = await raceAbort(
      kind.handler({
        job: { id: rec.id, kind: rec.kind, attempt },
        input: rec.input,
        options: rec.options,
        signal: jobSignal,
        progress: (update: JobProgress) => writer.emit({ type: 'progress', data: validProgress(update) }),
        item: (event: ItemEvent) => writer.emit({ type: 'item', data: event }),
        registry: deps.registry,
        storage: deps.storage,
        ctx,
      }),
      signal,
    );
    writer.update({ status: 'succeeded', result: result === undefined ? null : result });
    writer.emit({ type: 'done', data: { result: result === undefined ? null : result } });
    writer.seal();
    await writer.flush();
    return { status: 'succeeded', job: publicJob(rec) };
  } catch (err) {
    if (signal.aborted && signal.reason instanceof RunnerShutdown) {
      writer.update({ status: 'queued' });
      writer.seal();
      await writer.flush();
      return { status: 'skipped', job: publicJob(rec) };
    }
    if (signal.aborted) {
      writer.update({ status: 'canceled', error: CANCELED_ERROR });
      writer.emit({ type: 'error', data: CANCELED_ERROR });
      writer.seal();
      await writer.flush();
      return { status: 'canceled', job: publicJob(rec) };
    }
    const failure = toJobError(err);
    if (failure.code === 'internal') log.error('jobs: handler threw', { id, kind: rec.kind, message: (err as Error)?.message });
    const delay = attempt < kind.maxAttempts ? retryDelayMs(failure, attempt, kind.backoff, deps.random) : null;
    if (delay !== null) {
      const notBefore = new Date(Date.now() + delay).toISOString();
      writer.emit({
        type: 'progress',
        data: {
          ...(rec.progress ?? { done: 0 }),
          message: `Attempt ${attempt} of ${kind.maxAttempts} failed (${failure.code}); retrying in ${Math.ceil(delay / 1000)} s.`,
        },
      });
      writer.update({ status: 'queued', notBefore });
      writer.seal();
      await writer.flush();
      log.warn('jobs: retrying', { id, kind: rec.kind, attempt, code: failure.code, delayMs: delay });
      return { status: 'retry', delayMs: delay, job: publicJob(rec) };
    }
    const error = publicError(failure);
    writer.update({ status: 'failed', error });
    writer.emit({ type: 'error', data: error });
    writer.seal();
    await writer.flush();
    return { status: 'failed', job: publicJob(rec) };
  }
}

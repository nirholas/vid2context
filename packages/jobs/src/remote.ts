/**
 * Jobs that run somewhere else: a serverless queue (Cloudflare Queues, Google
 * Cloud Tasks) delivers a job id to a consumer, which runs it with
 * `runDispatchedJob`. The producer side is `RemoteQueue`: it persists the job
 * in a shared KvStore, hands the id to `dispatch`, and follows progress by
 * polling the store, since the consumer runs in another isolate or instance.
 */
import { type Ctx, type KvStore, MemoryStorage, type Registry, type Storage, Vid2ContextError } from '@vid2context/core';
import { finishCanceled, JobCanceled, type RunDeps, type RunOutcome, runJob } from './execute.ts';
import { JobKinds } from './kinds.ts';
import { assertOptions, jobNotFound, jobSettings } from './queue.ts';
import { isFinished, JobStore, newRecord, publicJob } from './store.ts';
import type { Job, JobEventRecord, JobHandler, JobListener, JobQueue, JobSnapshot, KindOptions, ListJobsQuery } from './types.ts';

/** Hands a job id to the serverless queue. `delayMs` schedules a retry. */
export type Dispatch = (job: Job, delayMs?: number) => Promise<void>;

export interface RemoteQueueOptions {
  /** Shared store both producer and consumer can read (Workers KV, D1, Firestore through a KvStore adapter). */
  kv: KvStore;
  dispatch: Dispatch;
  /** Used for env (TTL) and logging. */
  ctx: Ctx;
  /** Share one kind table between producer and consumer code. */
  kinds?: JobKinds;
  ttlHours?: number;
  /** How often a subscription polls the store. Default 1000 ms. */
  pollMs?: number;
}

export class RemoteQueue implements JobQueue {
  readonly store: JobStore;
  readonly kindTable: JobKinds;
  private pollers = new Set<() => void>();
  private closed = false;

  constructor(private opts: RemoteQueueOptions) {
    this.kindTable = opts.kinds ?? new JobKinds();
    this.store = new JobStore(opts.kv, Math.round((opts.ttlHours ?? jobSettings(opts.ctx.env).ttlHours) * 3600));
  }

  registerKind<I, O>(kind: string, handler: JobHandler<I, O>, opts?: KindOptions): void {
    this.kindTable.register(kind, handler, opts);
  }

  kinds(): string[] {
    return this.kindTable.names();
  }

  async enqueue(kind: string, input: unknown, options?: Record<string, unknown>): Promise<Job> {
    if (this.closed) throw new Vid2ContextError('unavailable', 'The job queue is shut down.', { hint: 'Retry the request.' });
    this.kindTable.require(kind);
    const rec = newRecord(kind, input ?? null, assertOptions(options));
    await this.store.put(rec);
    const job = publicJob(rec);
    try {
      await this.opts.dispatch(job);
    } catch (err) {
      const error = {
        code: 'upstream',
        message: 'Could not hand the job to the queue service.',
        hint: 'Check the queue binding or Cloud Tasks configuration, then submit again.',
      };
      rec.status = 'failed';
      rec.error = error;
      rec.updatedAt = new Date().toISOString();
      rec.seq += 1;
      rec.events.push({ id: rec.seq, at: rec.updatedAt, type: 'error', data: error });
      await this.store.put(rec);
      this.opts.ctx.log.error('jobs: dispatch failed', { id: rec.id, message: (err as Error).message });
      throw new Vid2ContextError('upstream', error.message, { hint: error.hint, cause: err });
    }
    return job;
  }

  async get(id: string): Promise<Job | null> {
    const rec = await this.store.get(id);
    return rec ? publicJob(rec) : null;
  }

  async list(query?: ListJobsQuery): Promise<{ jobs: Job[]; cursor?: string }> {
    const res = await this.store.list(query);
    return { jobs: res.records.map(publicJob), ...(res.cursor ? { cursor: res.cursor } : {}) };
  }

  async snapshot(id: string): Promise<JobSnapshot | null> {
    const rec = await this.store.get(id);
    return rec ? { job: publicJob(rec), seq: rec.seq, events: rec.events } : null;
  }

  async cancel(id: string): Promise<Job> {
    const rec = await this.store.get(id);
    if (!rec) throw jobNotFound(id);
    if (isFinished(rec.status)) return publicJob(rec);
    await this.store.requestCancel(id);
    // A queued job is finished here; the consumer also checks the flag before it starts.
    if (rec.status === 'queued') return finishCanceled(rec, { store: this.store, ctx: this.opts.ctx });
    return publicJob(rec);
  }

  /** Polls the store and emits events newer than the last one seen. Stops after a final event. */
  subscribe(id: string, listener: JobListener): () => void {
    let last = -1;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const stop = () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      this.pollers.delete(stop);
    };
    const tick = async () => {
      try {
        const rec = await this.store.get(id);
        if (rec) {
          if (last < 0) last = rec.seq;
          const fresh: JobEventRecord[] = rec.events.filter((e) => e.id > last);
          for (const e of fresh) {
            last = e.id;
            listener(e);
          }
          if (isFinished(rec.status) && fresh.length === 0 && last >= rec.seq) {
            stop();
            return;
          }
        }
      } catch (err) {
        this.opts.ctx.log.warn('jobs: polling job state failed', { id, message: (err as Error).message });
      }
      if (!stopped) timer = setTimeout(tick, this.opts.pollMs ?? 1000);
    };
    this.pollers.add(stop);
    void tick();
    return stop;
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const stop of [...this.pollers]) stop();
  }
}

export interface ConsumerDeps {
  kv: KvStore;
  kinds: JobKinds;
  registry: Registry;
  /** Where handlers save results. Default: a new MemoryStorage (results then live only in the job record). */
  storage?: Storage;
  ctx: Ctx;
  ttlHours?: number;
  /** How often a running job checks for a cancel request. Default 2000 ms. */
  cancelPollMs?: number;
}

/**
 * Run one dispatched job to the end of this attempt, aborting it if a cancel
 * request appears in the store. Returns the outcome; on `retry` the caller
 * re-dispatches with `delayMs`.
 */
export async function runDispatchedJob(id: string, deps: ConsumerDeps): Promise<RunOutcome> {
  const store = new JobStore(deps.kv, Math.round((deps.ttlHours ?? jobSettings(deps.ctx.env).ttlHours) * 3600));
  const runDeps: RunDeps = { store, kinds: deps.kinds, registry: deps.registry, storage: deps.storage ?? new MemoryStorage(), ctx: deps.ctx };
  const controller = new AbortController();
  const watch = setInterval(async () => {
    try {
      if (!controller.signal.aborted && (await store.cancelRequested(id))) controller.abort(new JobCanceled());
    } catch (err) {
      deps.ctx.log.warn('jobs: cancel check failed', { id, message: (err as Error).message });
    }
  }, deps.cancelPollMs ?? 2000);
  try {
    return await runJob(id, runDeps, controller.signal);
  } finally {
    clearInterval(watch);
  }
}

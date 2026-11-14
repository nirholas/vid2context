/**
 * The in-process runner for Node: a FIFO queue with a concurrency limit,
 * retries with backoff, cancellation, and every state change persisted to a
 * KvStore so a restarted process resumes where the last one stopped.
 */
import {
  type Ctx,
  type Env,
  hasKv,
  type KvStore,
  MemoryKv,
  MemoryStorage,
  type Registry,
  type Storage,
  Vid2ContextError,
} from '@vid2context/core';
import { EventHub, finishCanceled, JobCanceled, type RunDeps, RunnerShutdown, runJob } from './execute.ts';
import { JobKinds } from './kinds.ts';
import { isFinished, JobStore, newRecord, publicJob } from './store.ts';
import type { Job, JobHandler, JobListener, JobQueue, JobSnapshot, KindOptions, ListJobsQuery } from './types.ts';

export interface InProcessQueueOptions {
  registry: Registry;
  /** Base context for background work (env, fetch, log). Jobs outlive requests, so do not pass a request's context. */
  ctx: Ctx;
  /** Where handlers save results. Default: a new MemoryStorage. */
  storage?: Storage | null;
  /** Where jobs are persisted. Default: `storage` when it implements KvStore, else a process-local MemoryKv. */
  kv?: KvStore;
  /** Jobs run at once. Default VID2CONTEXT_JOB_CONCURRENCY or 2. */
  concurrency?: number;
  /** Hours a finished job is kept. Default VID2CONTEXT_JOB_TTL_HOURS or 72. */
  ttlHours?: number;
  /** Start running (and resume persisted jobs) right away. Default true; otherwise call `start()`. */
  autoStart?: boolean;
  /** Random source for retry jitter. */
  random?: () => number;
}

function envNumber(env: Env, name: string, fallback: number, min: number): number {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < min) {
    throw new Vid2ContextError('bad-request', `${name}="${raw}" is not a number of at least ${min}.`, {
      hint: `Set ${name} to a number like ${fallback}, or unset it for the default.`,
    });
  }
  return n;
}

export function jobSettings(env: Env): { concurrency: number; ttlHours: number } {
  return {
    concurrency: Math.floor(envNumber(env, 'VID2CONTEXT_JOB_CONCURRENCY', 2, 1)),
    ttlHours: envNumber(env, 'VID2CONTEXT_JOB_TTL_HOURS', 72, 0.01),
  };
}

export function assertOptions(options: unknown): Record<string, unknown> {
  if (options === undefined || options === null) return {};
  if (typeof options !== 'object' || Array.isArray(options)) {
    throw new Vid2ContextError('bad-request', 'Job options must be a JSON object.', { hint: 'Pass options as {"key": value}.' });
  }
  return options as Record<string, unknown>;
}

interface Running {
  controller: AbortController;
  done: Promise<void>;
}

export class InProcessQueue implements JobQueue {
  readonly store: JobStore;
  readonly storage: Storage;
  readonly concurrency: number;
  private readonly kindTable = new JobKinds();
  private readonly hub = new EventHub();
  private readonly deps: RunDeps;
  private pending: string[] = [];
  private delayed = new Map<string, ReturnType<typeof setTimeout>>();
  private running = new Map<string, Running>();
  private starting: Promise<void> | null = null;
  private closed = false;

  constructor(private opts: InProcessQueueOptions) {
    const settings = jobSettings(opts.ctx.env);
    this.concurrency = Math.max(1, Math.floor(opts.concurrency ?? settings.concurrency));
    this.storage = opts.storage ?? new MemoryStorage();
    const kv = opts.kv ?? (hasKv(this.storage) ? this.storage : new MemoryKv());
    this.store = new JobStore(kv, Math.round((opts.ttlHours ?? settings.ttlHours) * 3600));
    this.deps = {
      store: this.store,
      kinds: this.kindTable,
      registry: opts.registry,
      storage: this.storage,
      ctx: opts.ctx,
      hub: this.hub,
      ...(opts.random ? { random: opts.random } : {}),
    };
    if (opts.autoStart !== false) void this.start();
  }

  registerKind<I, O>(kind: string, handler: JobHandler<I, O>, opts?: KindOptions): void {
    this.kindTable.register(kind, handler, opts);
  }

  kinds(): string[] {
    return this.kindTable.names();
  }

  /** Resume persisted work: jobs left `running` by a crash go back to `queued`, then everything queued runs in creation order. */
  start(): Promise<void> {
    this.starting ??= this.recover().catch((err) => {
      this.opts.ctx.log.error('jobs: could not resume persisted jobs', { message: (err as Error).message });
    });
    return this.starting;
  }

  private async recover(): Promise<void> {
    const records = (await this.store.all())
      .filter((r) => r.status === 'queued' || r.status === 'running')
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    for (const rec of records) {
      if (this.closed) return;
      if (this.running.has(rec.id) || this.pending.includes(rec.id) || this.delayed.has(rec.id)) continue;
      if (rec.status === 'running') {
        rec.status = 'queued';
        rec.updatedAt = new Date().toISOString();
        await this.store.put(rec);
        this.opts.ctx.log.info('jobs: resuming a job interrupted by a restart', { id: rec.id, kind: rec.kind });
      }
      const wait = rec.notBefore ? Date.parse(rec.notBefore) - Date.now() : 0;
      if (wait > 0) this.later(rec.id, wait);
      else this.pending.push(rec.id);
    }
    this.pump();
  }

  async enqueue(kind: string, input: unknown, options?: Record<string, unknown>): Promise<Job> {
    if (this.closed) throw new Vid2ContextError('unavailable', 'The job queue is shut down.', { hint: 'Restart the server.' });
    this.kindTable.require(kind);
    const rec = newRecord(kind, input ?? null, assertOptions(options));
    await this.store.put(rec);
    this.pending.push(rec.id);
    this.pump();
    return publicJob(rec);
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
    const run = this.running.get(id);
    if (run) {
      run.controller.abort(new JobCanceled());
      await run.done;
      const after = await this.store.get(id);
      if (after) return publicJob(after);
    }
    const rec = await this.store.get(id);
    if (!rec) throw notFound(id);
    if (isFinished(rec.status)) return publicJob(rec);
    const queuedHere = this.pending.includes(id) || this.delayed.has(id);
    this.pending = this.pending.filter((p) => p !== id);
    const timer = this.delayed.get(id);
    if (timer) clearTimeout(timer);
    this.delayed.delete(id);
    if (rec.status === 'running' && !queuedHere) {
      // Running in another process that shares this store: ask it to stop.
      await this.store.requestCancel(id);
      return publicJob(rec);
    }
    return finishCanceled(rec, this.deps);
  }

  subscribe(id: string, listener: JobListener): () => void {
    return this.hub.subscribe(id, listener);
  }

  /** Stop taking work. Running jobs are aborted and go back to `queued`, so the next process resumes them. */
  async close(): Promise<void> {
    this.closed = true;
    for (const timer of this.delayed.values()) clearTimeout(timer);
    this.delayed.clear();
    this.pending = [];
    const runs = [...this.running.values()];
    for (const run of runs) run.controller.abort(new RunnerShutdown());
    await Promise.all(runs.map((r) => r.done));
    await this.starting;
  }

  /** Resolves when nothing is running, queued or waiting to retry. */
  async idle(): Promise<void> {
    await this.start();
    while (this.running.size || this.pending.length || this.delayed.size) {
      await new Promise((r) => setTimeout(r, 10));
    }
  }

  private later(id: string, ms: number): void {
    const timer = setTimeout(() => {
      this.delayed.delete(id);
      if (this.closed) return;
      this.pending.push(id);
      this.pump();
    }, ms);
    this.delayed.set(id, timer);
  }

  private pump(): void {
    while (!this.closed && this.running.size < this.concurrency && this.pending.length > 0) {
      const id = this.pending.shift() as string;
      if (this.running.has(id)) continue;
      this.launch(id);
    }
  }

  private launch(id: string): void {
    const controller = new AbortController();
    const done = runJob(id, this.deps, controller.signal)
      .then((outcome) => {
        if (outcome.status === 'retry' && !this.closed) this.later(id, outcome.delayMs);
      })
      .catch((err) => {
        this.opts.ctx.log.error('jobs: runner error', { id, message: (err as Error).message });
      })
      .finally(() => {
        this.running.delete(id);
        this.pump();
      });
    this.running.set(id, { controller, done });
  }
}

function notFound(id: string): Vid2ContextError {
  return new Vid2ContextError('not-found', `No job with id "${id}".`, {
    hint: 'Finished jobs expire after VID2CONTEXT_JOB_TTL_HOURS (default 72). Submit the job again.',
  });
}

export { notFound as jobNotFound };

/** Create an in-process queue. Register kinds right after; persisted jobs of unregistered kinds wait for `start()`. */
export function createJobQueue(opts: InProcessQueueOptions): InProcessQueue {
  return new InProcessQueue(opts);
}

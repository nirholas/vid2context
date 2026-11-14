/**
 * The job model shared by every runner (in-process, Cloudflare Queues,
 * Google Cloud Tasks). `Job` is the public shape from
 * docs/contracts/http-api.md; `JobRecord` is what is persisted.
 */
import type { Ctx, Registry, Storage } from '@vid2context/core';

export type JobStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'canceled';

export const JOB_STATUSES: readonly JobStatus[] = ['queued', 'running', 'succeeded', 'failed', 'canceled'];

export interface JobProgress {
  done: number;
  total?: number;
  message?: string;
}

export interface JobError {
  code: string;
  message: string;
  hint?: string;
}

/** The public job shape (docs/contracts/http-api.md, Jobs). */
export interface Job {
  id: string;
  kind: string;
  status: JobStatus;
  progress?: JobProgress;
  result?: unknown;
  error?: JobError;
  createdAt: string;
  updatedAt: string;
}

/** Outcome of one item of a multi-video job. */
export interface ItemEvent {
  /** Video id (`platform:nativeId`). */
  id: string;
  outcome: 'ok' | 'error' | 'skipped';
  title?: string;
  error?: JobError;
}

/** The four stream events the contract names. */
export type JobEvent =
  | { type: 'progress'; data: JobProgress }
  | { type: 'item'; data: ItemEvent }
  | { type: 'done'; data: { result: unknown } }
  | { type: 'error'; data: JobError };

/** An event as stored and streamed: `id` is monotonic per job, starting at 1. */
export type JobEventRecord = JobEvent & { id: number; at: string };

/** What the store keeps: the public job plus its input, options, attempt count and recent events. */
export interface JobRecord extends Job {
  input: unknown;
  options: Record<string, unknown>;
  /** Handler runs started so far. */
  attempts: number;
  /** ISO 8601: a retry waits until then. */
  notBefore?: string;
  /** Id of the last event written. */
  seq: number;
  /** The most recent events (bounded), so a reconnecting stream can catch up. */
  events: JobEventRecord[];
}

export interface JobHandlerArgs<I = unknown, O = Record<string, unknown>> {
  job: { id: string; kind: string; attempt: number };
  input: I;
  options: O;
  /** Aborted when the job is canceled or the runner shuts down. */
  signal: AbortSignal;
  /** Report progress. Persisted and streamed in order; no need to await. */
  progress(update: JobProgress): void;
  /** Report one item's outcome. */
  item(event: ItemEvent): void;
  registry: Registry;
  storage: Storage;
  /** The runner's context with `signal` set to the job's signal. */
  ctx: Ctx;
}

/** Runs one job. Must be idempotent: a job that was running during a crash runs again from the start. */
export type JobHandler<I = unknown, O = Record<string, unknown>> = (args: JobHandlerArgs<I, O>) => Promise<unknown>;

export interface BackoffOptions {
  /** First retry delay before jitter. Default 2000 ms. */
  baseMs?: number;
  /** Upper bound for the exponential delay. Default 5 minutes. */
  maxMs?: number;
  /** Delay after a `blocked` error (an IP block rarely clears in seconds). Default 15 minutes. */
  blockedMs?: number;
}

export interface KindOptions {
  /** Total handler runs allowed, including the first. Default 3. */
  maxAttempts?: number;
  backoff?: BackoffOptions;
}

export interface ListJobsQuery {
  status?: JobStatus;
  kind?: string;
  /** Default 50, at most 500. */
  limit?: number;
  cursor?: string;
}

export interface JobSnapshot {
  job: Job;
  /** Id of the last event written. */
  seq: number;
  /** Recent events, oldest first. */
  events: JobEventRecord[];
}

export type JobListener = (event: JobEventRecord) => void;

/** The stable queue interface every runner implements. */
export interface JobQueue {
  /** Register a job kind. Registering the same name twice replaces the handler. */
  registerKind<I = unknown, O = Record<string, unknown>>(kind: string, handler: JobHandler<I, O>, opts?: KindOptions): void;
  /** Names of the registered kinds. */
  kinds(): string[];
  /** Queue a job. Unknown kinds fail with `bad-request`. */
  enqueue(kind: string, input: unknown, options?: Record<string, unknown>): Promise<Job>;
  get(id: string): Promise<Job | null>;
  list(query?: ListJobsQuery): Promise<{ jobs: Job[]; cursor?: string }>;
  /** Cancel a job: a queued job is canceled at once, a running one is aborted. Unknown ids fail with `not-found`. */
  cancel(id: string): Promise<Job>;
  /** Live events for one job. Returns the unsubscribe function. */
  subscribe(id: string, listener: JobListener): () => void;
  /** Current state plus recent events, for streams that replay before going live. */
  snapshot(id: string): Promise<JobSnapshot | null>;
  close(): Promise<void>;
}

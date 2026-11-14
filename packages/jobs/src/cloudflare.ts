/**
 * Cloudflare Queues adapter. The Worker that serves the API is the producer
 * (`cloudflareDispatch` sends `{ jobId }`), and the same Worker's `queue()`
 * handler is the consumer (`handleQueueBatch`), which loads each job from the
 * shared KvStore (Workers KV through `workersKv`, or a D1 storage that
 * implements KvStore) and runs it, acking or retrying per message.
 *
 * The Workers types below are the structural subset this file uses, so the
 * package needs neither @cloudflare/workers-types nor Node built-ins.
 */
import type { KvStore } from '@vid2context/core';
import type { Dispatch } from './remote.ts';
import { type ConsumerDeps, runDispatchedJob } from './remote.ts';

export interface JobMessageBody {
  jobId: string;
}

/** The subset of a Workers `Message`. */
export interface QueueMessage<Body = unknown> {
  readonly id: string;
  readonly body: Body;
  readonly attempts: number;
  ack(): void;
  retry(options?: { delaySeconds?: number }): void;
}

/** The subset of a Workers `MessageBatch`. */
export interface MessageBatch<Body = unknown> {
  readonly queue: string;
  readonly messages: readonly QueueMessage<Body>[];
}

/** The subset of a Workers `Queue` producer binding. */
export interface QueueProducer<Body = unknown> {
  send(body: Body, options?: { delaySeconds?: number; contentType?: 'json' | 'text' | 'bytes' | 'v8' }): Promise<void>;
}

/** The subset of a Workers `KVNamespace` binding. */
export interface KvNamespace {
  get(key: string, type: 'json'): Promise<unknown>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
  delete(key: string): Promise<void>;
  list(options?: {
    prefix?: string;
    limit?: number;
    cursor?: string;
  }): Promise<{ keys: { name: string }[]; list_complete: boolean; cursor?: string }>;
}

/** Cloudflare Queues accepts delays up to 12 hours. */
export const MAX_DELAY_SECONDS = 43_200;

function delaySeconds(ms: number): number {
  return Math.min(MAX_DELAY_SECONDS, Math.max(0, Math.ceil(ms / 1000)));
}

/** The message a job becomes on the queue. */
export function jobMessage(jobId: string): JobMessageBody {
  return { jobId };
}

/** Producer: send the job id, delayed for retries. */
export function cloudflareDispatch(queue: QueueProducer<JobMessageBody>): Dispatch {
  return async (job, delayMs) => {
    const delay = delayMs ? delaySeconds(delayMs) : 0;
    await queue.send(jobMessage(job.id), { contentType: 'json', ...(delay ? { delaySeconds: delay } : {}) });
  };
}

/**
 * KvStore over a Workers KV namespace. Workers KV is eventually consistent
 * (reads in other locations can lag up to 60 s) and its minimum TTL is 60 s,
 * so progress seen from another location may trail; D1 is strongly
 * consistent if that matters.
 */
export function workersKv(ns: KvNamespace): KvStore {
  return {
    async kvGet<T = unknown>(key: string): Promise<T | null> {
      return ((await ns.get(key, 'json')) ?? null) as T | null;
    },
    async kvSet(key: string, value: unknown, opts: { ttlSec?: number } = {}): Promise<void> {
      const ttl = opts.ttlSec && opts.ttlSec > 0 ? Math.max(60, Math.ceil(opts.ttlSec)) : undefined;
      await ns.put(key, JSON.stringify(value), ttl ? { expirationTtl: ttl } : undefined);
    },
    async kvDelete(key: string): Promise<void> {
      await ns.delete(key);
    },
    async kvList(prefix: string, opts: { limit?: number; cursor?: string } = {}) {
      const res = await ns.list({
        prefix,
        limit: Math.min(opts.limit ?? 100, 1000),
        ...(opts.cursor ? { cursor: opts.cursor } : {}),
      });
      const keys = res.keys.map((k) => k.name);
      return !res.list_complete && res.cursor ? { keys, cursor: res.cursor } : { keys };
    },
  };
}

function isJobMessage(body: unknown): body is JobMessageBody {
  return typeof body === 'object' && body !== null && typeof (body as JobMessageBody).jobId === 'string';
}

/**
 * Consumer body for the Worker's `queue(batch, env)` handler. `setup` builds
 * the consumer dependencies from the Worker env (KV or D1 store, registry,
 * kinds, a Ctx). Messages run one after another; each is acked when its job
 * reached a final state (or was already final), retried with the job's
 * backoff when the job asked for a retry, and retried with Cloudflare's
 * default delay when the runner itself failed (a store outage).
 */
export async function handleQueueBatch<Env>(
  batch: MessageBatch<unknown>,
  env: Env,
  setup: (env: Env) => ConsumerDeps | Promise<ConsumerDeps>,
): Promise<void> {
  const deps = await setup(env);
  for (const msg of batch.messages) {
    if (!isJobMessage(msg.body)) {
      deps.ctx.log.warn('jobs: dropping a queue message without a jobId', { queue: batch.queue, message: msg.id });
      msg.ack();
      continue;
    }
    try {
      const outcome = await runDispatchedJob(msg.body.jobId, deps);
      if (outcome.status === 'retry') msg.retry({ delaySeconds: delaySeconds(outcome.delayMs) });
      else msg.ack();
    } catch (err) {
      deps.ctx.log.error('jobs: queue consumer failed', { id: msg.body.jobId, message: (err as Error).message });
      msg.retry();
    }
  }
}

/** `handleQueueBatch` bound to a setup function, shaped as the Worker's `queue` export. */
export function queueConsumer<Env>(
  setup: (env: Env) => ConsumerDeps | Promise<ConsumerDeps>,
): (batch: MessageBatch<unknown>, env: Env) => Promise<void> {
  return (batch, env) => handleQueueBatch(batch, env, setup);
}

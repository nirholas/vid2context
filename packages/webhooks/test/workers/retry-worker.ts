/**
 * A Worker for the Miniflare test of durable retries. `fetch` registers
 * hooks and emits events with `queueRetryScheduler`; `queue` is the consumer
 * (`handleWebhookRetryBatch`). Hooks live in Workers KV through the jobs
 * package's `workersKv`. Every attempt and every message the webhook consumer
 * hands back is written to KV under `test:` keys so the test can read them.
 * Deliveries go to a real HTTP receiver the test runs on 127.0.0.1.
 */
import { createContext } from '@vid2context/core';
import { type KvNamespace, type MessageBatch, type QueueProducer, workersKv } from '@vid2context/jobs';
import {
  type AttemptResult,
  emit,
  handleWebhookRetryBatch,
  queueRetryScheduler,
  type WebhookEventType,
  type WebhookRetryMessage,
  WebhookStore,
} from '../../src/index.ts';

interface Env {
  WEBHOOKS: QueueProducer<WebhookRetryMessage | { jobId: string }>;
  WEBHOOKS_KV: KvNamespace;
}

const silent = { debug() {}, info() {}, warn() {}, error() {} };
/** Three attempts, one second apart (Queues delays are whole seconds), no jitter, so the test can wait for them. */
const delivery = { retryDelaysMs: [0, 1000, 1000], jitter: false };

function ctx() {
  return createContext({
    runtime: 'workers',
    env: { VID2CONTEXT_WEBHOOKS_ALLOW_LOCAL: '1' },
    fetch: (input, init) => fetch(input, init),
    log: silent,
  });
}

async function append(env: Env, key: string, value: unknown): Promise<void> {
  const kv = workersKv(env.WEBHOOKS_KV);
  const list = (await kv.kvGet<unknown[]>(key)) ?? [];
  list.push(value);
  await kv.kvSet(key, list);
}

function recorder(env: Env, pending: Promise<void>[]): (r: AttemptResult) => void {
  return (r) => {
    pending.push(append(env, 'test:attempts', r));
  };
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const kv = workersKv(env.WEBHOOKS_KV);
    const store = new WebhookStore(kv);
    if (req.method === 'POST' && url.pathname === '/hooks') {
      const body = (await req.json()) as { url: string; events: string[] };
      return Response.json(await store.create(body, ctx()), { status: 201 });
    }
    if (req.method === 'POST' && url.pathname === '/emit') {
      const event = (await req.json()) as { type: WebhookEventType; data: never };
      const pending: Promise<void>[] = [];
      const result = await emit(event, store, ctx(), {
        ...delivery,
        scheduler: queueRetryScheduler(env.WEBHOOKS),
        onAttempt: recorder(env, pending),
      });
      await Promise.all(pending);
      return Response.json(result);
    }
    if (req.method === 'POST' && url.pathname === '/other') {
      await env.WEBHOOKS.send({ jobId: 'job_not_a_webhook' }, { contentType: 'json' });
      return new Response(null, { status: 202 });
    }
    if (url.pathname === '/state') {
      return Response.json({
        attempts: (await kv.kvGet('test:attempts')) ?? [],
        rest: (await kv.kvGet('test:rest')) ?? [],
        hooks: await store.records(),
      });
    }
    return new Response('not found', { status: 404 });
  },

  async queue(batch: MessageBatch<unknown>, env: Env): Promise<void> {
    const pending: Promise<void>[] = [];
    const rest = await handleWebhookRetryBatch(batch, {
      store: new WebhookStore(workersKv(env.WEBHOOKS_KV)),
      ctx: ctx(),
      queue: env.WEBHOOKS,
      delivery: { ...delivery, onAttempt: recorder(env, pending) },
    });
    await Promise.all(pending);
    // A real Worker would pass these to the jobs consumer; here they are recorded and acked.
    for (const msg of rest) {
      await append(env, 'test:rest', msg.body);
      msg.ack();
    }
  },
};

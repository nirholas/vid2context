/**
 * Durable retries through Cloudflare Queues. The Miniflare suite runs the
 * producer and consumer inside workerd (Miniflare, installed with wrangler)
 * and delivers to a real HTTP receiver on 127.0.0.1; it is skipped when
 * Miniflare or esbuild is not installed.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { VideoContext } from '@vid2context/core';
import { Webhook } from 'standardwebhooks';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { AttemptResult, DeliveryTask } from '../src/deliver.ts';
import { videoIngestedData } from '../src/events.ts';
import { isWebhookRetryMessage, MAX_QUEUE_DELAY_SECONDS, queueRetryScheduler, type WebhookRetryMessage } from '../src/queue.ts';
import type { WebhookRecord } from '../src/store.ts';
import { type Receiver, startReceiver } from './receiver.ts';

const miniflare = await import('miniflare').catch(() => null);
const esbuild = await import('esbuild').catch(() => null);

// Real pipeline output (tests/fixtures/contexts, documented in its README).
const gwagon = JSON.parse(
  readFileSync(join(import.meta.dirname, '../../../tests/fixtures/contexts/youtube-cCPsdFdlshc.json'), 'utf8'),
) as VideoContext;

const task: DeliveryTask = { hookId: 'wh_1', messageId: 'msg_1', type: 'video.ingested', body: '{}', attempt: 1 };

describe('queueRetryScheduler', () => {
  it('sends the task as JSON, delayed in whole seconds and capped at the Queues limit', async () => {
    const sent: { body: WebhookRetryMessage; opts: unknown }[] = [];
    const scheduler = queueRetryScheduler({ send: async (body, opts) => void sent.push({ body, opts }) });
    await scheduler.schedule(task, 0);
    await scheduler.schedule(task, 1500);
    await scheduler.schedule(task, 24 * 3_600_000);
    expect(sent).toEqual([
      { body: { webhookDelivery: task }, opts: { contentType: 'json' } },
      { body: { webhookDelivery: task }, opts: { contentType: 'json', delaySeconds: 2 } },
      { body: { webhookDelivery: task }, opts: { contentType: 'json', delaySeconds: MAX_QUEUE_DELAY_SECONDS } },
    ]);
  });

  it('recognizes only well-formed retry messages', () => {
    expect(isWebhookRetryMessage({ webhookDelivery: task })).toBe(true);
    expect(isWebhookRetryMessage({ jobId: 'job_1' })).toBe(false);
    expect(isWebhookRetryMessage({ webhookDelivery: { ...task, attempt: -1 } })).toBe(false);
    expect(isWebhookRetryMessage({ webhookDelivery: { ...task, body: undefined } })).toBe(false);
    expect(isWebhookRetryMessage(null)).toBe(false);
  });
});

interface State {
  attempts: AttemptResult[];
  rest: unknown[];
  hooks: WebhookRecord[];
}

describe.skipIf(!miniflare || !esbuild)('durable retries through Cloudflare Queues under Miniflare', () => {
  let mf: InstanceType<NonNullable<typeof miniflare>['Miniflare']>;
  let receivers: Receiver[] = [];

  beforeAll(async () => {
    const built = await (esbuild as NonNullable<typeof esbuild>).build({
      entryPoints: [join(import.meta.dirname, 'workers', 'retry-worker.ts')],
      bundle: true,
      write: false,
      format: 'esm',
      platform: 'browser',
      conditions: ['workerd', 'worker', 'browser'],
      target: 'es2022',
      logLevel: 'silent',
    });
    const mfm = miniflare as NonNullable<typeof miniflare>;
    mf = new mfm.Miniflare(
      mfm.convertV4MiniflareOptions({
        modules: true,
        script: built.outputFiles[0]?.text as string,
        compatibilityDate: '2026-10-01',
        kvNamespaces: ['WEBHOOKS_KV'],
        queueProducers: { WEBHOOKS: { queueName: 'webhooks' } },
        queueConsumers: { webhooks: { maxBatchTimeout: 0.05, maxRetries: 2 } },
      }),
    );
    await mf.ready;
  }, 60_000);

  afterEach(async () => {
    await Promise.all(receivers.map((r) => r.close()));
    receivers = [];
  });

  afterAll(async () => {
    await mf?.dispose();
  });

  async function post<T>(path: string, body?: unknown): Promise<T> {
    const res = await mf.dispatchFetch(`http://localhost${path}`, {
      method: 'POST',
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return (res.status === 202 ? null : await res.json()) as T;
  }

  async function state(): Promise<State> {
    return (await (await mf.dispatchFetch('http://localhost/state')).json()) as State;
  }

  async function until(pred: (s: State) => boolean, timeoutMs = 15_000): Promise<State> {
    const started = Date.now();
    for (;;) {
      const s = await state();
      if (pred(s)) return s;
      if (Date.now() - started > timeoutMs) throw new Error(`timed out; last state ${JSON.stringify(s)}`);
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  it('a 500 is retried from a delayed queue message, with the same webhook-id, and delivered', async () => {
    const r = await startReceiver((_req, res, i) => {
      res.writeHead(i === 0 ? 500 : 200).end();
    });
    receivers.push(r);
    const hook = await post<WebhookRecord>('/hooks', { url: r.url, events: ['video.ingested'] });

    const result = await post<{ deliveries: AttemptResult[] }>('/emit', {
      type: 'video.ingested',
      data: videoIngestedData(gwagon),
    });
    expect(result.deliveries).toMatchObject([{ hookId: hook.id, attempt: 1, outcome: 'retrying', status: 500, nextAttemptInMs: 1000 }]);

    const [first, second] = await r.waitFor(2, 15_000);
    expect(second?.headers['webhook-id']).toBe(first?.headers['webhook-id']);
    // The retry is signed again (fresh timestamp) and verifies with the official library.
    const payload = new Webhook(hook.secret).verify(second?.body.toString() ?? '', second?.headers ?? {}) as { type: string };
    expect(payload.type).toBe('video.ingested');

    const s = await until((s) => s.attempts.some((a) => a.hookId === hook.id && a.outcome === 'delivered'));
    expect(s.attempts.filter((a) => a.hookId === hook.id).map((a) => [a.attempt, a.outcome])).toEqual([
      [1, 'retrying'],
      [2, 'delivered'],
    ]);
    expect(s.hooks.find((h) => h.id === hook.id)).toMatchObject({ failures: 0, lastStatus: 200 });
  }, 30_000);

  it('gives up after the last attempt, each retry scheduled by the consumer through the queue', async () => {
    const r = await startReceiver((_req, res) => {
      res.writeHead(503).end();
    });
    receivers.push(r);
    const hook = await post<WebhookRecord>('/hooks', { url: r.url, events: ['video.ingested'] });
    await post('/emit', { type: 'video.ingested', data: videoIngestedData(gwagon) });

    const s = await until((s) => s.attempts.some((a) => a.hookId === hook.id && a.outcome === 'failed'));
    expect(s.attempts.filter((a) => a.hookId === hook.id).map((a) => [a.attempt, a.outcome])).toEqual([
      [1, 'retrying'],
      [2, 'retrying'],
      [3, 'failed'],
    ]);
    expect(r.received).toHaveLength(3);
    expect(s.hooks.find((h) => h.id === hook.id)).toMatchObject({ failures: 3, lastStatus: 503 });
  }, 30_000);

  it('hands messages that are not webhook retries back to the caller', async () => {
    await post('/other');
    const s = await until((s) => s.rest.length > 0);
    expect(s.rest).toEqual([{ jobId: 'job_not_a_webhook' }]);
  }, 30_000);
});

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { VideoContext } from '@vid2context/core';
import { testContext } from '@vid2context/core/testing';
import { Webhook } from 'standardwebhooks';
import { afterEach, describe, expect, it } from 'vitest';
import { type AttemptResult, emit, sendTestPing, webhookEmitter } from '../src/deliver.ts';
import { collectionUpdatedData, videoIngestedData, type WebhookPayload } from '../src/events.ts';
import { verifyWebhook } from '../src/signing.ts';
import { WebhookStore } from '../src/store.ts';
import { type Receiver, startReceiver } from './receiver.ts';

// Real pipeline output (tests/fixtures/contexts, documented in its README).
const gwagon = JSON.parse(
  readFileSync(join(import.meta.dirname, '../../../tests/fixtures/contexts/youtube-cCPsdFdlshc.json'), 'utf8'),
) as VideoContext;

// Real fetch against a real receiver on 127.0.0.1, which needs the local opt-in.
const env = { VID2CONTEXT_WEBHOOKS_ALLOW_LOCAL: '1' };
const ctx = testContext({ env, fetch: globalThis.fetch });

let receivers: Receiver[] = [];
afterEach(async () => {
  await Promise.all(receivers.map((r) => r.close()));
  receivers = [];
});

async function receiver(answer: Parameters<typeof startReceiver>[0]): Promise<Receiver> {
  const r = await startReceiver(answer);
  receivers.push(r);
  return r;
}

function waitForAttempt(results: AttemptResult[], pred: (r: AttemptResult) => boolean, timeoutMs = 5000): Promise<AttemptResult> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = () => {
      const hit = results.find(pred);
      if (hit) return resolve(hit);
      if (Date.now() - started > timeoutMs) return reject(new Error(`no matching attempt in ${JSON.stringify(results)}`));
      setTimeout(tick, 10);
    };
    tick();
  });
}

describe('delivery to a real local receiver', () => {
  it('delivers a signed collection.updated that verifies with this package and the official library', async () => {
    const r = await receiver((_req, res) => res.writeHead(204).end());
    const store = WebhookStore.inMemory();
    const hook = await store.create({ url: r.url, events: ['collection.updated'] }, ctx);
    await store.create({ url: r.url.replace('/hook', '/other'), events: ['job.failed'] }, ctx);

    const data = collectionUpdatedData(
      { id: 'g-wagon-1a2b3c4d', name: 'G-Wagon', videoIds: [gwagon.metadata.ref.id] },
      { added: [gwagon], checkedAt: '2026-11-14T12:00:00.000Z' },
      { env: { VID2CONTEXT_WEBHOOKS_BASE_URL: 'https://v2c.example.com/' } },
    );
    const result = await emit({ type: 'collection.updated', data }, store, ctx);

    expect(result.deliveries).toHaveLength(1);
    expect(result.deliveries[0]).toMatchObject({ hookId: hook.id, outcome: 'delivered', status: 204, attempt: 1 });
    const [got] = await r.waitFor(1);
    expect(got?.method).toBe('POST');
    expect(got?.path).toBe('/hook');
    expect(got?.headers['content-type']).toBe('application/json');
    expect(got?.headers['webhook-id']).toBe(result.messageId);

    const body = got?.body.toString('utf8') ?? '';
    const payload = await verifyWebhook<WebhookPayload<'collection.updated'>>(hook.secret, got?.headers ?? {}, body);
    expect(new Webhook(hook.secret).verify(body, got?.headers ?? {})).toEqual(payload);
    expect(payload.type).toBe('collection.updated');
    expect(payload.data.collection).toMatchObject({ id: 'g-wagon-1a2b3c4d', name: 'G-Wagon', videoCount: 1 });
    expect(payload.data.added[0]).toMatchObject({
      id: 'youtube:cCPsdFdlshc',
      title: gwagon.metadata.title,
      links: { context: 'https://v2c.example.com/api/v1/library/youtube%3AcCPsdFdlshc' },
    });
    // Ids, titles and links only: no transcript text travels in a webhook.
    const firstLine = gwagon.transcript.segments[0]?.text ?? '';
    expect(firstLine.length).toBeGreaterThan(0);
    expect(body).not.toContain(firstLine);
    expect(body.length).toBeLessThan(2000);
    expect((await store.get(hook.id))?.failures).toBe(0);
  });

  it('retries a 500 and succeeds on the next attempt with the same webhook-id', async () => {
    const r = await receiver((_req, res, i) => res.writeHead(i === 0 ? 500 : 200).end('ok'));
    const store = WebhookStore.inMemory();
    const hook = await store.create({ url: r.url, events: ['video.ingested'] }, ctx);
    const attempts: AttemptResult[] = [];

    const result = await emit({ type: 'video.ingested', data: videoIngestedData(gwagon, { collectionId: 'g-wagon' }) }, store, ctx, {
      retryDelaysMs: [0, 50, 50],
      onAttempt: (a) => attempts.push(a),
    });
    expect(result.deliveries[0]).toMatchObject({ outcome: 'retrying', status: 500, attempt: 1 });
    expect(result.deliveries[0]?.nextAttemptInMs).toBeGreaterThanOrEqual(40);

    const second = await waitForAttempt(attempts, (a) => a.attempt === 2);
    expect(second).toMatchObject({ outcome: 'delivered', status: 200 });
    const got = await r.waitFor(2);
    expect(got[0]?.headers['webhook-id']).toBe(got[1]?.headers['webhook-id']);
    // Each attempt is signed afresh and both verify.
    for (const req of got) await expect(verifyWebhook(hook.secret, req.headers, req.body)).resolves.toMatchObject({ type: 'video.ingested' });
    expect((await store.get(hook.id))?.failures).toBe(0);
  });

  it('gives up after the last scheduled attempt and honours Retry-After on 429', async () => {
    const r = await receiver((_req, res) => res.writeHead(429, { 'retry-after': '0' }).end());
    const store = WebhookStore.inMemory();
    const hook = await store.create({ url: r.url, events: ['job.failed'] }, ctx);
    const attempts: AttemptResult[] = [];
    const job = { id: 'job_1', kind: 'ingest', status: 'failed', createdAt: '2026-11-14T12:00:00.000Z', updatedAt: '2026-11-14T12:01:00.000Z' };
    await emit({ type: 'job.failed', data: { job: { ...job, links: { job: '/api/v1/jobs/job_1' } } } }, store, ctx, {
      retryDelaysMs: [0, 20],
      jitter: false,
      onAttempt: (a) => attempts.push(a),
    });
    const last = await waitForAttempt(attempts, (a) => a.attempt === 2);
    expect(last).toMatchObject({ outcome: 'failed', status: 429 });
    expect((await store.get(hook.id))?.failures).toBe(2);
  });

  it('times out a receiver that never answers', async () => {
    const r = await receiver(() => {
      // Hold the request open; the delivery must abort on its own.
    });
    const store = WebhookStore.inMemory();
    const hook = await store.create({ url: r.url, events: ['brief.ready'] }, ctx);
    const started = Date.now();
    const result = await emit({ type: 'brief.ready', data: { brief: { id: 'job_9', jobId: 'job_9', links: {} } } }, store, ctx, {
      timeoutMs: 300,
      retryDelaysMs: [0],
    });
    expect(Date.now() - started).toBeLessThan(3000);
    expect(result.deliveries[0]).toMatchObject({ outcome: 'failed', error: 'no answer within 300 ms' });
    expect(await store.get(hook.id)).toMatchObject({ failures: 1, lastError: 'no answer within 300 ms' });
  });

  it('disables a hook after 20 consecutive failures and stops sending to it', async () => {
    const r = await receiver((_req, res) => res.writeHead(503).end());
    const store = WebhookStore.inMemory();
    const hook = await store.create({ url: r.url, events: ['*'] }, ctx);
    const outcomes: string[] = [];
    for (let i = 0; i < 20; i++) {
      const res = await emit({ type: 'video.ingested', data: videoIngestedData(gwagon) }, store, ctx, { retryDelaysMs: [0] });
      outcomes.push(res.deliveries[0]?.outcome ?? 'none');
    }
    expect(outcomes.slice(0, 19).every((o) => o === 'failed')).toBe(true);
    expect(outcomes[19]).toBe('disabled');
    const stored = await store.get(hook.id);
    expect(stored).toMatchObject({ failures: 20, disabledReason: '20 consecutive failed deliveries' });
    expect(stored?.disabledAt).toBeTruthy();

    const after = await emit({ type: 'video.ingested', data: videoIngestedData(gwagon) }, store, ctx);
    expect(after.deliveries).toHaveLength(0);
    expect(r.received).toHaveLength(20);
  });

  it('disables at once on 410 Gone, and a successful test ping re-enables', async () => {
    let gone = true;
    const r = await receiver((_req, res) => res.writeHead(gone ? 410 : 200).end());
    const store = WebhookStore.inMemory();
    const hook = await store.create({ url: r.url, events: ['job.succeeded'] }, ctx);
    const job = { id: 'job_2', kind: 'brief', status: 'succeeded', createdAt: '2026-11-14T12:00:00.000Z', updatedAt: '2026-11-14T12:00:09.000Z' };
    const res = await emit({ type: 'job.succeeded', data: { job: { ...job, links: { job: '/api/v1/jobs/job_2' } } } }, store, ctx);
    expect(res.deliveries[0]).toMatchObject({ outcome: 'disabled', status: 410 });
    expect((await store.get(hook.id))?.disabledReason).toBe('the receiver answered 410 Gone');

    gone = false;
    const ping = await sendTestPing(hook.id, store, ctx);
    expect(ping).toMatchObject({ outcome: 'delivered', type: 'test.ping' });
    const stored = await store.get(hook.id);
    expect(stored?.disabledAt).toBeUndefined();
    expect(stored?.failures).toBe(0);
    const last = r.received.at(-1);
    await expect(verifyWebhook(hook.secret, last?.headers ?? {}, last?.body ?? '')).resolves.toMatchObject({
      type: 'test.ping',
      data: { webhookId: hook.id },
    });
  });

  it('does not follow redirects', async () => {
    const r = await receiver((req, res) => {
      if (req.path === '/hook') res.writeHead(302, { location: '/landed' }).end();
      else res.writeHead(200).end();
    });
    const store = WebhookStore.inMemory();
    await store.create({ url: r.url, events: ['video.ingested'] }, ctx);
    const res = await emit({ type: 'video.ingested', data: videoIngestedData(gwagon) }, store, ctx);
    expect(res.deliveries[0]).toMatchObject({ outcome: 'failed', status: 302 });
    expect(r.received.map((x) => x.path)).toEqual(['/hook']);
  });

  it('re-checks the URL before every attempt (a hook to localhost stops once local delivery is turned off)', async () => {
    const r = await receiver((_req, res) => res.writeHead(200).end());
    const store = WebhookStore.inMemory();
    const hook = await store.create({ url: r.url, events: ['video.ingested'] }, ctx);
    const strict = testContext({ env: {}, fetch: globalThis.fetch });
    const res = await emit({ type: 'video.ingested', data: videoIngestedData(gwagon) }, store, strict);
    expect(res.deliveries[0]).toMatchObject({ hookId: hook.id, outcome: 'failed' });
    expect(res.deliveries[0]?.error).toMatch(/refused/);
    expect(r.received).toHaveLength(0);
  });

  it('emitter.on never throws and reports deliveries', async () => {
    const r = await receiver((_req, res) => res.writeHead(200).end());
    const store = WebhookStore.inMemory();
    await store.create({ url: r.url, events: ['video.ingested'] }, ctx);
    const emitter = webhookEmitter(store, ctx);
    const ok = await emitter.on('video.ingested', videoIngestedData(gwagon));
    expect(ok?.deliveries[0]?.outcome).toBe('delivered');
    // A payload over the size cap is refused by emit; the emitter logs and resolves null.
    const huge = videoIngestedData(gwagon);
    huge.video.title = 'x'.repeat(300 * 1024);
    await expect(emitter.on('video.ingested', huge)).resolves.toBeNull();
  });
});

describe('SSRF rejections at registration', () => {
  const strict = testContext({ env: {}, fetch: globalThis.fetch });

  it.each([
    'http://127.0.0.1:8080/hook',
    'https://127.0.0.1/hook',
    'https://[::1]/hook',
    'https://10.0.0.5/hook',
    'https://169.254.169.254/latest/meta-data/',
    'https://localhost/hook',
    'http://example.com/hook',
  ])('refuses %s without the local opt-in', async (url) => {
    await expect(WebhookStore.inMemory().create({ url, events: ['video.ingested'] }, strict)).rejects.toMatchObject({
      code: 'bad-request',
    });
  });

  it('refuses metadata addresses even with the local opt-in', async () => {
    await expect(
      WebhookStore.inMemory().create({ url: 'http://169.254.169.254/latest/meta-data/', events: ['video.ingested'] }, ctx),
    ).rejects.toThrow(/metadata/);
  });

  it('validates events', async () => {
    const store = WebhookStore.inMemory();
    await expect(store.create({ url: 'https://8.8.8.8/hook', events: [] }, strict, { resolve: null })).rejects.toThrow(/non-empty/);
    await expect(store.create({ url: 'https://8.8.8.8/hook', events: ['video.deleted'] }, strict, { resolve: null })).rejects.toThrow(
      /Unknown webhook event: video.deleted/,
    );
    const all = await store.create({ url: 'https://8.8.8.8/hook', events: ['video.ingested', '*'] }, strict, { resolve: null });
    expect(all.events).toEqual(['*']);
  });
});

/**
 * Runs the Cloudflare Queues producer and consumer inside workerd through
 * Miniflare (installed with wrangler). Skipped when Miniflare or esbuild is
 * not installed.
 */
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cloudflareDispatch, jobMessage, MAX_DELAY_SECONDS } from '../src/index.ts';
import { waitFor, ytFixture } from './helpers.ts';

const miniflare = await import('miniflare').catch(() => null);
const esbuild = await import('esbuild').catch(() => null);

describe('cloudflareDispatch', () => {
  it('sends { jobId } and caps retry delays at the Queues limit', async () => {
    const sent: { body: unknown; opts: unknown }[] = [];
    const dispatch = cloudflareDispatch({ send: async (body, opts) => void sent.push({ body, opts }) });
    await dispatch({ id: 'job_abcdefghijklmnopqrstuv', kind: 'context', status: 'queued', createdAt: '', updatedAt: '' });
    await dispatch({ id: 'job_abcdefghijklmnopqrstuv', kind: 'context', status: 'queued', createdAt: '', updatedAt: '' }, 1500);
    await dispatch(
      { id: 'job_abcdefghijklmnopqrstuv', kind: 'context', status: 'queued', createdAt: '', updatedAt: '' },
      10 ** 9,
    );
    expect(sent).toEqual([
      { body: jobMessage('job_abcdefghijklmnopqrstuv'), opts: { contentType: 'json' } },
      { body: { jobId: 'job_abcdefghijklmnopqrstuv' }, opts: { contentType: 'json', delaySeconds: 2 } },
      { body: { jobId: 'job_abcdefghijklmnopqrstuv' }, opts: { contentType: 'json', delaySeconds: MAX_DELAY_SECONDS } },
    ]);
  });
});

describe.skipIf(!miniflare || !esbuild)('Cloudflare Queues under Miniflare', () => {
  let mf: InstanceType<NonNullable<typeof miniflare>['Miniflare']>;

  beforeAll(async () => {
    const fixtures = {
      player: ytFixture('player-jNQXAC9IVRw.json'),
      unavailable: ytFixture('player-unavailable.json'),
      en: ytFixture('timedtext-jNQXAC9IVRw-en.srv3.xml'),
      de: ytFixture('timedtext-jNQXAC9IVRw-de.srv3.xml'),
      blocked: ytFixture('timedtext-429-blocked.html'),
    };
    const built = await (esbuild as NonNullable<typeof esbuild>).build({
      entryPoints: [join(import.meta.dirname, 'workers', 'queue-worker.ts')],
      bundle: true,
      write: false,
      format: 'esm',
      platform: 'browser',
      conditions: ['workerd', 'worker', 'browser'],
      target: 'es2022',
      define: { FIXTURES: JSON.stringify(fixtures) },
      logLevel: 'silent',
    });
    const mfm = miniflare as NonNullable<typeof miniflare>;
    // Miniflare 5 still accepts the v4 option shape through this converter.
    mf = new mfm.Miniflare(
      mfm.convertV4MiniflareOptions({
        modules: true,
        script: built.outputFiles[0]?.text as string,
        compatibilityDate: '2026-10-01',
        kvNamespaces: ['JOBS_KV'],
        queueProducers: { JOBS: { queueName: 'jobs' } },
        queueConsumers: { jobs: { maxBatchTimeout: 0.05, maxRetries: 3 } },
      }),
    );
    await mf.ready;
  }, 60_000);

  afterAll(async () => {
    await mf?.dispose();
  });

  async function job(id: string) {
    const res = await mf.dispatchFetch(`http://localhost/jobs/${id}`);
    return (await res.json()) as {
      job: { status: string; result?: Record<string, unknown> };
      snapshot: { events: { type: string; data: unknown }[] };
    };
  }

  it('runs a context job sent through the queue binding and stores the result in Workers KV', async () => {
    const res = await mf.dispatchFetch('http://localhost/jobs', {
      method: 'POST',
      body: JSON.stringify({ kind: 'context', input: 'https://www.youtube.com/watch?v=jNQXAC9IVRw' }),
    });
    expect(res.status).toBe(202);
    const { id } = (await res.json()) as { id: string };
    await waitFor(async () => (await job(id)).job.status === 'succeeded', 20_000);
    const final = await job(id);
    expect(final.job.result).toMatchObject({ video: { id: 'youtube:jNQXAC9IVRw', title: 'Me at the zoo' } });
    const stages = final.snapshot.events
      .filter((e) => e.type === 'progress')
      .map((e) => String((e.data as { message: string }).message).split(':')[0]);
    expect(stages).toEqual(['resolve', 'metadata', 'captions', 'saving', 'done']);
  }, 30_000);

  it('retries a recorded 429 through message.retry and succeeds on the second delivery', async () => {
    const res = await mf.dispatchFetch('http://localhost/jobs', {
      method: 'POST',
      body: JSON.stringify({
        kind: 'timedtext',
        input: 'https://www.youtube.com/api/timedtext?v=jNQXAC9IVRw&lang=en&fmt=srv3&probe=retry',
      }),
    });
    const { id } = (await res.json()) as { id: string };
    await waitFor(async () => (await job(id)).job.status === 'succeeded', 20_000);
    const final = await job(id);
    expect((final.job.result as { segments: number }).segments).toBeGreaterThan(0);
    expect(
      final.snapshot.events.some(
        (e) => e.type === 'progress' && String((e.data as { message: string }).message).includes('rate-limited'),
      ),
    ).toBe(true);
  }, 30_000);
});

/**
 * /healthz on the real app: liveness, deep readiness with the real registry
 * providers and storage, and the Node checks against real binaries, a real
 * filesystem and real local HTTP servers (one answers, one never does).
 */

import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryStorage, Registry } from '@vid2context/core';
import { testContext } from '@vid2context/core/testing';
import llm from '@vid2context/provider-llm-openai-compatible';
import stt from '@vid2context/provider-stt-openai-compatible';
import youtube from '@vid2context/provider-youtube';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DeepHealth, HealthCheck } from '../src/health.ts';
import { diskCheck, ffmpegCheck, networkCheck, nodeHealthChecks, versionOf, ytdlpCheck } from '../src/health-node.ts';
import { makeApp } from './helpers.ts';

const root = join(import.meta.dirname, '..', '..', '..');
const home = mkdtempSync(join(tmpdir(), 'v2c-health-'));
let silent: Server;
let answering: Server;
let silentUrl = '';
let answeringUrl = '';

beforeAll(async () => {
  silent = createServer(() => undefined);
  answering = createServer((_req, res) => res.writeHead(200, { 'content-type': 'application/json' }).end('{"data":[]}'));
  for (const s of [silent, answering]) await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()));
  silentUrl = `http://127.0.0.1:${(silent.address() as AddressInfo).port}/v1/models`;
  answeringUrl = `http://127.0.0.1:${(answering.address() as AddressInfo).port}/v1/models`;
});
afterAll(async () => {
  for (const s of [silent, answering]) {
    s.closeAllConnections();
    await new Promise<void>((r) => s.close(() => r()));
  }
  rmSync(home, { recursive: true, force: true });
});

const fullRegistry = () => new Registry([youtube, stt, llm].flat(), 'node');

describe('/healthz', () => {
  it('answers liveness without touching anything, on both paths, without a key', async () => {
    const { app } = makeApp({ env: { VID2CONTEXT_API_KEYS: 'secret-key-0123456789' } });
    for (const path of ['/healthz', '/api/v1/healthz']) {
      const res = await app.request(path);
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ ok: true });
    }
  });

  it('is ready with storage and STT and LLM rungs, and fails with 503 when a required check fails', async () => {
    const ok = makeApp({ storage: new MemoryStorage(), app: { registry: fullRegistry() } });
    const res = await ok.app.request('/healthz?deep=1');
    expect(res.status).toBe(200);
    const body = (await res.json()) as DeepHealth;
    expect(body.status).toBe('ok');
    expect(body.checks.find((c) => c.id === 'storage')).toMatchObject({ status: 'ok', required: true });
    expect(body.checks.find((c) => c.id === 'rungs')?.detail).toMatch(/speech-to-text and \d+ LLM rungs enabled/);

    // The default test registry has no LLM provider: a required check fails.
    const bad = makeApp({ storage: new MemoryStorage() });
    const res2 = await bad.app.request('/api/v1/healthz?deep=1');
    expect(res2.status).toBe(503);
    const body2 = (await res2.json()) as DeepHealth;
    expect(body2).toMatchObject({ ok: false, status: 'fail' });
    expect(body2.checks.find((c) => c.id === 'rungs')?.status).toBe('fail');
  });

  it('runs the runtime checks once for concurrent probes and caches the result', async () => {
    let runs = 0;
    const { app } = makeApp({
      storage: new MemoryStorage(),
      app: {
        registry: fullRegistry(),
        healthChecks: async (ctx) => {
          runs++;
          return [await diskCheck({ ...ctx.env, VID2CONTEXT_HOME: home })];
        },
      },
    });
    const all = await Promise.all([1, 2, 3].map(() => app.request('/healthz?deep=1')));
    expect(all.map((r) => r.status)).toEqual([200, 200, 200]);
    await app.request('/healthz?deep=1');
    expect(runs).toBe(1);
  });

  it('degrades on optional checks and fails on required ones (VID2CONTEXT_HEALTH_REQUIRE)', async () => {
    const env = {
      VID2CONTEXT_HOME: home,
      YTDLP_PATH: join(home, 'missing-yt-dlp'),
      VID2CONTEXT_HEALTH_PROBE_URL: answeringUrl,
    };
    const degraded = makeApp({
      env,
      storage: new MemoryStorage(),
      app: { registry: fullRegistry(), healthChecks: nodeHealthChecks },
    });
    const res = await degraded.app.request('/healthz?deep=1');
    expect(res.status).toBe(200);
    const body = (await res.json()) as DeepHealth;
    expect(body.status).toBe('degraded');
    expect(body.checks.find((c) => c.id === 'yt-dlp')).toMatchObject({ status: 'fail', required: false });
    expect(JSON.stringify(body)).not.toContain(home);

    const strict = makeApp({
      env: { ...env, VID2CONTEXT_HEALTH_REQUIRE: 'yt-dlp' },
      storage: new MemoryStorage(),
      app: { registry: fullRegistry(), healthChecks: nodeHealthChecks },
    });
    expect((await strict.app.request('/healthz?deep=1')).status).toBe(503);
  });
});

describe('Node checks', () => {
  it('measures free disk space and fails under VID2CONTEXT_HEALTH_MIN_FREE_MB', async () => {
    expect((await diskCheck({ VID2CONTEXT_HOME: home })).status).toBe('ok');
    const low = await diskCheck({ VID2CONTEXT_HOME: home, VID2CONTEXT_HEALTH_MIN_FREE_MB: String(1024 ** 3) });
    expect(low.status).toBe('fail');
    expect(low.detail).toContain('VID2CONTEXT_HEALTH_MIN_FREE_MB');
  });

  it('kills a version command that does not answer in time', async () => {
    const started = Date.now();
    await expect(versionOf(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], 300)).rejects.toThrow(
      'did not answer within 300 ms',
    );
    expect(Date.now() - started).toBeLessThan(3000);
  });

  const managed = join(root, '.vid2context', 'bin', 'yt-dlp');
  it.skipIf(!existsSync(managed))('reads the real yt-dlp version and flags a stale one', async () => {
    const ok = await ytdlpCheck({ YTDLP_PATH: managed }, 30_000, Date.UTC(2026, 10, 15));
    expect(ok.status).toBe('ok');
    expect(ok.detail).toMatch(/^\d{4}\.\d{2}\.\d{2}/);
    const stale = await ytdlpCheck({ YTDLP_PATH: managed }, 30_000, Date.UTC(2028, 0, 1));
    expect(stale.status).toBe('warn');
    expect(stale.detail).toContain('days old');
  });

  const ffmpeg = join(homedir(), '.local', 'bin', 'ffmpeg');
  it.skipIf(!existsSync(ffmpeg))('reads the real ffmpeg version', async () => {
    const res: HealthCheck = await ffmpegCheck({ FFMPEG_PATH: ffmpeg }, 30_000);
    expect(res.status).toBe('ok');
  });

  it('probes the network with a deadline: ok when a server answers, failed when it never does', async () => {
    const ctx = (url: string) =>
      testContext({ env: { VID2CONTEXT_HEALTH_PROBE_URL: url }, fetch: globalThis.fetch.bind(globalThis) });
    expect((await networkCheck(ctx(answeringUrl), 2000)).status).toBe('ok');
    const started = Date.now();
    await expect(networkCheck(ctx(silentUrl), 300)).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(3000);
    const all = await nodeHealthChecks(
      testContext({
        env: { VID2CONTEXT_HOME: home, VID2CONTEXT_HEALTH_PROBE_URL: silentUrl, VID2CONTEXT_HEALTH_TIMEOUT_MS: '300' },
        fetch: globalThis.fetch.bind(globalThis),
      }),
    );
    expect(all.find((c) => c.id === 'network')?.status).toBe('fail');
    expect((await networkCheck(ctx('0'), 300)).detail).toContain('turned off');
  });
});

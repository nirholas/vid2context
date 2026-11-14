import { Vid2ContextError, type VideoRef } from '@vid2context/core';
import { replayFetch, testContext } from '@vid2context/core/testing';
import { createRegistry } from '@vid2context/registry/node';
import { describe, expect, it } from 'vitest';
import supadata, {
  DEFAULT_BASE_URL,
  DEFAULT_MAX_WAIT_SEC,
  jobUrl,
  mapError,
  SUPADATA_ORDER,
  settings,
  transcriptUrl,
} from '../src/index.ts';

// No Supadata key was available, so no real response could be recorded (see
// test/fixtures/README.md). These tests cover only behaviour that needs no
// response body: key gating, ordering, the request that is sent, timeouts,
// cancellation and status-code mapping. replayFetch([]) records each request
// and then throws, so no payload is ever invented.

const KEY = 'sd_test_key_not_real';

const ref: VideoRef = {
  input: 'https://www.youtube.com/watch?v=jNQXAC9IVRw&t=5s&list=PL0',
  platform: 'youtube',
  kind: 'video',
  id: 'youtube:jNQXAC9IVRw',
  nativeId: 'jNQXAC9IVRw',
  url: 'https://www.youtube.com/watch?v=jNQXAC9IVRw',
};

describe('key gating', () => {
  it('is enabled only when SUPADATA_API_KEY is set', () => {
    expect(supadata.isEnabled?.({})).toBe(false);
    expect(supadata.isEnabled?.({ SUPADATA_API_KEY: '   ' })).toBe(false);
    expect(supadata.isEnabled?.({ SUPADATA_API_KEY: KEY })).toBe(true);
  });

  it('returns null without a key and sends no request', async () => {
    const fetch = replayFetch([]);
    await expect(supadata.getCaptions(ref, {}, testContext({ fetch }))).resolves.toBeNull();
    expect(fetch.calls).toHaveLength(0);
  });

  it('returns null without a request when auto-captions are not allowed (Supadata cannot tell them apart)', async () => {
    const fetch = replayFetch([]);
    const ctx = testContext({ fetch, env: { SUPADATA_API_KEY: KEY } });
    await expect(supadata.getCaptions(ref, { allowAuto: false }, ctx)).resolves.toBeNull();
    expect(fetch.calls).toHaveLength(0);
  });

  it('supports YouTube video refs only', () => {
    expect(supadata.supports(ref)).toBe(true);
    expect(supadata.supports({ ...ref, kind: 'playlist', id: 'youtube:playlist:PL0', nativeId: 'PL0' })).toBe(false);
    expect(supadata.supports({ ...ref, platform: 'vimeo', id: 'vimeo:76979871', nativeId: '76979871' })).toBe(false);
  });
});

describe('order in the registry', () => {
  const registry = createRegistry();
  const ids = (env?: Record<string, string>) => registry.captions(env).map((p) => p.id);

  it('runs after youtube-captions and ytdlp-captions', () => {
    const all = ids();
    expect(all.at(-1)).toBe('supadata-captions');
    expect(all.indexOf('youtube-captions')).toBeLessThan(all.indexOf('supadata-captions'));
    expect(all.indexOf('ytdlp-captions')).toBeLessThan(all.indexOf('supadata-captions'));
    expect(SUPADATA_ORDER).toBeGreaterThan(0);
  });

  it('is left out of captions(env) and shown disabled in health without a key', () => {
    expect(ids({})).not.toContain('supadata-captions');
    expect(ids({ SUPADATA_API_KEY: KEY }).at(-1)).toBe('supadata-captions');
    expect(registry.health({}).find((p) => p.id === 'supadata-captions')?.enabled).toBe(false);
    expect(registry.health({ SUPADATA_API_KEY: KEY }).find((p) => p.id === 'supadata-captions')?.enabled).toBe(true);
  });
});

describe('settings', () => {
  it('uses the documented base URL and the default wait', () => {
    expect(settings({})).toEqual({ key: undefined, baseUrl: DEFAULT_BASE_URL, maxWaitMs: DEFAULT_MAX_WAIT_SEC * 1000 });
  });

  it('takes overrides from env and ignores a bad wait value', () => {
    expect(settings({ SUPADATA_BASE_URL: 'https://proxy.example/v1//', SUPADATA_MAX_WAIT_SEC: '30' })).toMatchObject({
      baseUrl: 'https://proxy.example/v1',
      maxWaitMs: 30_000,
    });
    expect(settings({ SUPADATA_MAX_WAIT_SEC: 'soon' }).maxWaitMs).toBe(DEFAULT_MAX_WAIT_SEC * 1000);
  });
});

describe('request', () => {
  it('builds the transcript and job URLs', () => {
    expect(transcriptUrl(DEFAULT_BASE_URL, 'jNQXAC9IVRw')).toBe(
      'https://api.supadata.ai/v1/transcript?url=https%3A%2F%2Fwww.youtube.com%2Fwatch%3Fv%3DjNQXAC9IVRw&text=false&mode=native',
    );
    expect(transcriptUrl(DEFAULT_BASE_URL, 'jNQXAC9IVRw', 'de')).toBe(
      'https://api.supadata.ai/v1/transcript?url=https%3A%2F%2Fwww.youtube.com%2Fwatch%3Fv%3DjNQXAC9IVRw&lang=de&text=false&mode=native',
    );
    expect(jobUrl(DEFAULT_BASE_URL, 'a b')).toBe('https://api.supadata.ai/v1/transcript/a%20b');
  });

  it('sends one GET with the key in x-api-key, mode=native and the canonical video URL', async () => {
    const fetch = replayFetch([]);
    const ctx = testContext({ fetch, env: { SUPADATA_API_KEY: KEY } });
    const err = await supadata.getCaptions(ref, { language: 'en' }, ctx).catch((e: unknown) => e);
    expect(fetch.calls).toHaveLength(1);
    const call = fetch.calls[0];
    expect(call?.method).toBe('GET');
    const url = new URL(call?.url ?? '');
    expect(url.origin + url.pathname).toBe('https://api.supadata.ai/v1/transcript');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      url: 'https://www.youtube.com/watch?v=jNQXAC9IVRw',
      lang: 'en',
      text: 'false',
      mode: 'native',
    });
    expect(call?.headers['x-api-key']).toBe(KEY);
    expect(call?.headers.authorization).toBeUndefined();
    expect(call?.url).not.toContain(KEY);
    // A failed request is an upstream error whose message never carries the key.
    expect(err).toBeInstanceOf(Vid2ContextError);
    expect((err as Vid2ContextError).code).toBe('upstream');
    expect((err as Vid2ContextError).message).not.toContain(KEY);
  });

  it('sends no lang when no language is asked for, and uses SUPADATA_BASE_URL', async () => {
    const fetch = replayFetch([]);
    const ctx = testContext({ fetch, env: { SUPADATA_API_KEY: KEY, SUPADATA_BASE_URL: 'https://proxy.example/v1/' } });
    await supadata.getCaptions(ref, {}, ctx).catch(() => undefined);
    const url = new URL(fetch.calls[0]?.url ?? '');
    expect(url.origin + url.pathname).toBe('https://proxy.example/v1/transcript');
    expect(url.searchParams.has('lang')).toBe(false);
  });

  it('stops with the caller abort reason when ctx.signal is aborted', async () => {
    const controller = new AbortController();
    const reason = new Error('caller cancelled');
    controller.abort(reason);
    const ctx = testContext({ fetch: replayFetch([]), env: { SUPADATA_API_KEY: KEY }, signal: controller.signal });
    await expect(supadata.getCaptions(ref, {}, ctx)).rejects.toBe(reason);
  });

  it('times out after SUPADATA_MAX_WAIT_SEC', async () => {
    // A fetch that never answers (no response body at all) and rejects only when aborted.
    const hang: typeof fetch = (_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
      });
    const ctx = testContext({ fetch: hang, env: { SUPADATA_API_KEY: KEY, SUPADATA_MAX_WAIT_SEC: '0.05' } });
    const err = await supadata.getCaptions(ref, {}, ctx).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Vid2ContextError);
    expect((err as Vid2ContextError).code).toBe('timeout');
    expect((err as Vid2ContextError).hint).toMatch(/SUPADATA_MAX_WAIT_SEC/);
  });
});

describe('status mapping (statuses from https://docs.supadata.ai/errors/list)', () => {
  const map = (status: number, stage: 'transcript' | 'job' = 'transcript', retryAfterSec?: number) =>
    mapError(status, undefined, { key: KEY, stage, retryAfterSec });

  it('maps each documented status to a stable code with a hint', () => {
    expect(map(401)).toMatchObject({ code: 'auth', status: 401 });
    expect(map(401).hint).toMatch(/SUPADATA_API_KEY/);
    expect(map(402).code).toBe('auth');
    expect(map(403).code).toBe('unavailable');
    expect(map(404).code).toBe('not-found');
    expect(map(404, 'job').code).toBe('upstream');
    expect(map(429, 'transcript', 7)).toMatchObject({ code: 'rate-limited', retryAfterSec: 7 });
    expect(map(400).code).toBe('upstream');
    expect(map(500).code).toBe('upstream');
    expect(map(502).code).toBe('upstream');
    for (const s of [400, 401, 402, 403, 404, 429, 500, 502]) {
      expect(map(s).hint).toBeTruthy();
      expect(map(s).message).not.toContain(KEY);
    }
  });
});

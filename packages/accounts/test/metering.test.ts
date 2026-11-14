import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chat, clearCooldowns, getVideoContext, MemoryKv, MemoryStorage, Registry, type VideoContext } from '@vid2context/core';
import { replayFetch, testContext } from '@vid2context/core/testing';
import llm from '@vid2context/provider-llm-openai-compatible';
import mediaFile from '@vid2context/provider-media-file';
import stt from '@vid2context/provider-stt-openai-compatible';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_PLANS, type Plan } from '../src/plans.ts';
import { isShareable, sharedCache, sharedCacheKey } from '../src/shared-cache.ts';
import { secondsUntilUtcMidnight, UsageMeter, utcDay } from '../src/usage.ts';

const root = new URL('../../../', import.meta.url);
const read = (p: string) => readFileSync(new URL(p, root), 'utf8');
// Public-domain Apollo 11 audio and the real OVH Whisper response for it (providers/stt-openai-compatible/test/fixtures).
const APOLLO = fileURLToPath(new URL('tests/fixtures/media/apollo11-small-step.mp3', root));
const OVH_STT = 'https://oai.endpoints.kepler.ai.cloud.ovh.net/v1/audio/transcriptions';
const OVH_CHAT = 'https://oai.endpoints.kepler.ai.cloud.ovh.net/v1/chat/completions';
const ovhStt = () => ({
  method: 'POST',
  url: OVH_STT,
  response: { body: read('providers/stt-openai-compatible/test/fixtures/ovh-whisper-large-v3-turbo.verbose.json') },
});
const zoo = JSON.parse(read('tests/fixtures/contexts/youtube-jNQXAC9IVRw.json')) as VideoContext;

const registry = new Registry([mediaFile, stt, llm].flat(), 'node');
// Loaded only by the tests that resolve YouTube URLs, so the others do not depend on the YouTube provider.
const withYoutube = async () =>
  new Registry([(await import('@vid2context/provider-youtube')).default, mediaFile, stt, llm].flat(), 'node');
const T0 = Date.parse('2026-11-14T22:00:00Z');
const plan = (p: Partial<Plan> = {}): Plan => ({ ...(DEFAULT_PLANS.free as Plan), ...p });

afterEach(() => clearCooldowns());

describe('daily counters', () => {
  it('counts requests up to the limit, then answers with a hit until 00:00 UTC', async () => {
    const kv = new MemoryKv();
    let now = T0;
    const meter = () => new UsageMeter(kv, 'acc_1', 'free', plan({ requestsPerDay: 2 }), () => now);
    expect(await meter().chargeRequest()).toBeNull();
    expect(await meter().chargeRequest()).toBeNull();
    const hit = await meter().chargeRequest();
    expect(hit).toMatchObject({ limit: 'requests', retryAfterSec: 7200 });
    expect(hit?.message).toContain('daily request limit (2 requests per day) of the free plan');
    expect(hit?.hint).toContain('00:00 UTC, in 2 h 0 min');
    expect((await meter().read()).requests).toBe(2);

    now = Date.parse('2026-11-15T00:00:01Z');
    expect(utcDay(now)).toBe('2026-11-15');
    expect(await meter().read()).toEqual({ requests: 0, sttSeconds: 0, llmCalls: 0 });
    expect(await meter().chargeRequest()).toBeNull();
    // Each account has its own counters.
    expect((await new UsageMeter(kv, 'acc_2', 'free', plan(), () => now).read()).requests).toBe(0);
  });

  it('computes the wait until the next UTC midnight', () => {
    expect(secondsUntilUtcMidnight(Date.parse('2026-11-14T23:00:00Z'))).toBe(3600);
    expect(secondsUntilUtcMidnight(Date.parse('2026-12-31T23:59:59.500Z'))).toBe(1);
  });
});

describe('metered rungs', () => {
  it('charges speech-to-text minutes from the transcript end when the source reports no duration', async () => {
    const meter = new UsageMeter(new MemoryKv(), 'acc_1', 'free', plan(), () => T0);
    const ctx = testContext({ fetch: replayFetch([ovhStt()]) });
    const rung = meter
      .wrapRegistry(registry)
      .sttRungs({})
      .find((r) => r.service === 'ovh');
    const data = new Uint8Array(readFileSync(APOLLO));
    const res = await rung?.transcribe(
      { kind: 'bytes', data, mimeType: 'audio/mpeg', filename: 'apollo11-small-step.mp3' },
      {},
      ctx,
    );
    expect(res?.model).toBe('whisper-large-v3-turbo');
    // The last OVH segment ends at 23.06 s.
    expect((await meter.read()).sttSeconds).toBe(24);
  });

  it('charges the audio duration when the pipeline reports one', async () => {
    const meter = new UsageMeter(new MemoryKv(), 'acc_1', 'free', plan(), () => T0);
    const ctx = testContext({ fetch: replayFetch([ovhStt()]) });
    const rung = meter
      .wrapRegistry(registry)
      .sttRungs({})
      .find((r) => r.service === 'ovh');
    const data = new Uint8Array(readFileSync(APOLLO));
    // 24.2 s is the duration documented in tests/fixtures/README.md.
    await rung?.transcribe(
      { kind: 'bytes', data, mimeType: 'audio/mpeg', filename: 'apollo11-small-step.mp3', durationSec: 24.2 },
      {},
      ctx,
    );
    expect((await meter.read()).sttSeconds).toBe(25);
  });

  it('refuses before uploading when the minutes are used up, without a cooldown on the shared rung', async () => {
    const meter = new UsageMeter(new MemoryKv(), 'acc_1', 'free', plan({ sttMinutesPerDay: 0 }), () => T0);
    const fetch = replayFetch([ovhStt()]);
    const err = await getVideoContext(meter.wrapRegistry(registry), APOLLO, { mode: 'stt' }, testContext({ fetch })).catch(
      (e) => e,
    );
    expect(err).toMatchObject({ code: 'no-transcript' });
    expect(fetch.calls).toHaveLength(0);
    expect(meter.blocked?.limit).toBe('stt');

    // Another account with minutes left uses the same rung at once (no cooldown was set).
    const other = new UsageMeter(new MemoryKv(), 'acc_2', 'free', plan(), () => T0);
    const ok = await getVideoContext(other.wrapRegistry(registry), APOLLO, { mode: 'stt' }, testContext({ fetch }));
    expect(ok.transcript.origin).toBe('stt');
  });

  it('refuses audio longer than the minutes left', async () => {
    const meter = new UsageMeter(new MemoryKv(), 'acc_1', 'free', plan({ sttMinutesPerDay: 0.2 }), () => T0);
    const rung = meter
      .wrapRegistry(registry)
      .sttRungs({})
      .find((r) => r.service === 'ovh');
    const data = new Uint8Array(readFileSync(APOLLO));
    const audio = { kind: 'bytes' as const, data, mimeType: 'audio/mpeg', filename: 'a.mp3', durationSec: 24.2 };
    await expect(rung?.transcribe(audio, {}, testContext())).rejects.toMatchObject({ code: 'bad-request' });
    expect(meter.blocked?.message).toContain('This audio is 1 min; 0 min are left today.');
  });

  it('counts successful LLM calls and stops at the limit', async () => {
    const meter = new UsageMeter(new MemoryKv(), 'acc_1', 'free', plan({ llmCallsPerDay: 1 }), () => T0);
    const fetch = replayFetch([
      { url: OVH_CHAT, response: { body: read('providers/llm-openai-compatible/test/fixtures/ovh-gpt-oss-120b.json') } },
    ]);
    const ctx = testContext({ fetch, env: { VID2CONTEXT_SKIP: 'pollinations' } });
    const req = { messages: [{ role: 'user' as const, content: 'Which year did Apollo 11 land on the moon?' }] };
    const wrapped = meter.wrapRegistry(registry);
    const res = await chat(wrapped, req, {}, ctx);
    expect(res.text).toContain('1969');
    expect((await meter.read()).llmCalls).toBe(1);
    await expect(chat(wrapped, req, {}, ctx)).rejects.toBeTruthy();
    expect(meter.blocked?.limit).toBe('llm');
    expect((await meter.read()).llmCalls).toBe(1);
  });
});

describe('shared cache', () => {
  it('shares public platforms only, never files or uploads', () => {
    expect(isShareable('youtube:jNQXAC9IVRw')).toBe(true);
    expect(isShareable('vimeo:76979871')).toBe(false);
    expect(isShareable('vimeo:76979871', ['youtube', 'vimeo'])).toBe(true);
    for (const id of ['file:abc', 'upload:abc', 'local:abc', 'jNQXAC9IVRw']) {
      expect(isShareable(id, ['youtube', 'file', 'upload', 'local'])).toBe(false);
    }
  });

  it('serves a public video saved for one user to the next, keyed by mode and language, with a TTL', async () => {
    const kv = new MemoryKv();
    const sets: { key: string; ttlSec?: number }[] = [];
    const recording = Object.assign(Object.create(kv) as MemoryKv, {
      kvSet: (key: string, value: unknown, opts?: { ttlSec?: number }) => {
        sets.push({ key, ttlSec: opts?.ttlSec });
        return kv.kvSet(key, value, opts);
      },
    });
    const innerA = new MemoryStorage();
    await sharedCache(innerA, { kv: recording, userCredentials: false, ttlSec: 3600 }).putContext(zoo);
    expect(await innerA.getContext(zoo.metadata.ref.id)).toEqual(zoo);
    expect(sets).toEqual([
      { key: sharedCacheKey('youtube:jNQXAC9IVRw', 'auto', undefined), ttlSec: 3600 },
      { key: sharedCacheKey('youtube:jNQXAC9IVRw', 'auto', 'en'), ttlSec: 3600 },
    ]);

    const hits: string[] = [];
    const userB = sharedCache(new MemoryStorage(), { kv, userCredentials: false, onHit: (id) => hits.push(id) });
    expect(await userB.getContext('youtube:jNQXAC9IVRw')).toEqual(zoo);
    expect(hits).toEqual(['youtube:jNQXAC9IVRw']);
    expect(
      await sharedCache(new MemoryStorage(), { kv, userCredentials: false, language: 'en' }).getContext(zoo.metadata.ref.id),
    ).toEqual(zoo);
    expect(
      await sharedCache(new MemoryStorage(), { kv, userCredentials: false, language: 'de' }).getContext(zoo.metadata.ref.id),
    ).toBeNull();
    expect(
      await sharedCache(new MemoryStorage(), { kv, userCredentials: false, mode: 'stt' }).getContext(zoo.metadata.ref.id),
    ).toBeNull();
    expect(
      await sharedCache(new MemoryStorage(), { kv, userCredentials: false, refresh: true }).getContext(zoo.metadata.ref.id),
    ).toBeNull();
  });

  it('never shares results fetched with user credentials, and never serves the inner copy of a public video', async () => {
    const kv = new MemoryKv();
    const inner = new MemoryStorage();
    await sharedCache(inner, { kv, userCredentials: true }).putContext(zoo);
    expect((await kv.kvList('cache:shared:')).keys).toEqual([]);
    expect(await inner.getContext(zoo.metadata.ref.id)).toEqual(zoo);
    // The inner storage holds a copy built with someone's own credentials: the shared view does not serve it.
    expect(await sharedCache(inner, { kv, userCredentials: false }).getContext(zoo.metadata.ref.id)).toBeNull();
    // With the user's own credentials the inner storage is used as usual.
    expect(await sharedCache(inner, { kv, userCredentials: true }).getContext(zoo.metadata.ref.id)).toEqual(zoo);
  });

  it('transcribes a local file again for every user and charges each of them', async () => {
    const kv = new MemoryKv();
    const fetch = replayFetch([ovhStt(), ovhStt()]);
    for (const account of ['acc_1', 'acc_2']) {
      const meter = new UsageMeter(kv, account, 'free', plan(), () => T0);
      const storage = sharedCache(new MemoryStorage(), { kv, userCredentials: false, mode: 'stt' });
      const ctx = await getVideoContext(meter.wrapRegistry(registry), APOLLO, { mode: 'stt', storage }, testContext({ fetch }));
      // The probed duration (24.192 s) when ffprobe is reachable, else the last segment end (23.06 s).
      expect((await meter.read()).sttSeconds).toBe(Math.ceil(ctx.metadata.durationSec ?? 23.06));
      expect(storage.stats).toEqual({ hits: 0, misses: 0, writes: 0 });
    }
    expect(fetch.calls).toHaveLength(2);
    expect((await kv.kvList('cache:shared:')).keys).toEqual([]);
  });

  it('serves a cached public video without any network call and without charging minutes', async () => {
    const kv = new MemoryKv();
    await sharedCache(new MemoryStorage(), { kv, userCredentials: false }).putContext(zoo);
    const meter = new UsageMeter(kv, 'acc_2', 'free', plan(), () => T0);
    const storage = sharedCache(new MemoryStorage(), { kv, userCredentials: false });
    // replayFetch with no routes throws on any request.
    const ctx = await getVideoContext(
      meter.wrapRegistry(await withYoutube()),
      'https://youtu.be/jNQXAC9IVRw',
      { storage },
      testContext(),
    );
    expect(ctx).toEqual(zoo);
    expect(storage.stats.hits).toBe(1);
    expect(await meter.read()).toEqual({ requests: 0, sttSeconds: 0, llmCalls: 0 });
  });

  it('keeps the inner KV visible through the wrapper', async () => {
    const plain = sharedCache(new MemoryStorage(), { kv: new MemoryKv(), userCredentials: false });
    expect(typeof plain.kvGet).toBe('undefined');
    const kv = new MemoryKv();
    const withKv = Object.assign(new MemoryStorage(), {
      kvGet: kv.kvGet.bind(kv),
      kvSet: kv.kvSet.bind(kv),
      kvDelete: kv.kvDelete.bind(kv),
      kvList: kv.kvList.bind(kv),
    });
    const wrapped = sharedCache(withKv, { kv, userCredentials: false });
    await wrapped.kvSet?.('config:x', 1);
    expect(await kv.kvGet('config:x')).toBe(1);
  });
});

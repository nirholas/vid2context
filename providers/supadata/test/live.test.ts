import { createContext, Vid2ContextError, type VideoRef } from '@vid2context/core';
import { describe, expect, it } from 'vitest';
import supadata from '../src/index.ts';

// Real network and real credits: about 2 credits per run (one native transcript and
// one 206 "transcript unavailable", 1 credit each per the pricing section of
// https://docs.supadata.ai/get-transcript; the docs do not say whether a 401 is billed).
// Run with LIVE=1 and SUPADATA_API_KEY set (npm run test:live).

const ref = (id: string): VideoRef => ({
  input: id,
  platform: 'youtube',
  kind: 'video',
  id: `youtube:${id}`,
  nativeId: id,
  url: `https://www.youtube.com/watch?v=${id}`,
});

describe.skipIf(!process.env.LIVE || !process.env.SUPADATA_API_KEY)('supadata captions (live)', () => {
  const ctx = (env: Record<string, string | undefined> = process.env) => createContext({ runtime: 'node', env });

  it('returns the English captions of "Me at the zoo"', async () => {
    const t = await supadata.getCaptions(ref('jNQXAC9IVRw'), { language: 'en' }, ctx());
    expect(t).toMatchObject({ origin: 'auto-captions', producer: 'supadata-captions' });
    expect(t?.language.toLowerCase().startsWith('en')).toBe(true);
    expect(t?.segments.length).toBeGreaterThan(2);
    expect(t?.segments.map((s) => s.text).join(' ')).toMatch(/elephant/i);
    for (const s of t?.segments ?? []) expect(s.endSec).toBeGreaterThanOrEqual(s.startSec);
  }, 150_000);

  it('returns null for a video without captions', async () => {
    await expect(supadata.getCaptions(ref('brXcsLhw84o'), {}, ctx())).resolves.toBeNull();
  }, 150_000);

  it('reports a wrong key as auth without echoing it', async () => {
    const bad = 'sd_invalid_key_for_vid2context_live_test';
    const err = await supadata
      .getCaptions(ref('jNQXAC9IVRw'), {}, ctx({ ...process.env, SUPADATA_API_KEY: bad }))
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Vid2ContextError);
    expect((err as Vid2ContextError).code).toBe('auth');
    expect((err as Vid2ContextError).message).not.toContain(bad);
  }, 60_000);
});

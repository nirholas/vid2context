import { createContext, getVideoContext } from '@vid2context/core';
import { createRegistry } from '@vid2context/registry/node';
import { describe, expect, it } from 'vitest';
import { loomCaptionsProvider, matchLoom, matchWistia, wistiaCaptionsProvider } from '../src/index.ts';

// Real network. Run with LIVE=1 (npm run test:live).
describe.skipIf(!process.env.LIVE)('native transcripts (live)', () => {
  const ctx = () => createContext({ runtime: 'node', env: process.env });

  it('resolves a plain vimeo.com URL to vimeo and returns creator captions without speech-to-text', async () => {
    const registry = createRegistry();
    expect(registry.resolve('https://vimeo.com/76979871').source.id).toBe('vimeo');
    const result = await getVideoContext(registry, 'https://vimeo.com/76979871', { mode: 'auto' }, ctx());
    expect(result.metadata.title).toBe('The New Vimeo Player (You Know, For Videos)');
    expect(result.transcript).toMatchObject({ origin: 'creator-captions', producer: 'vimeo-captions', language: 'en' });
    expect(result.transcript.segments.length).toBeGreaterThan(10);
    expect(result.attempts.some((a) => a.stage === 'stt' || a.stage === 'audio')).toBe(false);
  }, 60_000);

  it('fetches Loom captions from a public share page', async () => {
    const ref = matchLoom('https://www.loom.com/share/09b1aa507cb846138847bf8e98b56a71');
    if (!ref) throw new Error('no match');
    const t = await loomCaptionsProvider.getCaptions(ref, {}, ctx());
    expect(t?.origin).toBe('auto-captions');
    expect(t?.segments[0]?.text).toMatch(/potential for greatness/);
  }, 60_000);

  it('fetches Wistia captions for a public media', async () => {
    const ref = matchWistia('https://fast.wistia.net/embed/iframe/i5voqxuarc');
    if (!ref) throw new Error('no match');
    const t = await wistiaCaptionsProvider.getCaptions(ref, { language: 'en' }, ctx());
    expect(t?.language).toBe('en');
    expect(t?.segments.length).toBeGreaterThan(5);
  }, 60_000);
});

import { createContext, expandInput, getVideoContext, Vid2ContextError } from '@vid2context/core';
import { createRegistry } from '@vid2context/registry/node';
import { describe, expect, it } from 'vitest';
import { episodeLocator, matchPodcast, podcastSource, podcastTranscript } from '../src/index.ts';

// Real network. Run with LIVE=1 (npm run test:live).
describe.skipIf(!process.env.LIVE)('podcast (live)', () => {
  const ctx = () => createContext({ runtime: 'node', env: process.env });

  it('lists the Podcasting 2.0 feed and returns a native transcript with chapters and no speech-to-text', async () => {
    const registry = createRegistry();
    const refs = await expandInput(registry, 'http://mp3s.nashownotes.com/pc20rss.xml', ctx(), { limit: 2 });
    expect(refs).toHaveLength(2);
    const first = refs[0];
    if (!first?.url) throw new Error('no episode');
    const result = await getVideoContext(registry, first.url, { mode: 'auto', storage: null }, ctx());
    expect(result.transcript.origin).toBe('native-transcript');
    expect(result.metadata.chapters.length).toBeGreaterThan(3);
    expect(result.attempts.some((a) => a.stage === 'stt' || a.stage === 'audio')).toBe(false);
  }, 120_000);

  it('resolves an Apple Podcasts episode link to its native transcript', async () => {
    const ref = matchPodcast(
      'https://podcasts.apple.com/us/podcast/iheart-the-business-deal-that-doesnt-make-any-sense/id1542481043?i=1000801656977',
    );
    if (!ref) throw new Error('no match');
    const t = await podcastTranscript.getCaptions(ref, {}, ctx());
    expect(t?.origin).toBe('native-transcript');
    expect(t?.segments.length).toBeGreaterThan(100);
  }, 120_000);

  it('resolves a Spotify show link to its RSS feed', async () => {
    const ref = matchPodcast('https://open.spotify.com/show/4rOoJ6Egrf8K2IrywzwOMk');
    if (!ref || !podcastSource.listItems) throw new Error('no match');
    const items = [];
    for await (const item of podcastSource.listItems(ref, ctx(), { limit: 1 })) items.push(item);
    expect(episodeLocator(items[0] ?? ref)?.feedUrl).toBe('https://feeds.megaphone.fm/GLT1412515089');
  }, 120_000);

  it('rejects a Spotify show without a matching public feed', async () => {
    const ref = matchPodcast('https://open.spotify.com/show/5CfCWKI5pZ28U0uOzXkDHe');
    if (!ref || !podcastSource.listItems) throw new Error('no match');
    const run = async () => {
      for await (const _ of podcastSource.listItems?.(ref, ctx()) ?? []) break;
    };
    await expect(run()).rejects.toBeInstanceOf(Vid2ContextError);
  }, 120_000);
});

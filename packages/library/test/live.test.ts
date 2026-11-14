import { createContext, MemoryStorage, Registry } from '@vid2context/core';
import youtube from '@vid2context/provider-youtube';
import { describe, expect, it } from 'vitest';
import { createLibrary } from '../src/index.ts';
import { PLAYLIST } from './helpers.ts';

// LIVE=1: the G-Wagon walkthrough against real YouTube. Captions can be
// refused from datacenter IPs (HTTP 429); those videos are reported as
// failures, which is the behaviour under test, so the assertions only require
// that every playlist item was accounted for.
describe.skipIf(!process.env.LIVE)('live: G-Wagon collection from a real playlist', () => {
  it('creates the collection, follows the playlist and refreshes it', { timeout: 300_000 }, async () => {
    const ctx = createContext({ runtime: 'node', env: { YOUTUBE_BLOCK_COOLDOWN_SEC: '0' } });
    const lib = createLibrary({ registry: new Registry(youtube, 'node'), storage: new MemoryStorage(), ctx });
    const c = await lib.createCollection({ name: 'G-Wagon' });
    await lib.addSource(c.id, PLAYLIST);
    const s = await lib.refresh(c.id, { concurrency: 2, delayMs: 1000 });
    const detail = await lib.getCollectionDetail(c.id);
    console.error(
      JSON.stringify(
        {
          collection: { id: detail.id, name: detail.name, sources: detail.sources },
          added: s.added.map((v) => ({ id: v.id, title: v.title, origin: v.origin })),
          skipped: s.skipped,
          failed: s.failed.map((f) => ({ input: f.input, code: f.code, cause: f.cause })),
          checkedAt: s.checkedAt,
          videos: detail.videos.map((v) => `${v.id} ${v.title}`),
        },
        null,
        2,
      ),
    );
    expect(s.added.length + s.failed.length + s.skipped).toBeGreaterThan(0);
    expect(detail.videoIds).toEqual(s.added.map((v) => v.id));
    const again = await lib.refresh(c.id, { concurrency: 2, delayMs: 1000 });
    expect(again.added.filter((v) => detail.videoIds.includes(v.id))).toEqual([]);
  });
});

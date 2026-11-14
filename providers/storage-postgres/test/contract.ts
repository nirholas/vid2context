/**
 * Storage contract suite, written only against the Storage interface from
 * @vid2context/core with MemoryStorage as the reference behaviour, so it can
 * run on any backend (and be replaced by the shared testkit suite later).
 * Data comes from the real fixture contexts in tests/fixtures/contexts/.
 */
import { type Storage, Vid2ContextError } from '@vid2context/core';
import { afterAll, beforeAll, describe, expect, it as vitestIt } from 'vitest';
import { loadContext } from './fixtures.ts';

const zoo = loadContext('youtube-jNQXAC9IVRw.json');
const gwagon = loadContext('youtube-cCPsdFdlshc.json');
const ZOO = zoo.metadata.ref.id;
const GW = gwagon.metadata.ref.id;

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function expectNotFound(p: Promise<unknown>): Promise<void> {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(Vid2ContextError);
  expect((err as Vid2ContextError).code).toBe('not-found');
  expect((err as Vid2ContextError).hint).toBeTruthy();
}

/**
 * Registers the suite. `open` may resolve to null when the backend is not
 * reachable in this run (a live test without a server); every test is then
 * reported as skipped rather than passed.
 */
export function storageContract(name: string, open: () => Promise<{ storage: Storage; done: () => Promise<void> } | null>): void {
  describe(`Storage contract: ${name}`, () => {
    let storage: Storage;
    let done: (() => Promise<void>) | undefined;
    let available = false;

    beforeAll(async () => {
      const opened = await open();
      if (!opened) return;
      ({ storage, done } = opened);
      available = true;
    }, 120_000);
    afterAll(async () => {
      await done?.();
    });

    const it = (title: string, fn: () => Promise<void>) =>
      vitestIt(title, async (t) => {
        if (!available) t.skip();
        await fn();
      });

    it('returns null for an unknown context', async () => {
      expect(await storage.getContext('youtube:does-not-exist')).toBeNull();
    });

    it('round-trips a context with its raw transcript intact', async () => {
      await storage.putContext(zoo);
      const back = await storage.getContext(ZOO);
      expect(back).toEqual(zoo);
      expect(back?.transcript.segments).toHaveLength(zoo.transcript.segments.length);
    });

    it('upserts on a second put instead of duplicating', async () => {
      await storage.putContext({ ...zoo, metadata: { ...zoo.metadata, title: 'Renamed' } });
      expect((await storage.getContext(ZOO))?.metadata.title).toBe('Renamed');
      await storage.putContext(zoo);
      const page = await storage.listContexts();
      expect(page.items.filter((s) => s.id === ZOO)).toHaveLength(1);
    });

    it('lists newest first with summaries and pages through every item once', async () => {
      await pause(5);
      await storage.putContext(gwagon);
      const page = await storage.listContexts();
      expect(page.items.map((s) => s.id)).toEqual([GW, ZOO]);
      const g = page.items[0];
      expect(g).toMatchObject({
        id: GW,
        ref: gwagon.metadata.ref,
        title: gwagon.metadata.title,
        channel: gwagon.metadata.channel?.name,
        durationSec: gwagon.metadata.durationSec,
        origin: 'auto-captions',
        language: 'en',
      });
      expect(Number.isNaN(Date.parse(g?.savedAt ?? ''))).toBe(false);

      const first = await storage.listContexts({ limit: 1 });
      expect(first.items.map((s) => s.id)).toEqual([GW]);
      expect(first.cursor).toBeTruthy();
      const second = await storage.listContexts({ limit: 1, cursor: first.cursor });
      expect(second.items.map((s) => s.id)).toEqual([ZOO]);
      expect(second.cursor).toBeUndefined();
    });

    it('finds segments by keyword and honours filters and limit', async () => {
      const hits = await storage.search({ text: 'elephants' });
      expect(hits.length).toBeGreaterThan(0);
      expect(hits[0]).toMatchObject({ videoId: ZOO, title: zoo.metadata.title });
      expect(hits[0]?.text.toLowerCase()).toContain('elephants');
      expect(typeof hits[0]?.startSec).toBe('number');

      const trans = await storage.search({ text: 'transmission' });
      expect(trans.length).toBeGreaterThan(0);
      expect(trans.every((h) => h.videoId === GW)).toBe(true);

      expect(await storage.search({ text: 'transmission', videoIds: [ZOO] })).toEqual([]);
      expect((await storage.search({ text: 'engine', limit: 2 })).length).toBeLessThanOrEqual(2);
      expect(await storage.search({ text: '   ' })).toEqual([]);
      expect(await storage.search({ text: 'elephants', collectionId: 'no-such-collection' })).toEqual([]);
    });

    it('creates, reads, updates and lists collections', async () => {
      const c = await storage.createCollection({ name: 'G-Wagon research', description: 'Buyer guides' });
      expect(c).toMatchObject({ name: 'G-Wagon research', description: 'Buyer guides', sources: [], videoIds: [] });
      expect(c.id).toMatch(/^g-wagon-research-[0-9a-f]{8}$/);
      expect(await storage.getCollection(c.id)).toEqual(c);
      expect(await storage.getCollection('missing-collection')).toBeNull();

      await pause(5);
      const updated = await storage.updateCollection(c.id, {
        name: 'G-Wagon',
        sources: ['https://www.youtube.com/playlist?list=PLx'],
      });
      expect(updated).toMatchObject({ id: c.id, name: 'G-Wagon', description: 'Buyer guides', sources: ['https://www.youtube.com/playlist?list=PLx'] });
      expect(updated.updatedAt >= c.updatedAt).toBe(true);
      expect(updated.createdAt).toBe(c.createdAt);

      await pause(5);
      const other = await storage.createCollection({ name: 'Zoo', sources: ['a', 'b'] });
      expect(other.sources).toEqual(['a', 'b']);
      const list = await storage.listCollections();
      expect(list.map((x) => x.id).slice(0, 2)).toEqual([other.id, c.id]);
      await storage.deleteCollection(other.id);
      expect(await storage.getCollection(other.id)).toBeNull();
      await storage.deleteCollection('missing-collection');
    });

    it('keeps collection order, ignores duplicates and filters search by collection', async () => {
      const c = await storage.createCollection({ name: 'Mixed' });
      let after = await storage.addToCollection(c.id, [GW, ZOO, GW]);
      expect(after.videoIds).toEqual([GW, ZOO]);
      after = await storage.addToCollection(c.id, [ZOO, 'youtube:later']);
      expect(after.videoIds).toEqual([GW, ZOO, 'youtube:later']);
      after = await storage.removeFromCollection(c.id, [ZOO]);
      expect(after.videoIds).toEqual([GW, 'youtube:later']);
      expect(await storage.search({ text: 'elephants', collectionId: c.id })).toEqual([]);
      expect((await storage.search({ text: 'transmission', collectionId: c.id })).length).toBeGreaterThan(0);
      await storage.deleteCollection(c.id);
    });

    it('throws not-found with a hint for unknown collection ids', async () => {
      await expectNotFound(storage.updateCollection('missing-collection', { name: 'x' }));
      await expectNotFound(storage.addToCollection('missing-collection', [ZOO]));
      await expectNotFound(storage.removeFromCollection('missing-collection', [ZOO]));
    });

    it('deletes a context, its search hits and its collection membership', async () => {
      const c = await storage.createCollection({ name: 'Doomed' });
      await storage.addToCollection(c.id, [ZOO, GW]);
      await storage.deleteContext(ZOO);
      expect(await storage.getContext(ZOO)).toBeNull();
      expect(await storage.search({ text: 'elephants' })).toEqual([]);
      expect((await storage.getCollection(c.id))?.videoIds).toEqual([GW]);
      expect((await storage.listContexts()).items.map((s) => s.id)).toEqual([GW]);
      await storage.deleteContext('youtube:never-saved');
    });
  });
}

/**
 * The Storage contract, written against the interface and mirroring
 * MemoryStorage in packages/core/src/storage.ts, so any backend can run it.
 * Prompt 23's shared suite can replace this file later.
 */
import { readFileSync } from 'node:fs';
import { type Storage, Vid2ContextError, type VideoContext } from '@vid2context/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

export function fixtureContext(name: 'youtube-jNQXAC9IVRw' | 'youtube-cCPsdFdlshc'): VideoContext {
  return JSON.parse(
    readFileSync(new URL(`../../../tests/fixtures/contexts/${name}.json`, import.meta.url), 'utf8'),
  ) as VideoContext;
}

const tick = () => new Promise((r) => setTimeout(r, 3));

export function storageContract(label: string, open: () => Promise<Storage>, close: (s: Storage) => Promise<void>): void {
  describe(`Storage contract: ${label}`, () => {
    let storage: Storage;
    const zoo = fixtureContext('youtube-jNQXAC9IVRw');
    const gwagon = fixtureContext('youtube-cCPsdFdlshc');

    beforeEach(async () => {
      storage = await open();
    });
    afterEach(async () => {
      await close(storage);
    });

    it('round-trips a full context, raw transcript included', async () => {
      expect(await storage.getContext(zoo.metadata.ref.id)).toBeNull();
      await storage.putContext(zoo);
      expect(await storage.getContext(zoo.metadata.ref.id)).toEqual(zoo);
    });

    it('replaces a context on a second put', async () => {
      await storage.putContext(gwagon);
      const shorter: VideoContext = {
        ...gwagon,
        transcript: { ...gwagon.transcript, segments: gwagon.transcript.segments.slice(0, 3) },
      };
      await storage.putContext(shorter);
      expect((await storage.getContext(gwagon.metadata.ref.id))?.transcript.segments).toHaveLength(3);
      const page = await storage.listContexts();
      expect(page.items.map((s) => s.id)).toEqual([gwagon.metadata.ref.id]);
      // Segments that were dropped are no longer searchable.
      expect(await storage.search({ text: 'legendary' })).toEqual([]);
    });

    it('lists summaries newest first with a cursor', async () => {
      await storage.putContext(zoo);
      await tick();
      await storage.putContext(gwagon);
      const first = await storage.listContexts({ limit: 1 });
      expect(first.items).toHaveLength(1);
      expect(first.items[0]).toMatchObject({
        id: gwagon.metadata.ref.id,
        title: gwagon.metadata.title,
        origin: gwagon.transcript.origin,
        language: gwagon.transcript.language,
      });
      expect(first.items[0]?.ref).toEqual(gwagon.metadata.ref);
      expect(first.items[0]?.savedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(first.cursor).toBeTypeOf('string');
      const second = await storage.listContexts({ limit: 1, cursor: first.cursor });
      expect(second.items.map((s) => s.id)).toEqual([zoo.metadata.ref.id]);
      expect(second.cursor).toBeUndefined();
      const all = await storage.listContexts();
      expect(all.items.map((s) => s.id)).toEqual([gwagon.metadata.ref.id, zoo.metadata.ref.id]);
      expect(all.cursor).toBeUndefined();
    });

    it('creates, reads, updates and lists collections', async () => {
      const c = await storage.createCollection({ name: 'G-Wagon research', sources: ['https://www.youtube.com/@gwagon'] });
      expect(c.id).toMatch(/^g-wagon-research-[0-9a-f]{8}$/);
      expect(c).toMatchObject({ name: 'G-Wagon research', sources: ['https://www.youtube.com/@gwagon'], videoIds: [] });
      expect(c.createdAt).toBe(c.updatedAt);
      expect(await storage.getCollection(c.id)).toEqual(c);
      expect(await storage.getCollection('missing')).toBeNull();
      // MemoryStorage returns its live object, so copy the timestamp before updating.
      const createdUpdatedAt = c.updatedAt;

      await tick();
      const updated = await storage.updateCollection(c.id, { description: 'Buyer guides' });
      expect(updated).toMatchObject({ name: 'G-Wagon research', description: 'Buyer guides' });
      expect(updated.updatedAt > createdUpdatedAt).toBe(true);

      await tick();
      const other = await storage.createCollection({ name: 'Zoo' });
      expect((await storage.listCollections()).map((x) => x.id)).toEqual([other.id, c.id]);
    });

    it('keeps collection items ordered and unique', async () => {
      const c = await storage.createCollection({ name: 'Mixed' });
      await storage.addToCollection(c.id, ['youtube:b', 'youtube:a']);
      const after = await storage.addToCollection(c.id, ['youtube:a', 'youtube:c']);
      expect(after.videoIds).toEqual(['youtube:b', 'youtube:a', 'youtube:c']);
      const removed = await storage.removeFromCollection(c.id, ['youtube:a']);
      expect(removed.videoIds).toEqual(['youtube:b', 'youtube:c']);
      expect((await storage.getCollection(c.id))?.videoIds).toEqual(['youtube:b', 'youtube:c']);
    });

    it('removes a deleted context from collections', async () => {
      await storage.putContext(zoo);
      const c = await storage.createCollection({ name: 'Zoo' });
      await storage.addToCollection(c.id, [zoo.metadata.ref.id, 'youtube:other']);
      await storage.deleteContext(zoo.metadata.ref.id);
      expect(await storage.getContext(zoo.metadata.ref.id)).toBeNull();
      expect((await storage.getCollection(c.id))?.videoIds).toEqual(['youtube:other']);
      expect(await storage.search({ text: 'elephants' })).toEqual([]);
    });

    it('throws not-found with a hint for unknown collection ids', async () => {
      for (const call of [
        () => storage.updateCollection('nope', { name: 'x' }),
        () => storage.addToCollection('nope', ['youtube:a']),
        () => storage.removeFromCollection('nope', ['youtube:a']),
      ]) {
        const err = await call().catch((e: unknown) => e);
        expect(err).toBeInstanceOf(Vid2ContextError);
        expect(err).toMatchObject({ code: 'not-found' });
        expect((err as Vid2ContextError).hint).toBeTruthy();
      }
      await expect(storage.deleteCollection('nope')).resolves.toBeUndefined();
    });

    it('deletes collections', async () => {
      const c = await storage.createCollection({ name: 'Temp' });
      await storage.addToCollection(c.id, ['youtube:a']);
      await storage.deleteCollection(c.id);
      expect(await storage.getCollection(c.id)).toBeNull();
      expect(await storage.listCollections()).toEqual([]);
    });

    it('searches saved transcripts, filtered by collection and video ids', async () => {
      await storage.putContext(zoo);
      await storage.putContext(gwagon);
      const hits = await storage.search({ text: 'elephants' });
      expect(hits).toHaveLength(1);
      expect(hits[0]).toMatchObject({
        videoId: zoo.metadata.ref.id,
        title: 'Me at the zoo',
        startSec: 1.2,
        text: 'All right, so here we are, in front of the elephants',
      });
      expect(hits[0]?.score).toBeGreaterThan(0);

      // "cool" occurs in both transcripts.
      const both = await storage.search({ text: 'cool', limit: 50 });
      expect(new Set(both.map((h) => h.videoId))).toEqual(new Set([zoo.metadata.ref.id, gwagon.metadata.ref.id]));
      const onlyZoo = await storage.search({ text: 'cool', videoIds: [zoo.metadata.ref.id] });
      expect(onlyZoo.map((h) => h.startSec).sort((a, b) => a - b)).toEqual([5.318, 12.616]);

      const c = await storage.createCollection({ name: 'G' });
      await storage.addToCollection(c.id, [gwagon.metadata.ref.id]);
      const inCollection = await storage.search({ text: 'cool', collectionId: c.id, limit: 50 });
      expect(inCollection.length).toBeGreaterThan(0);
      expect(inCollection.every((h) => h.videoId === gwagon.metadata.ref.id)).toBe(true);
      expect(await storage.search({ text: 'cool', collectionId: 'missing' })).toEqual([]);

      expect(await storage.search({ text: 'cool', limit: 2 })).toHaveLength(2);
      expect(await storage.search({ text: '   ' })).toEqual([]);
    });
  });
}

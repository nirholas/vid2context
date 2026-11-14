/**
 * Conformance suite for Storage backends, plus the optional KvStore and
 * VectorStore contracts from packages/core/src/storage-ext.ts. Every test gets
 * a fresh backend from the factory and uses the real VideoContext fixtures in
 * tests/fixtures/contexts.
 */
import { hasKv, hasVectors, type Storage, type VectorRecord, type VideoContext, Vid2ContextError } from '@vid2context/core';
import { describe, expect, it } from 'vitest';
import { loadContextFixture } from './fixtures.ts';

export type StorageFactory = () => Storage | Promise<Storage>;

export interface StorageSuiteOptions {
  /** Label for the describe block. Default 'backend'. */
  name?: string;
  /** Called after each test with the backend it used (close connections, delete temp files). */
  cleanup?: (storage: Storage) => void | Promise<void>;
  /** Seconds to wait for a 1-second TTL to expire. Default 2.1 (covers backends with whole-second clocks). */
  ttlWaitSec?: number;
}

const ZOO = 'youtube-jNQXAC9IVRw.json';
const GWAGON = 'youtube-cCPsdFdlshc.json';

/** Fresh deep copies, so a backend that keeps references cannot leak state between tests. */
const zoo = (): VideoContext => structuredClone(loadContextFixture(ZOO));
const gwagon = (): VideoContext => structuredClone(loadContextFixture(GWAGON));

/**
 * A 26-dimension letter-frequency vector of real transcript text. Not a
 * semantic embedding: it gives the vector contract deterministic inputs
 * derived from real data, where the nearest vector to a text is its own.
 */
export function letterVector(text: string): number[] {
  const v = new Array<number>(26).fill(0);
  for (const ch of text.toLowerCase()) {
    const i = ch.charCodeAt(0) - 97;
    if (i >= 0 && i < 26) v[i] = (v[i] ?? 0) + 1;
  }
  return v;
}

function vectorRecords(context: VideoContext, model: string, count = 8): VectorRecord[] {
  return context.transcript.segments.slice(0, count).map((s) => ({
    id: `${context.metadata.ref.id}#${s.startSec}`,
    videoId: context.metadata.ref.id,
    startSec: s.startSec,
    endSec: s.endSec,
    text: s.text,
    model,
    vector: letterVector(s.text),
  }));
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function describeStorage(factory: StorageFactory, opts: StorageSuiteOptions = {}): void {
  const withStorage = async (fn: (s: Storage) => Promise<void>) => {
    const s = await factory();
    try {
      await fn(s);
    } finally {
      await opts.cleanup?.(s);
    }
  };

  describe(`storage conformance: ${opts.name ?? 'backend'}`, () => {
    describe('contexts', () => {
      it('names its backend', () =>
        withStorage(async (s) => {
          expect(typeof s.backend).toBe('string');
          expect(s.backend.length).toBeGreaterThan(0);
        }));

      it('round-trips a real VideoContext deep-equal and returns null for unknown ids', () =>
        withStorage(async (s) => {
          for (const c of [zoo(), gwagon()]) {
            await s.putContext(c);
            expect(await s.getContext(c.metadata.ref.id)).toEqual(c);
          }
          expect(await s.getContext('youtube:does-not-exist')).toBeNull();
        }));

      it('overwrites on a second put with the same id', () =>
        withStorage(async (s) => {
          const c = zoo();
          await s.putContext(c);
          const changed = { ...c, metadata: { ...c.metadata, title: `${c.metadata.title} (re-fetched)` } };
          await s.putContext(changed);
          expect((await s.getContext(c.metadata.ref.id))?.metadata.title).toBe(changed.metadata.title);
          expect((await s.listContexts()).items.filter((i) => i.id === c.metadata.ref.id)).toHaveLength(1);
        }));

      it('lists summaries and pages with cursors', () =>
        withStorage(async (s) => {
          const a = zoo();
          const b = gwagon();
          await s.putContext(a);
          await s.putContext(b);
          const all = await s.listContexts();
          expect(all.items.map((i) => i.id).sort()).toEqual([a.metadata.ref.id, b.metadata.ref.id].sort());
          for (const item of all.items) {
            expect(item.title.length).toBeGreaterThan(0);
            expect(Number.isNaN(Date.parse(item.savedAt))).toBe(false);
            expect(item.ref.id).toBe(item.id);
          }
          const zooSummary = all.items.find((i) => i.id === a.metadata.ref.id);
          expect(zooSummary).toMatchObject({ title: a.metadata.title, origin: a.transcript.origin, language: a.transcript.language });

          const first = await s.listContexts({ limit: 1 });
          expect(first.items).toHaveLength(1);
          expect(first.cursor, 'a full first page must return a cursor').toBeTruthy();
          const second = await s.listContexts({ limit: 1, cursor: first.cursor });
          expect(second.items).toHaveLength(1);
          expect(second.cursor, 'the last page must not return a cursor').toBeFalsy();
          expect(new Set([...first.items, ...second.items].map((i) => i.id)).size).toBe(2);
        }));

      it('deletes a context and removes it from every collection', () =>
        withStorage(async (s) => {
          const c = zoo();
          const keep = gwagon();
          await s.putContext(c);
          await s.putContext(keep);
          const col = await s.createCollection({ name: 'Cascade' });
          await s.addToCollection(col.id, [c.metadata.ref.id, keep.metadata.ref.id]);
          await s.deleteContext(c.metadata.ref.id);
          expect(await s.getContext(c.metadata.ref.id)).toBeNull();
          expect((await s.getCollection(col.id))?.videoIds).toEqual([keep.metadata.ref.id]);
          expect((await s.listContexts()).items.map((i) => i.id)).toEqual([keep.metadata.ref.id]);
          await s.deleteContext(c.metadata.ref.id);
        }));
    });

    describe('collections', () => {
      it('runs the full lifecycle: create, get, list, update, delete', () =>
        withStorage(async (s) => {
          const col = await s.createCollection({ name: 'Car videos', description: 'G-Wagon research', sources: [] });
          expect(col.id.length).toBeGreaterThan(0);
          expect(col).toMatchObject({ name: 'Car videos', description: 'G-Wagon research', sources: [], videoIds: [] });
          expect(Number.isNaN(Date.parse(col.createdAt))).toBe(false);
          expect(await s.getCollection(col.id)).toMatchObject({ id: col.id, name: 'Car videos' });
          expect((await s.listCollections()).map((c) => c.id)).toContain(col.id);

          const updated = await s.updateCollection(col.id, {
            name: 'G-Wagon',
            sources: ['https://www.youtube.com/playlist?list=PLHeawKfarQSPKIjpe86at3Ttc2sz7uD_b'],
          });
          expect(updated).toMatchObject({ id: col.id, name: 'G-Wagon', description: 'G-Wagon research' });
          expect(updated.sources).toHaveLength(1);
          expect((await s.getCollection(col.id))?.name).toBe('G-Wagon');

          await s.deleteCollection(col.id);
          expect(await s.getCollection(col.id)).toBeNull();
          expect((await s.listCollections()).map((c) => c.id)).not.toContain(col.id);
        }));

      it('adds and removes videos idempotently', () =>
        withStorage(async (s) => {
          const a = zoo().metadata.ref.id;
          const b = gwagon().metadata.ref.id;
          const col = await s.createCollection({ name: 'Idempotent' });
          await s.addToCollection(col.id, [a, b]);
          const again = await s.addToCollection(col.id, [a]);
          expect([...again.videoIds].sort()).toEqual([a, b].sort());
          await s.removeFromCollection(col.id, [a]);
          const removedTwice = await s.removeFromCollection(col.id, [a]);
          expect(removedTwice.videoIds).toEqual([b]);
          expect((await s.getCollection(col.id))?.videoIds).toEqual([b]);
        }));

      it('throws a not-found Vid2ContextError with a hint for unknown collections', () =>
        withStorage(async (s) => {
          for (const call of [
            () => s.addToCollection('no-such-collection', ['youtube:jNQXAC9IVRw']),
            () => s.removeFromCollection('no-such-collection', ['youtube:jNQXAC9IVRw']),
            () => s.updateCollection('no-such-collection', { name: 'x' }),
          ]) {
            const err = await call().then(
              () => undefined,
              (e: unknown) => e,
            );
            expect(err).toBeInstanceOf(Vid2ContextError);
            expect((err as Vid2ContextError).code).toBe('not-found');
            expect((err as Vid2ContextError).hint).toBeTruthy();
          }
          expect(await s.getCollection('no-such-collection')).toBeNull();
        }));
    });

    describe('search', () => {
      it('finds a known phrase in a real transcript and scopes by collection and video', () =>
        withStorage(async (s) => {
          const a = zoo();
          const b = gwagon();
          await s.putContext(a);
          await s.putContext(b);
          const hits = await s.search({ text: 'elephants' });
          const hit = hits.find((h) => h.videoId === a.metadata.ref.id);
          expect(hit, 'search did not find "elephants" in "Me at the zoo"').toBeDefined();
          expect(hit?.text.toLowerCase()).toContain('elephants');
          expect(hit?.title).toBe(a.metadata.title);
          expect(hit && hit.endSec >= hit.startSec).toBe(true);

          const engine = await s.search({ text: 'm113 engine' });
          expect(engine.some((h) => h.videoId === b.metadata.ref.id && h.text.toLowerCase().includes('m113'))).toBe(true);

          const col = await s.createCollection({ name: 'Only G-Wagon' });
          await s.addToCollection(col.id, [b.metadata.ref.id]);
          expect(await s.search({ text: 'elephants', collectionId: col.id })).toEqual([]);
          expect(await s.search({ text: 'elephants', videoIds: [b.metadata.ref.id] })).toEqual([]);
          expect((await s.search({ text: 'engine', limit: 2 })).length).toBeLessThanOrEqual(2);
        }));
    });

    describe('KvStore (when implemented)', () => {
      it('round-trips JSON values, overwrites and deletes', (t) =>
        withStorage(async (s) => {
          if (!hasKv(s)) return t.skip();
          const value = { videoId: zoo().metadata.ref.id, chapters: zoo().metadata.chapters };
          await s.kvSet('conformance:a', value);
          expect(await s.kvGet('conformance:a')).toEqual(value);
          await s.kvSet('conformance:a', [1, 'two', null]);
          expect(await s.kvGet('conformance:a')).toEqual([1, 'two', null]);
          await s.kvDelete('conformance:a');
          expect(await s.kvGet('conformance:a')).toBeNull();
          expect(await s.kvGet('conformance:missing')).toBeNull();
        }));

      it('expires values after their TTL', (t) =>
        withStorage(async (s) => {
          if (!hasKv(s)) return t.skip();
          await s.kvSet('ttl:short', 'gone soon', { ttlSec: 1 });
          await s.kvSet('ttl:kept', 'stays');
          expect(await s.kvGet('ttl:short')).toBe('gone soon');
          await sleep((opts.ttlWaitSec ?? 2.1) * 1000);
          expect(await s.kvGet('ttl:short')).toBeNull();
          expect(await s.kvGet('ttl:kept')).toBe('stays');
          expect((await s.kvList('ttl:')).keys).toEqual(['ttl:kept']);
        }));

      it('lists keys by prefix in lexical order and pages with cursors', (t) =>
        withStorage(async (s) => {
          if (!hasKv(s)) return t.skip();
          const keys = ['watch:e', 'watch:a', 'watch:c', 'watch:b', 'watch:d'];
          for (const k of keys) await s.kvSet(k, k);
          await s.kvSet('jobs:1', 1);
          await s.kvSet('watcher', 'not under the prefix "watch:"');
          expect((await s.kvList('watch:')).keys).toEqual([...keys].sort());
          const seen: string[] = [];
          let cursor: string | undefined;
          let pages = 0;
          do {
            const page = await s.kvList('watch:', { limit: 2, cursor });
            expect(page.keys.length).toBeLessThanOrEqual(2);
            seen.push(...page.keys);
            cursor = page.cursor;
            pages++;
          } while (cursor && pages < 10);
          expect(seen).toEqual([...keys].sort());
          expect(pages).toBe(3);
        }));
    });

    describe('VectorStore (when implemented)', () => {
      it('ranks the nearest vector first and returns cosine scores', (t) =>
        withStorage(async (s) => {
          if (!hasVectors(s)) return t.skip();
          const records = vectorRecords(gwagon(), 'conformance/letters');
          await s.upsertVectors(records);
          const target = records[3];
          if (!target) throw new Error('fixture has too few segments');
          const hits = await s.queryVectors({ vector: target.vector, model: 'conformance/letters', limit: 3 });
          expect(hits).toHaveLength(3);
          expect(hits[0]?.id).toBe(target.id);
          expect(hits[0]?.score).toBeCloseTo(1, 5);
          for (let i = 1; i < hits.length; i++) expect(hits[i]?.score ?? 0).toBeLessThanOrEqual(hits[i - 1]?.score ?? 0);
          for (const h of hits) expect(h.score >= -1 - 1e-9 && h.score <= 1 + 1e-9).toBe(true);
          expect(hits[0]).toMatchObject({ videoId: target.videoId, startSec: target.startSec, endSec: target.endSec, text: target.text });
        }));

      it('overwrites on upsert with the same id and model', (t) =>
        withStorage(async (s) => {
          if (!hasVectors(s)) return t.skip();
          const [first, second] = vectorRecords(gwagon(), 'conformance/letters', 2);
          if (!first || !second) throw new Error('fixture has too few segments');
          await s.upsertVectors([first]);
          await s.upsertVectors([{ ...first, text: second.text, vector: second.vector }]);
          const hits = await s.queryVectors({ vector: second.vector, model: 'conformance/letters' });
          expect(hits).toHaveLength(1);
          expect(hits[0]).toMatchObject({ id: first.id, text: second.text });
          expect(hits[0]?.score).toBeCloseTo(1, 5);
        }));

      it('keeps models isolated and deletes by video and model', (t) =>
        withStorage(async (s) => {
          if (!hasVectors(s)) return t.skip();
          const z = zoo();
          const g = gwagon();
          await s.upsertVectors([...vectorRecords(z, 'model-a'), ...vectorRecords(g, 'model-a'), ...vectorRecords(z, 'model-b')]);
          const q = letterVector(z.transcript.segments[0]?.text ?? 'elephants');
          const onlyB = await s.queryVectors({ vector: q, model: 'model-b', limit: 100 });
          expect(onlyB.length).toBe(vectorRecords(z, 'model-b').length);
          expect(onlyB.every((h) => h.videoId === z.metadata.ref.id)).toBe(true);

          const scoped = await s.queryVectors({ vector: q, model: 'model-a', videoIds: [g.metadata.ref.id], limit: 100 });
          expect(scoped.length).toBeGreaterThan(0);
          expect(scoped.every((h) => h.videoId === g.metadata.ref.id)).toBe(true);

          await s.deleteVectors({ videoId: z.metadata.ref.id, model: 'model-a' });
          const a = await s.queryVectors({ vector: q, model: 'model-a', limit: 100 });
          expect(a.every((h) => h.videoId === g.metadata.ref.id)).toBe(true);
          expect((await s.queryVectors({ vector: q, model: 'model-b', limit: 100 })).length).toBe(onlyB.length);

          await s.deleteVectors({ videoId: z.metadata.ref.id });
          expect(await s.queryVectors({ vector: q, model: 'model-b', limit: 100 })).toEqual([]);
        }));
    });
  });
}

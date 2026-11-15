import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MEMORY_STORAGE_MAX_CONTEXTS, MemoryStorage } from '../src/storage.ts';
import { MemoryKv } from '../src/storage-ext.ts';
import type { VideoContext } from '../src/types.ts';

const load = (f: string): VideoContext =>
  JSON.parse(readFileSync(new URL(`../../../tests/fixtures/contexts/${f}`, import.meta.url), 'utf8'));
const zoo = load('youtube-jNQXAC9IVRw.json');
const gwagon = load('youtube-cCPsdFdlshc.json');
const zooId = zoo.metadata.ref.id;
const gwagonId = gwagon.metadata.ref.id;

describe('MemoryStorage bounds', () => {
  it('keeps at most maxContexts and evicts the least recently used', async () => {
    const s = new MemoryStorage({ maxContexts: 1 });
    await s.putContext(zoo);
    await s.putContext(gwagon);
    expect(await s.getContext(zooId)).toBeNull();
    expect((await s.getContext(gwagonId))?.metadata.title).toBe(gwagon.metadata.title);
    expect((await s.listContexts()).items).toHaveLength(1);
  });

  it('counts a read as use, so a recently read context survives', async () => {
    // The same real context saved under a second id (as a translated copy would be) gives a third entry.
    const zooDe: VideoContext = { ...zoo, metadata: { ...zoo.metadata, ref: { ...zoo.metadata.ref, id: `${zooId}:de` } } };
    const s = new MemoryStorage({ maxContexts: 2 });
    await s.putContext(zoo);
    await s.putContext(gwagon);
    await s.getContext(zooId);
    await s.putContext(zooDe);
    // zoo was older than gwagon by write, but was read since, so gwagon is the least recently used.
    expect(await s.getContext(zooId)).not.toBeNull();
    expect(await s.getContext(gwagonId)).toBeNull();
    expect(await s.getContext(`${zooId}:de`)).not.toBeNull();
  });

  it('prefers evicting contexts that no collection lists', async () => {
    const s = new MemoryStorage({ maxContexts: 1 });
    await s.putContext(zoo);
    const c = await s.createCollection({ name: 'Keep' });
    await s.addToCollection(c.id, [zooId]);
    await s.putContext(gwagon);
    // Both cannot fit; the unlisted gwagon is the one dropped even though it is newer.
    expect(await s.getContext(zooId)).not.toBeNull();
    expect(await s.getContext(gwagonId)).toBeNull();
  });

  it('falls back to a sane default for a bad cap', async () => {
    const s = new MemoryStorage({ maxContexts: Number.NaN });
    await s.putContext(zoo);
    await s.putContext(gwagon);
    expect((await s.listContexts()).items).toHaveLength(2);
    expect(MEMORY_STORAGE_MAX_CONTEXTS).toBeGreaterThan(2);
  });
});

describe('MemoryKv bounds', () => {
  afterEach(() => vi.useRealTimers());

  it('sweeps expired keys on later writes, not only when they are read', async () => {
    vi.useFakeTimers();
    const kv = new MemoryKv();
    for (let i = 0; i < 300; i++) await kv.kvSet(`ratelimit:ip:10.0.${i >> 8}.${i & 255}`, { tokens: 1 }, { ttlSec: 60 });
    expect(kv.size).toBe(300);
    vi.advanceTimersByTime(61_000);
    // 212 more writes reach the 512-write sweep; the 300 expired buckets go without ever being read.
    for (let i = 0; i < 212; i++) await kv.kvSet(`job:${i}`, { i });
    expect(kv.size).toBe(212);
  });

  it('caps the number of entries, dropping the oldest written', async () => {
    const kv = new MemoryKv({ maxEntries: 3 });
    for (const k of ['a', 'b', 'c', 'd']) await kv.kvSet(k, k);
    expect(kv.size).toBe(3);
    expect(await kv.kvGet('a')).toBeNull();
    expect(await kv.kvGet('d')).toBe('d');
    // Rewriting a key makes it newest.
    await kv.kvSet('b', 'b2');
    await kv.kvSet('e', 'e');
    expect(await kv.kvGet('c')).toBeNull();
    expect(await kv.kvGet('b')).toBe('b2');
  });
});

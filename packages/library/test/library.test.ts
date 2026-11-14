import { Vid2ContextError } from '@vid2context/core';
import { describe, expect, it } from 'vitest';
import type { Progress } from '../src/index.ts';
import { browseCalls, GWAGON, PLAYLIST, PLAYLIST_SIZE, setup, ZOO } from './helpers.ts';

// Real recorded responses (test/fixtures/README.md): the G-Wagon playlist has
// 9 videos. Captions for "Best & Worst G-Wagon Years" were recorded while
// YouTube served them; the other 8 caption downloads were answered with
// YouTube's real HTTP 429 datacenter block, so they fail as no-transcript.

async function rejects(p: Promise<unknown>): Promise<Vid2ContextError> {
  try {
    await p;
  } catch (err) {
    if (err instanceof Vid2ContextError) return err;
    throw err;
  }
  throw new Error('expected a rejection');
}

describe('sources', () => {
  it('accepts a playlist, deduplicates other spellings of it, and removes it', async () => {
    const { lib } = setup();
    const c = await lib.createCollection({ name: 'G-Wagon' });
    expect((await lib.addSource(c.id, PLAYLIST)).sources).toEqual([PLAYLIST]);
    const again = await lib.addSource(c.id, 'https://m.youtube.com/playlist?list=PLHeawKfarQSPKIjpe86at3Ttc2sz7uD_b');
    expect(again.sources).toEqual([PLAYLIST]);
    expect((await lib.removeSource(c.id, 'youtube.com/playlist?list=PLHeawKfarQSPKIjpe86at3Ttc2sz7uD_b')).sources).toEqual([]);
  });

  it('rejects single videos and inputs no source understands, with hints', async () => {
    const { lib } = setup();
    const c = await lib.createCollection({ name: 'G-Wagon' });
    const video = await rejects(lib.addSource(c.id, 'https://www.youtube.com/watch?v=cCPsdFdlshc'));
    expect(video.code).toBe('bad-request');
    expect(video.hint).toMatch(/items/);
    const unknown = await rejects(lib.addSource(c.id, 'not a url at all'));
    expect(unknown.code).toBe('unsupported-input');
    expect(unknown.hint).toBeTruthy();
    expect((await rejects(lib.createCollection({ name: ' ' }))).code).toBe('bad-request');
    expect((await rejects(lib.createCollection({ name: 'x', sources: ['jNQXAC9IVRw'] }))).code).toBe('bad-request');
    expect((await rejects(lib.addSource('missing', PLAYLIST))).code).toBe('not-found');
  });
});

describe('refresh', () => {
  it('ingests the playlist through the real pipeline and captures each failure without stopping', async () => {
    const { lib, storage } = setup();
    const c = await lib.createCollection({ name: 'G-Wagon', sources: [PLAYLIST] });
    const events: Progress[] = [];
    const s = await lib.refresh(c.id, { delayMs: 0, onProgress: (p) => events.push(p) });

    expect(s.added.map((a) => a.id)).toEqual([GWAGON]);
    expect(s.added[0]?.title).toMatch(/G-Wagon Years/);
    expect(s.added[0]?.origin).toBe('auto-captions');
    expect(s.skipped).toBe(0);
    expect(s.remaining).toBe(0);
    expect(s.failed).toHaveLength(PLAYLIST_SIZE - 1);
    for (const f of s.failed) {
      expect(f.code).toBe('no-transcript');
      expect(f.hint).toBeTruthy();
      expect(f.cause).toMatch(/blocked/);
      expect(f.input).toMatch(/^https:\/\/www\.youtube\.com\/watch\?v=/);
    }
    expect((await storage.getCollection(c.id))?.videoIds).toEqual([GWAGON]);
    expect(await storage.getContext(GWAGON)).not.toBeNull();

    expect(events[0]).toEqual({ done: 0, total: PLAYLIST_SIZE, message: `Ingesting ${PLAYLIST_SIZE} new items.` });
    expect(events.at(-1)?.done).toBe(PLAYLIST_SIZE);
    expect(events.map((e) => e.done)).toEqual([...Array(PLAYLIST_SIZE + 1).keys()]);
    expect(events.every((e) => e.total === PLAYLIST_SIZE && typeof e.message === 'string')).toBe(true);
  });

  it('is idempotent: a second refresh adds nothing and only retries the failures', async () => {
    const { lib, storage } = setup();
    const c = await lib.createCollection({ name: 'G-Wagon', sources: [PLAYLIST] });
    await lib.refresh(c.id, { delayMs: 0 });
    const second = await lib.refresh(c.id, { delayMs: 0 });
    expect(second.added).toEqual([]);
    expect(second.skipped).toBe(1);
    expect(second.failed).toHaveLength(PLAYLIST_SIZE - 1);
    expect((await storage.getCollection(c.id))?.videoIds).toEqual([GWAGON]);
  });

  it('keeps at most `concurrency` videos in flight', async () => {
    let inFlight = 0;
    let peak = 0;
    const { lib } = setup({
      around: async (call) => {
        if (!call.url.includes('/youtubei/v1/player')) return;
        inFlight++;
        peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, 15));
        inFlight--;
      },
    });
    const c = await lib.createCollection({ name: 'G-Wagon', sources: [PLAYLIST] });
    await lib.refresh(c.id, { delayMs: 0, concurrency: 2 });
    expect(peak).toBe(2);

    const { lib: lib1 } = setup({
      around: async (call) => {
        if (!call.url.includes('/youtubei/v1/player')) return;
        inFlight++;
        peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, 5));
        inFlight--;
      },
    });
    peak = 0;
    const c1 = await lib1.createCollection({ name: 'G-Wagon', sources: [PLAYLIST] });
    await lib1.refresh(c1.id, { delayMs: 0, concurrency: 1 });
    expect(peak).toBe(1);
  });

  it('caps the items per run: limit leaves the rest for later, VID2CONTEXT_MAX_PLAYLIST_ITEMS caps the read', async () => {
    const { lib } = setup();
    const c = await lib.createCollection({ name: 'G-Wagon', sources: [PLAYLIST] });
    const first = await lib.refresh(c.id, { delayMs: 0, limit: 3 });
    expect(first.added.length + first.failed.length).toBe(3);
    expect(first.remaining).toBe(PLAYLIST_SIZE - 3);

    const capped = setup({ env: { VID2CONTEXT_MAX_PLAYLIST_ITEMS: '4' } });
    const c2 = await capped.lib.createCollection({ name: 'G-Wagon', sources: [PLAYLIST] });
    const s = await capped.lib.refresh(c2.id, { delayMs: 0, limit: 50 });
    expect(s.added.length + s.failed.length).toBe(4);
    expect(s.remaining).toBe(0);
  });

  it('records a source that cannot be expanded as a failure and keeps going', async () => {
    const { lib } = setup();
    const c = await lib.createCollection({ name: 'G-Wagon', sources: [PLAYLIST] });
    // A playlist id that was never recorded: the replay refuses it, as an offline network would.
    await lib.addSource(c.id, 'https://www.youtube.com/playlist?list=PLnotrecordedxxxxxxxx');
    const s = await lib.refresh(c.id, { delayMs: 0 });
    expect(s.failed.find((f) => f.input.includes('PLnotrecorded'))).toBeTruthy();
    expect(s.added.map((a) => a.id)).toEqual([GWAGON]);
  });

  it('joins a refresh already running for the same collection', async () => {
    const { lib, replay } = setup();
    const c = await lib.createCollection({ name: 'G-Wagon', sources: [PLAYLIST] });
    const [a, b] = await Promise.all([lib.refresh(c.id, { delayMs: 0 }), lib.refresh(c.id, { delayMs: 0 })]);
    expect(a).toBe(b);
    expect(browseCalls(replay)).toHaveLength(1);
  });
});

describe('videos', () => {
  it('adds videos, reports an unavailable one with its code and hint, and skips what is already there', async () => {
    const { lib } = setup();
    const c = await lib.createCollection({ name: 'Zoo' });
    const s = await lib.addVideos(c.id, ['xxxxxxxxxxx', 'https://youtu.be/jNQXAC9IVRw'], { delayMs: 0 });
    expect(s.added.map((a) => a.id)).toEqual([ZOO]);
    expect(s.failed).toEqual([
      expect.objectContaining({ input: 'https://www.youtube.com/watch?v=xxxxxxxxxxx', code: 'not-found', hint: expect.any(String) }),
    ]);
    const again = await lib.addVideos(c.id, ['jNQXAC9IVRw'], { delayMs: 0 });
    expect(again.added).toEqual([]);
    expect(again.skipped).toBe(1);
    expect((await rejects(lib.addVideos(c.id, []))).code).toBe('bad-request');
  });

  it('expands lists given as items, and a removed video stays out of later refreshes', async () => {
    const { lib, storage } = setup();
    const c = await lib.createCollection({ name: 'G-Wagon' });
    const s = await lib.addVideos(c.id, [PLAYLIST], { delayMs: 0 });
    expect(s.added.map((a) => a.id)).toEqual([GWAGON]);
    await lib.removeVideos(c.id, [GWAGON]);
    await lib.addSource(c.id, PLAYLIST);
    const r = await lib.refresh(c.id, { delayMs: 0 });
    expect(r.added).toEqual([]);
    expect(r.skipped).toBe(1);
    expect((await storage.getCollection(c.id))?.videoIds).toEqual([]);
    // An explicit add brings it back.
    expect((await lib.addVideos(c.id, ['cCPsdFdlshc'], { delayMs: 0 })).added.map((a) => a.id)).toEqual([GWAGON]);
  });

  it('shows video summaries in the collection detail', async () => {
    const { lib } = setup();
    const c = await lib.createCollection({ name: 'Zoo', description: 'first upload' });
    await lib.addVideos(c.id, ['jNQXAC9IVRw'], { delayMs: 0 });
    const d = await lib.getCollectionDetail(c.id);
    expect(d.videos).toEqual([expect.objectContaining({ id: ZOO, title: 'Me at the zoo', channel: 'jawed' })]);
    expect(d.pending).toEqual([]);
    expect(d.watch).toBeNull();
  });
});

describe('import and export', () => {
  it('round-trips a collection: sources, videos and schedule, without transcripts', async () => {
    const { lib } = setup();
    const c = await lib.createCollection({ name: 'G-Wagon', description: 'Buying research', sources: [PLAYLIST] });
    await lib.addVideos(c.id, ['jNQXAC9IVRw'], { delayMs: 0 });
    await lib.setWatch(c.id, { every: 'daily', at: '06:00' });
    const def = await lib.exportCollection(c.id);
    expect(def).toEqual({
      format: 'vid2context.collection',
      version: 1,
      name: 'G-Wagon',
      description: 'Buying research',
      sources: [PLAYLIST],
      videos: ['https://www.youtube.com/watch?v=jNQXAC9IVRw'],
      schedule: { every: 'daily', at: '06:00', enabled: true },
    });

    const other = setup();
    const { collection } = await other.lib.importCollection(JSON.stringify(def));
    const detail = await other.lib.getCollectionDetail(collection.id);
    expect(detail.sources).toEqual([PLAYLIST]);
    expect(detail.videoIds).toEqual([]);
    expect(detail.pending).toEqual(['https://www.youtube.com/watch?v=jNQXAC9IVRw']);
    expect(detail.watch?.schedule).toEqual(def.schedule);

    const s = await other.lib.refresh(collection.id, { delayMs: 0 });
    expect(s.added.map((a) => a.id).sort()).toEqual([GWAGON, ZOO].sort());
    expect((await other.lib.getCollectionDetail(collection.id)).pending).toEqual([]);
  });

  it('imports and refreshes in one step when asked', async () => {
    const { lib } = setup();
    const r = await lib.importCollection({ name: 'Zoo', sources: [], videos: ['jNQXAC9IVRw'] }, { refresh: true, delayMs: 0 });
    expect(r.summary?.added.map((a) => a.id)).toEqual([ZOO]);
    expect(r.collection.videoIds).toEqual([ZOO]);
  });

  it('validates the definition before creating anything', async () => {
    const { lib } = setup();
    for (const bad of [
      'not json',
      [],
      {},
      { name: 'x', version: 2 },
      { name: 'x', format: 'other' },
      { name: 'x', sources: 'nope' },
      { name: 'x', sources: ['https://www.youtube.com/watch?v=cCPsdFdlshc'] },
      { name: 'x', schedule: { every: 'sometimes' } },
    ]) {
      const err = await rejects(lib.importCollection(bad));
      expect(err.code).toBe('bad-request');
      expect(err.hint).toBeTruthy();
    }
    expect(await lib.listCollections()).toEqual([]);
  });
});

describe('delete', () => {
  it('removes the collection with its watch list and state, keeping saved transcripts', async () => {
    const { lib, kv, storage } = setup();
    const c = await lib.createCollection({ name: 'Zoo' });
    await lib.addVideos(c.id, ['jNQXAC9IVRw'], { delayMs: 0 });
    await lib.setWatch(c.id, { every: 'weekly' });
    await lib.deleteCollection(c.id);
    expect(await storage.getCollection(c.id)).toBeNull();
    expect((await kv.kvList('library:')).keys).toEqual([]);
    expect(await storage.getContext(ZOO)).not.toBeNull();
  });
});

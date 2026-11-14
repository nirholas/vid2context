import { MemoryKv, MemoryStorage } from '@vid2context/core';
import { describe, expect, it } from 'vitest';
import { firstDueAt, nextDueAt, parseSchedule, type Schedule, scheduledHandler, startScheduler } from '../src/index.ts';
import { browseCalls, GWAGON, PLAYLIST, setup } from './helpers.ts';

const at = (iso: string) => new Date(iso);
const iso = (d: Date) => d.toISOString();

describe('schedules', () => {
  it('validates input and defaults enabled to true', () => {
    expect(parseSchedule({ every: 'daily', at: '06:30' })).toEqual({ every: 'daily', at: '06:30', enabled: true });
    expect(parseSchedule({ every: { minutes: 30 }, enabled: false })).toEqual({ every: { minutes: 30 }, enabled: false });
    for (const bad of [
      null,
      'daily',
      { every: 'monthly' },
      { every: { minutes: 1 } },
      { every: { minutes: 2.5 } },
      { every: 'daily', at: '25:00' },
      { every: 'daily', at: '6:30' },
      { every: { minutes: 30 }, at: '06:00' },
      { every: 'hourly', enabled: 'yes' },
    ]) {
      expect(() => parseSchedule(bad), JSON.stringify(bad)).toThrow(expect.objectContaining({ code: 'bad-request' }));
    }
  });

  it('computes the next run in UTC', () => {
    const from = at('2026-11-14T10:20:00Z');
    const s = (every: Schedule['every'], a?: string): Schedule => ({ every, enabled: true, ...(a ? { at: a } : {}) });
    expect(iso(nextDueAt(s('hourly'), from))).toBe('2026-11-14T11:20:00.000Z');
    expect(iso(nextDueAt(s('hourly', '00:05'), from))).toBe('2026-11-14T11:05:00.000Z');
    expect(iso(nextDueAt(s('daily'), from))).toBe('2026-11-15T10:20:00.000Z');
    expect(iso(nextDueAt(s('daily', '06:00'), from))).toBe('2026-11-15T06:00:00.000Z');
    expect(iso(nextDueAt(s('daily', '23:00'), from))).toBe('2026-11-14T23:00:00.000Z');
    expect(iso(nextDueAt(s('weekly'), from))).toBe('2026-11-21T10:20:00.000Z');
    expect(iso(nextDueAt(s('weekly', '06:00'), from))).toBe('2026-11-21T06:00:00.000Z');
    expect(iso(nextDueAt(s({ minutes: 45 }), from))).toBe('2026-11-14T11:05:00.000Z');
    // A run at its slot, or late, waits for the next day's slot.
    expect(iso(nextDueAt(s('daily', '06:00'), at('2026-11-14T06:00:00Z')))).toBe('2026-11-15T06:00:00.000Z');
    expect(iso(nextDueAt(s('daily', '06:00'), at('2026-11-14T06:45:00Z')))).toBe('2026-11-15T06:00:00.000Z');
    expect(iso(nextDueAt(s('weekly', '06:00'), at('2026-11-14T06:00:00Z')))).toBe('2026-11-21T06:00:00.000Z');
  });

  it('runs a new watch list at once, or at its first slot when it has a time', () => {
    const now = at('2026-11-14T10:20:00Z');
    expect(firstDueAt({ every: 'daily', enabled: true }, now)).toEqual(now);
    expect(iso(firstDueAt({ every: 'daily', at: '12:00', enabled: true }, now))).toBe('2026-11-14T12:00:00.000Z');
    expect(iso(firstDueAt({ every: 'daily', at: '06:00', enabled: true }, now))).toBe('2026-11-15T06:00:00.000Z');
    expect(iso(firstDueAt({ every: 'hourly', at: '00:30', enabled: true }, now))).toBe('2026-11-14T10:30:00.000Z');
  });
});

describe('runDue', () => {
  it('refreshes due collections only, and persists the state in the KvStore', async () => {
    const storage = new MemoryStorage();
    const kv = new MemoryKv();
    let now = at('2026-11-14T05:00:00Z');
    const { lib } = setup({ storage, kv, library: { now: () => now } });
    const c = await lib.createCollection({ name: 'G-Wagon', sources: [PLAYLIST] });
    const w = await lib.setWatch(c.id, { every: 'daily', at: '06:00' });
    expect(w.state.nextDueAt).toBe('2026-11-14T06:00:00.000Z');

    expect(await lib.runDue(at('2026-11-14T05:59:00Z'), { delayMs: 0 })).toEqual([]);
    now = at('2026-11-14T06:01:00Z');
    const [r] = await lib.runDue(now, { delayMs: 0 });
    expect(r?.status).toBe('refreshed');
    expect(r?.summary?.added.map((a) => a.id)).toEqual([GWAGON]);
    expect(r?.summary?.checkedAt).toBe('2026-11-14T06:01:00.000Z');
    expect(await lib.runDue(at('2026-11-14T12:00:00Z'), { delayMs: 0 })).toEqual([]);

    // A new process (new Library) on the same storage and KV sees the same watch list and state.
    const { lib: later } = setup({ storage, kv });
    const watch = await later.getWatch(c.id);
    expect(watch?.schedule).toEqual({ every: 'daily', at: '06:00', enabled: true });
    expect(watch?.state).toEqual(
      expect.objectContaining({
        seenIds: [GWAGON],
        lastCheckedAt: '2026-11-14T06:01:00.000Z',
        lastError: null,
        nextDueAt: '2026-11-15T06:00:00.000Z',
      }),
    );
    const [next] = await later.runDue(at('2026-11-15T06:00:00Z'), { delayMs: 0 });
    expect(next?.status).toBe('refreshed');
    expect(next?.summary?.added).toEqual([]);
    expect(next?.summary?.skipped).toBe(1);
  });

  it('skips disabled watch lists and forgets watch lists of deleted collections', async () => {
    const { lib, storage, kv } = setup();
    const a = await lib.createCollection({ name: 'A', sources: [PLAYLIST] });
    await lib.setWatch(a.id, { every: 'hourly', enabled: false });
    const b = await lib.createCollection({ name: 'B', sources: [PLAYLIST] });
    await lib.setWatch(b.id, { every: 'hourly' });
    await storage.deleteCollection(b.id);
    const results = await lib.runDue(new Date(), { delayMs: 0 });
    expect(results).toEqual([expect.objectContaining({ collectionId: b.id, status: 'removed' })]);
    expect((await kv.kvList(`library:watch:${b.id}`)).keys).toEqual([]);
    await lib.removeWatch(a.id);
    expect(await lib.getWatch(a.id)).toBeNull();
  });

  it('leaves a collection alone while another process holds its lease', async () => {
    const { lib, kv } = setup();
    const c = await lib.createCollection({ name: 'G-Wagon', sources: [PLAYLIST] });
    await lib.setWatch(c.id, { every: 'hourly' });
    await kv.kvSet(`library:lease:${c.id}`, { token: 'another-process' }, { ttlSec: 60 });
    expect(await lib.runDue(new Date(), { delayMs: 0 })).toEqual([{ collectionId: c.id, status: 'leased' }]);
    await kv.kvDelete(`library:lease:${c.id}`);
    const [r] = await lib.runDue(new Date(), { delayMs: 0 });
    expect(r?.status).toBe('refreshed');
    expect((await kv.kvList('library:lease:')).keys).toEqual([]);
  });

  it('runs a due collection once when two schedulers call at the same time', async () => {
    const storage = new MemoryStorage();
    const kv = new MemoryKv();
    const one = setup({ storage, kv });
    const two = setup({ storage, kv });
    const c = await one.lib.createCollection({ name: 'G-Wagon', sources: [PLAYLIST] });
    await one.lib.setWatch(c.id, { every: 'hourly' });
    const now = new Date();
    const [a, b] = await Promise.all([one.lib.runDue(now, { delayMs: 0 }), two.lib.runDue(now, { delayMs: 0 })]);
    const statuses = [...a, ...b].map((r) => r.status).sort();
    expect(statuses).toEqual(['leased', 'refreshed']);
    expect(browseCalls(one.replay).length + browseCalls(two.replay).length).toBe(1);
    expect((await storage.getCollection(c.id))?.videoIds).toEqual([GWAGON]);
  });
});

describe('schedulers', () => {
  it('startScheduler runs due watch lists and stops gracefully', async () => {
    const { lib } = setup();
    const c = await lib.createCollection({ name: 'G-Wagon', sources: [PLAYLIST] });
    await lib.setWatch(c.id, { every: 'hourly' });
    const ran = new Promise<string[]>((resolve) => {
      const handle = startScheduler(lib, {
        intervalMs: 60_000,
        onRun: (results) => {
          handle.stop().then(() => resolve(results.map((r) => r.status)));
        },
      });
    });
    expect(await ran).toEqual(['refreshed']);
    expect((await lib.getCollection(c.id)).videoIds).toEqual([GWAGON]);
  });

  it('scheduledHandler runs at the cron time and hands the work to waitUntil', async () => {
    const { lib } = setup();
    const c = await lib.createCollection({ name: 'G-Wagon', sources: [PLAYLIST] });
    await lib.setWatch(c.id, { every: 'daily', at: '06:00' });
    const waited: Promise<unknown>[] = [];
    const handler = scheduledHandler<{ name: string }>({ library: (env) => (env.name === 'test' ? lib : Promise.reject()) });
    const early = await handler({ scheduledTime: Date.parse('2026-11-14T05:00:00Z') }, { name: 'test' });
    expect(early).toEqual([]);
    const due = (await lib.getWatch(c.id))?.state.nextDueAt ?? '';
    const results = await handler({ scheduledTime: Date.parse(due) }, { name: 'test' }, { waitUntil: (p) => waited.push(p) });
    expect(results.map((r) => r.status)).toEqual(['refreshed']);
    expect(waited).toHaveLength(1);
  });
});

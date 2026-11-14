import { MemoryStorage } from '@vid2context/core';
import { resetBreaker } from '@vid2context/provider-youtube';
import { beforeEach, describe, expect, it } from 'vitest';
import { cli } from './helpers.ts';

beforeEach(() => resetBreaker());

/** A MemoryStorage with "Me at the zoo" and the G-Wagon video saved through `get`, from recorded responses. */
async function filled(): Promise<MemoryStorage> {
  const storage = new MemoryStorage();
  for (const id of ['jNQXAC9IVRw', 'cCPsdFdlshc']) expect((await cli(['get', id], { storage })).code).toBe(0);
  return storage;
}

describe('search', () => {
  it('prints title, [m:ss], text and the timestamp URL', async () => {
    const storage = await filled();
    const res = await cli(['search', 'elephants'], { storage });
    expect(res.code).toBe(0);
    expect(res.stdout).toBe(
      'Me at the zoo [0:01] All right, so here we are, in front of the elephants\n  https://www.youtube.com/watch?v=jNQXAC9IVRw&t=1s\n',
    );
    expect(res.stderr.trimEnd().split('\n').at(-1)).toBe('1 hit');
  });

  it('returns JSON hits, honours --limit and --collection', async () => {
    const storage = await filled();
    const hits = JSON.parse((await cli(['search', 'the', '--limit', '2', '--json'], { storage })).stdout);
    expect(hits).toHaveLength(2);
    expect(hits[0]).toHaveProperty('url');
    const col = await storage.createCollection({ name: 'zoo' });
    await storage.addToCollection(col.id, ['youtube:jNQXAC9IVRw']);
    const scoped = JSON.parse((await cli(['search', 'the', '--collection', col.id, '--json'], { storage })).stdout);
    expect(new Set(scoped.map((h: { videoId: string }) => h.videoId))).toEqual(new Set(['youtube:jNQXAC9IVRw']));
  });

  it('says when the library is only in memory', async () => {
    const res = await cli(['search', 'anything']);
    expect(res.stdout).toBe('');
    expect(res.stderr).toContain('lives only for this process');
  });
});

describe('library', () => {
  it('lists, shows and removes saved videos', async () => {
    const storage = await filled();
    const ls = await cli(['library', 'ls'], { storage });
    expect(ls.stdout.split('\n')[0]).toMatch(/^ID +ORIGIN +LANG +LENGTH +TITLE$/);
    expect(ls.stdout).toContain('youtube:jNQXAC9IVRw  creator-captions  en');
    const page = JSON.parse((await cli(['library', 'ls', '--json', '--limit', '1'], { storage })).stdout);
    expect(page.items).toHaveLength(1);
    expect(page.cursor).toBe('1');

    const show = await cli(['library', 'show', 'youtube:jNQXAC9IVRw', '--timestamps'], { storage });
    expect(show.stdout.split('\n')[0]).toBe('[0:01] All right, so here we are, in front of the elephants');
    expect(show.fetch.calls).toHaveLength(0);

    expect((await cli(['library', 'rm', 'youtube:jNQXAC9IVRw'], { storage })).stdout).toBe('deleted youtube:jNQXAC9IVRw\n');
    const gone = await cli(['library', 'show', 'youtube:jNQXAC9IVRw'], { storage });
    expect(gone.code).toBe(4);
    expect(gone.stderr).toContain('library ls');
  });

  it('rejects a missing or unknown subcommand', async () => {
    expect((await cli(['library'])).code).toBe(2);
    expect((await cli(['library', 'list'])).stderr).toContain('One of: ls, show, rm');
  });
});

describe('collection', () => {
  it('creates, adds (fetching new videos, reusing saved ones), shows and removes', async () => {
    const storage = await filled();
    const created = await cli(['collection', 'create', 'Classic', 'clips', '--description', 'Old uploads', '--json'], {
      storage,
    });
    const col = JSON.parse(created.stdout);
    expect(col).toMatchObject({ name: 'Classic clips', description: 'Old uploads', videoIds: [] });

    const saved = await cli(['collection', 'add', col.id, 'youtube:jNQXAC9IVRw'], { storage });
    expect(saved.fetch.calls).toHaveLength(0);
    expect(saved.stdout).toContain('youtube:jNQXAC9IVRw  Me at the zoo');

    const fresh = new MemoryStorage();
    const c2 = JSON.parse((await cli(['collection', 'create', 'x', '--json'], { storage: fresh })).stdout);
    const fetched = await cli(['collection', 'add', c2.id, 'https://youtu.be/cCPsdFdlshc'], { storage: fresh });
    expect(fetched.code).toBe(0);
    expect(await fresh.getContext('youtube:cCPsdFdlshc')).not.toBeNull();

    const ls = await cli(['collection', 'ls'], { storage });
    expect(ls.stdout).toMatch(new RegExp(`${col.id} +1 +Classic clips`));
    const shown = await cli(['collection', 'show', col.id], { storage });
    expect(shown.stdout.split('\n').slice(0, 3)).toEqual([`Classic clips (${col.id})`, 'Old uploads', '1 video']);

    const removed = JSON.parse((await cli(['collection', 'rm', col.id, 'youtube:jNQXAC9IVRw', '--json'], { storage })).stdout);
    expect(removed.videoIds).toEqual([]);
    expect((await cli(['collection', 'rm', col.id], { storage })).stdout).toBe(`deleted ${col.id}\n`);
    expect((await cli(['collection', 'show', col.id], { storage })).code).toBe(4);
  });

  it('refresh expands the sources through @vid2context/library and reports each outcome', async () => {
    const storage = new MemoryStorage();
    const playlist = 'https://www.youtube.com/playlist?list=PLHeawKfarQSPKIjpe86at3Ttc2sz7uD_b';
    const col = JSON.parse((await cli(['collection', 'create', 'G-Wagon', '--source', playlist, '--json'], { storage })).stdout);
    // The playlist is recorded, but its videos' player responses are not, so the replay answers them as unavailable.
    const res = await cli(['collection', 'refresh', col.id, '--limit', '1', '--json'], { storage });
    expect(res.code).toBe(0);
    const summary = JSON.parse(res.stdout);
    expect(summary).toMatchObject({ collectionId: col.id, added: [] });
    expect(summary.failed).toHaveLength(1);
    expect(summary.failed[0].input).toContain('PzJL3aBRas8');
    expect(summary.remaining).toBeGreaterThan(0);
    expect(res.stderr).toContain('failed https://www.youtube.com/watch?v=PzJL3aBRas8');
    expect((await cli(['collection', 'refresh', 'nope'], { storage })).code).toBe(4);
  });
});

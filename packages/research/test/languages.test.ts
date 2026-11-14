import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { listCaptionLanguages, readTranslationLanguages } from '../src/languages.ts';
import { ctxWith, GWAGON, makeRegistry, PLAYER_URL, playerRoute, ROOT, ZOO } from './helpers.ts';

// Real innertube player responses from providers/youtube/test/fixtures (read-only).
const player = (id: string): unknown =>
  JSON.parse(readFileSync(join(ROOT, 'providers/youtube/test/fixtures', `player-${id}.json`), 'utf8'));

describe('readTranslationLanguages', () => {
  it('reads the 16 translation targets of the G-Wagon video', () => {
    const targets = readTranslationLanguages(player('cCPsdFdlshc'));
    expect(targets).toHaveLength(16);
    expect(targets.slice(0, 3)).toEqual([
      { language: 'ar', name: 'Arabic' },
      { language: 'zh-Hant', name: 'Chinese (Traditional)' },
      { language: 'nl', name: 'Dutch' },
    ]);
  });

  it('returns nothing when the player has no translation list', () => {
    expect(readTranslationLanguages(player('jNQXAC9IVRw'))).toEqual([]);
    expect(readTranslationLanguages(player('unavailable'))).toEqual([]);
    expect(readTranslationLanguages(null)).toEqual([]);
  });
});

describe('listCaptionLanguages', () => {
  it('lists the auto-caption track and translation targets with one player request', async () => {
    const ctx = ctxWith([playerRoute]);
    const r = await listCaptionLanguages(GWAGON, { registry: makeRegistry(), ctx, storage: null });
    expect(r.videoId).toBe('youtube:cCPsdFdlshc');
    expect(r.tracks).toEqual([
      {
        language: 'en',
        name: 'English (auto-generated)',
        origin: 'auto-captions',
        translatable: true,
        provider: 'youtube-captions',
      },
    ]);
    expect(r.translationTargets).toHaveLength(16);
    expect(r.translationTargets).toContainEqual({ language: 'de', name: 'German' });
    expect(r.notes).toEqual([]);
    expect(ctx.fetch.calls.filter((c) => c.url === PLAYER_URL)).toHaveLength(1);
  });

  it('lists creator tracks and notes that YouTube offers no translation', async () => {
    const r = await listCaptionLanguages(ZOO, { registry: makeRegistry(), ctx: ctxWith([playerRoute]), storage: null });
    expect(r.tracks.map((t) => [t.language, t.origin])).toEqual([
      ['en', 'creator-captions'],
      ['de', 'creator-captions'],
    ]);
    expect(r.translationTargets).toEqual([]);
    expect(r.notes).toEqual(['YouTube offers no machine translation for these tracks.']);
  });

  it('reports a removed video as not-found', async () => {
    await expect(
      listCaptionLanguages('https://youtu.be/xxxxxxxxxxx', {
        registry: makeRegistry(),
        ctx: ctxWith([playerRoute]),
        storage: null,
      }),
    ).rejects.toMatchObject({ code: 'not-found' });
  });

  it('lists tracks only for non-YouTube sources', async () => {
    const file = join(ROOT, 'tests/fixtures/media/apollo11-small-step.mp3');
    const ctx = ctxWith([]);
    const r = await listCaptionLanguages(file, { registry: makeRegistry(), ctx, storage: null });
    expect(r.videoId.startsWith('file:')).toBe(true);
    expect(r.tracks).toEqual([]);
    expect(r.translationTargets).toEqual([]);
    expect(r.notes[0]).toMatch(/^No installed captions provider lists tracks for file/);
    expect(ctx.fetch.calls).toEqual([]);
  });

  it('rejects a playlist', async () => {
    await expect(
      listCaptionLanguages('https://www.youtube.com/playlist?list=PLHeawKfarQSPKIjpe86at3Ttc2sz7uD_b', {
        registry: makeRegistry(),
        ctx: ctxWith([]),
        storage: null,
      }),
    ).rejects.toMatchObject({ code: 'unsupported-input' });
  });
});

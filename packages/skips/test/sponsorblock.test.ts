import { Vid2ContextError, type VideoRef } from '@vid2context/core';
import { replayFetch, testContext } from '@vid2context/core/testing';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SKIP_CATEGORIES,
  getSkipSegments,
  hashPrefix,
  parseCategories,
  resolveOverlaps,
  type SkipSegment,
  skipSegmentsUrl,
  sponsorBlockBaseUrl,
} from '../src/index.ts';
import { fixture, requestedCategories, routes, youtubeRef } from './fixtures.ts';

const OFFICE = youtubeRef('CrO0Timw2z4'); // Linus Tech Tips, sponsored by LiberNovo and Nanoleaf; prefix 9007
const GWAGON = youtubeRef('cCPsdFdlshc'); // the shared G-Wagon fixture video, no segments; prefix 2d69

function setup(env: Record<string, string> = {}) {
  const fetch = replayFetch(routes);
  return { fetch, ctx: testContext({ fetch, env }) };
}

const rawEntry = (file: string, id: string) =>
  (JSON.parse(fixture(file)) as { videoID: string; segments: { UUID: string }[] }[]).find((v) => v.videoID === id);

describe('hash prefix lookups', () => {
  it('hashes the video id with SHA-256 and keeps 4 hex characters', async () => {
    expect(await hashPrefix('CrO0Timw2z4')).toBe('9007');
    expect(await hashPrefix('cCPsdFdlshc')).toBe('2d69');
    expect(await hashPrefix('jNQXAC9IVRw')).toBe('6745');
    expect(await hashPrefix('CrO0Timw2z4', 8)).toMatch(/^9007[0-9a-f]{4}$/);
  });

  it('never sends the video id, only the prefix, and asks for every action type', async () => {
    const { fetch, ctx } = setup();
    await getSkipSegments(OFFICE, ctx);
    expect(fetch.calls).toHaveLength(1);
    const call = fetch.calls[0];
    expect(call?.url).not.toContain('CrO0Timw2z4');
    const url = new URL(call?.url ?? '');
    expect(url.origin + url.pathname).toBe('https://sponsor.ajay.app/api/skipSegments/9007');
    expect(requestedCategories(url.href)).toEqual([...DEFAULT_SKIP_CATEGORIES]);
    expect(JSON.parse(url.searchParams.get('actionTypes') ?? '[]')).toEqual(['skip', 'mute', 'full', 'poi', 'chapter']);
  });

  it('picks the exact video out of the 135 that share its prefix', async () => {
    const { ctx } = setup();
    const lookup = await getSkipSegments(OFFICE, ctx);
    const own = new Set(rawEntry('skipSegments-9007.json', 'CrO0Timw2z4')?.segments.map((s) => s.UUID));
    expect((JSON.parse(fixture('skipSegments-9007.json')) as unknown[]).length).toBe(135);
    expect(lookup.looked).toBe(true);
    expect(lookup.videoId).toBe('youtube:CrO0Timw2z4');
    expect(lookup.segments.length).toBeGreaterThan(0);
    for (const s of lookup.segments) expect(own.has(s.uuid)).toBe(true);
  });

  it('returns no segments for a video absent from its prefix response (the G-Wagon video)', async () => {
    const { fetch, ctx } = setup();
    const lookup = await getSkipSegments(GWAGON, ctx);
    expect(fetch.calls[0]?.url).toContain('/api/skipSegments/2d69?');
    expect(lookup).toEqual({ videoId: 'youtube:cCPsdFdlshc', segments: [], chapters: [], looked: true });
  });

  it('treats a real 404 as "no segments"', async () => {
    const { ctx } = setup();
    const lookup = await getSkipSegments(OFFICE, ctx, { categories: ['exclusive_access'] });
    expect(lookup.segments).toEqual([]);
    expect(lookup.fullVideo).toBeUndefined();
    expect(lookup.looked).toBe(true);
  });

  it('makes no request for other platforms', async () => {
    const { fetch, ctx } = setup();
    const file: VideoRef = { input: 'talk.mp3', platform: 'file', kind: 'video', id: 'file:abc', nativeId: 'abc' };
    const lookup = await getSkipSegments(file, ctx);
    expect(lookup).toEqual({ videoId: 'file:abc', segments: [], chapters: [], looked: false });
    expect(fetch.calls).toHaveLength(0);
  });
});

describe('categories and votes', () => {
  it('keeps only the default categories (no hook) unless asked', async () => {
    const { ctx } = setup();
    const lookup = await getSkipSegments(OFFICE, ctx);
    expect(new Set(lookup.segments.map((s) => s.category))).toEqual(
      new Set(['preview', 'sponsor', 'intro', 'selfpromo', 'outro']),
    );
    const hook = await getSkipSegments(OFFICE, ctx, { categories: ['hook'] });
    expect(hook.segments.map((s) => [s.category, s.startSec, s.endSec])).toEqual([['hook', 3.3, 15.72]]);
  });

  it('filters client-side too, because a mirror may ignore the categories parameter', async () => {
    const { ctx } = setup();
    // The recorded body holds every category; only sponsor survives.
    const lookup = await getSkipSegments(OFFICE, ctx, { categories: ['sponsor'] });
    expect(lookup.segments.length).toBe(5);
    expect(lookup.fullVideo?.category).toBe('sponsor');
    expect(lookup.segments.every((s) => s.category === 'sponsor')).toBe(true);
  });

  it('reads default categories from VID2CONTEXT_SKIP_CATEGORIES and skips unknown names', async () => {
    const { fetch, ctx } = setup({ VID2CONTEXT_SKIP_CATEGORIES: 'sponsor, selfpromo, adverts' });
    const lookup = await getSkipSegments(OFFICE, ctx);
    expect(requestedCategories(fetch.calls[0]?.url ?? '')).toEqual(['sponsor', 'selfpromo']);
    expect(new Set(lookup.segments.map((s) => s.category))).toEqual(new Set(['sponsor', 'selfpromo']));
  });

  it('rejects unknown categories passed by the caller', async () => {
    const { ctx } = setup();
    expect(() => parseCategories('sponsor,ads')).toThrow(/Unknown SponsorBlock category: ads/);
    await expect(getSkipSegments(OFFICE, ctx, { categories: ['ads' as 'sponsor'] })).rejects.toMatchObject({
      code: 'bad-request',
      hint: expect.stringContaining('selfpromo'),
    });
  });

  it('drops segments below minVotes unless a VIP locked them', async () => {
    const { ctx } = setup();
    const lookup = await getSkipSegments(OFFICE, ctx, { minVotes: 3 });
    expect(lookup.segments.map((s) => `${s.category}@${Math.round(s.startSec)}:${s.votes}${s.locked ? 'L' : ''}`)).toEqual([
      'intro@60:5',
      'sponsor@691:3L',
      'sponsor@804:2L',
      'selfpromo@963:3L',
      'sponsor@1060:3',
    ]);
    expect(lookup.fullVideo).toBeUndefined(); // the whole-video label has 1 vote
  });

  it('always drops negative votes', async () => {
    const { ctx } = setup();
    // CFtW7MT1-Cg (prefix 2d69) has one sponsor span and one whole-video label, both at -1.
    const lookup = await getSkipSegments(youtubeRef('CFtW7MT1-Cg'), ctx, { categories: ['sponsor'] });
    expect(rawEntry('skipSegments-2d69.json', 'CFtW7MT1-Cg')?.segments).toHaveLength(2);
    expect(lookup.segments).toEqual([]);
    expect(lookup.fullVideo).toBeUndefined();
  });
});

describe('action types', () => {
  it('reports a whole-video sponsorship as a flag and keeps the spans', async () => {
    const { ctx } = setup();
    const lookup = await getSkipSegments(OFFICE, ctx);
    expect(lookup.fullVideo).toMatchObject({ category: 'sponsor', actionType: 'full', startSec: 0, endSec: 0, votes: 1 });
    expect(lookup.segments.some((s) => s.actionType === 'full')).toBe(false);
    expect(lookup.segments).toHaveLength(10);
  });

  it('returns poi_highlight separately as the highlight, never as a span', async () => {
    const { ctx } = setup();
    // pGC51aAUHHc (prefix 2d69) has a highlight point.
    const lookup = await getSkipSegments(youtubeRef('pGC51aAUHHc'), ctx, { categories: ['poi_highlight', 'sponsor'] });
    expect(lookup.highlight).toMatchObject({ category: 'poi_highlight', actionType: 'poi' });
    expect(lookup.highlight?.startSec).toBe(lookup.highlight?.endSec);
    expect(lookup.segments.some((s) => s.actionType === 'poi')).toBe(false);
    const plain = await getSkipSegments(youtubeRef('pGC51aAUHHc'), ctx);
    expect(plain.highlight).toBeUndefined();
  });

  it('keeps mute spans and resolves a mostly covered duplicate to the better-voted one', async () => {
    const { ctx } = setup();
    // L89LAfYNwl8: selfpromo mute 150.458-182.561 (locked, 1 vote) and interaction mute 150.625-182.561 (0 votes).
    const lookup = await getSkipSegments(youtubeRef('L89LAfYNwl8'), ctx, { categories: ['selfpromo', 'interaction'] });
    expect(lookup.segments.map((s) => [s.category, s.actionType, s.startSec, s.endSec])).toEqual([
      ['selfpromo', 'mute', 150.458, 182.561],
    ]);
  });

  it('returns community chapters with their titles when asked', async () => {
    const { ctx } = setup();
    const lookup = await getSkipSegments(youtubeRef('7qeGWkS0Kn8'), ctx, { categories: ['chapter'] });
    expect(lookup.segments).toEqual([]);
    expect(lookup.chapters[0]).toMatchObject({ actionType: 'chapter', description: 'Opening', startSec: 0 });
    expect(lookup.chapters.map((c) => c.description)).toContain('Tes Gaming');
  });
});

describe('overlap resolution', () => {
  it('prefers more votes and trims edge overlaps so no second counts twice', async () => {
    const { ctx } = setup();
    const { segments } = await getSkipSegments(OFFICE, ctx);
    const byStart = (n: number) => segments.find((s) => Math.abs(s.startSec - n) < 0.01);
    // preview (0 votes, 16.5-59.4) overlaps sponsor (2 votes, 46.8-59.824): the preview gives way.
    expect(byStart(16.5)).toMatchObject({ category: 'preview', endSec: 46.8 });
    // sponsor (2 votes) meets intro (5 votes) at 59.69: the sponsor gives way.
    expect(byStart(46.8)).toMatchObject({ category: 'sponsor', endSec: 59.69 });
    expect(byStart(59.69)).toMatchObject({ category: 'intro', endSec: 68.544 });
    // outro (0 votes) starts inside the closing sponsor thanks (3 votes).
    expect(byStart(1069.432)).toMatchObject({ category: 'outro', endSec: 1077.0635 });
    for (let i = 1; i < segments.length; i++) {
      expect(segments[i]?.startSec).toBeGreaterThanOrEqual(segments[i - 1]?.endSec ?? 0);
    }
  });

  it('splits a weaker span around a stronger one inside it and keeps both sides', () => {
    const outer: SkipSegment = { category: 'filler', startSec: 0, endSec: 100, votes: 0, uuid: 'a', actionType: 'skip' };
    const inner: SkipSegment = { category: 'sponsor', startSec: 40, endSec: 60, votes: 4, uuid: 'b', actionType: 'skip' };
    expect(resolveOverlaps([outer, inner]).map((s) => [s.uuid, s.startSec, s.endSec])).toEqual([
      ['a', 0, 40],
      ['b', 40, 60],
      ['a', 60, 100],
    ]);
  });
});

describe('settings and failures', () => {
  it('VID2CONTEXT_SPONSORBLOCK=0 turns lookups off without a request', async () => {
    const { fetch, ctx } = setup({ VID2CONTEXT_SPONSORBLOCK: '0' });
    const lookup = await getSkipSegments(OFFICE, ctx);
    expect(lookup).toMatchObject({ segments: [], looked: false });
    expect(fetch.calls).toHaveLength(0);
  });

  it('SPONSORBLOCK_API_URL points lookups at a self-hosted mirror', async () => {
    const { fetch, ctx } = setup({ SPONSORBLOCK_API_URL: 'https://sponsorblock.kavin.rocks/api/' });
    expect(sponsorBlockBaseUrl(ctx)).toBe('https://sponsorblock.kavin.rocks');
    expect(await skipSegmentsUrl(ctx, 'CrO0Timw2z4', ['sponsor'])).toBe(
      'https://sponsorblock.kavin.rocks/api/skipSegments/9007?categories=%5B%22sponsor%22%5D&actionTypes=%5B%22skip%22%2C%22mute%22%2C%22full%22%2C%22poi%22%2C%22chapter%22%5D',
    );
    await getSkipSegments(OFFICE, ctx);
    expect(new URL(fetch.calls[0]?.url ?? '').host).toBe('sponsorblock.kavin.rocks');
  });

  it('maps a 5xx to upstream with a recovery hint', async () => {
    const fetch = replayFetch([{ url: /skipSegments/, response: { status: 503, body: '' } }]);
    const err = await getSkipSegments(OFFICE, testContext({ fetch })).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Vid2ContextError);
    expect(err).toMatchObject({ code: 'upstream', status: 503, hint: expect.stringContaining('VID2CONTEXT_SPONSORBLOCK=0') });
  });

  it('maps a network failure to upstream', async () => {
    // replayFetch with no routes rejects like an unreachable host.
    const err = await getSkipSegments(OFFICE, testContext({ fetch: replayFetch([]) })).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'upstream', message: expect.stringContaining('SponsorBlock request failed') });
  });

  it('gives up after the timeout so a slow server never holds up a transcript', async () => {
    // A server that accepts the request and never answers.
    const hung: typeof fetch = (_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
      });
    const started = Date.now();
    const err = await getSkipSegments(OFFICE, testContext({ fetch: hung }), { timeoutMs: 50 }).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'timeout', hint: expect.stringContaining('SponsorBlock') });
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it('passes a caller abort through instead of reporting an outage', async () => {
    const controller = new AbortController();
    controller.abort();
    const err = await getSkipSegments(OFFICE, testContext({ fetch: replayFetch(routes), signal: controller.signal })).catch(
      (e: unknown) => e,
    );
    expect(err).not.toBeInstanceOf(Vid2ContextError);
    expect((err as Error).name).toBe('AbortError');
  });
});

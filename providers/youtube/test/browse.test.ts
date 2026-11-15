import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { type Ctx, createContext, expandInput, type Logger, Registry, Vid2ContextError, type VideoRef } from '@vid2context/core';
import { type RecordedCall, type ReplayFetch, replayFetch, testContext } from '@vid2context/core/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import { listYouTube } from '../src/browse/list.ts';
import { listMetadata } from '../src/browse/metadata.ts';
import { clockSeconds, parsePage } from '../src/browse/parse.ts';
import { youtubeSource } from '../src/index.ts';
import { resetBreaker } from '../src/resilience/breaker.ts';
import { matchYouTube, matchYouTubeList, videoRef } from '../src/url.ts';

// Real innertube responses recorded on 2026-11-14, see test/fixtures/browse/README.md.
// requests.json lists every request the recording run made (endpoint and body)
// and the file holding the answer, so the replay serves exactly what YouTube said.
const DIR = join(import.meta.dirname, 'fixtures', 'browse');
const read = (file: string) => readFileSync(join(DIR, file), 'utf8');
interface Recorded {
  endpoint: string;
  body: Record<string, unknown>;
  status: number;
  file: string;
}
const RECORDED = JSON.parse(read('requests.json')) as Recorded[];

function endpointOf(call: RecordedCall): string {
  return new URL(call.url).pathname.replace('/youtubei/v1/', '');
}

function bodyOf(call: RecordedCall): Record<string, unknown> {
  const { context: _context, ...rest } = JSON.parse(String(call.body)) as Record<string, unknown>;
  return rest;
}

function browseReplay(): ReplayFetch {
  return replayFetch([
    {
      method: 'POST',
      url: /^https:\/\/www\.youtube\.com\/youtubei\/v1\/(browse|search|navigation\/resolve_url)\?prettyPrint=false$/,
      response: (call) => {
        const endpoint = endpointOf(call);
        const body = bodyOf(call);
        const hit = RECORDED.find((r) => r.endpoint === endpoint && isDeepStrictEqual(r.body, body));
        if (!hit) throw new Error(`no recording for ${endpoint} ${JSON.stringify(body)}`);
        return { status: hit.status, headers: { 'content-type': 'application/json' }, body: read(hit.file) };
      },
    },
  ]);
}

function captureLog(): Logger & { lines: { msg: string; data?: Record<string, unknown> }[] } {
  const lines: { msg: string; data?: Record<string, unknown> }[] = [];
  const push = (msg: string, data?: Record<string, unknown>) => lines.push({ msg, data });
  return { lines, debug: push, info: push, warn: push, error: push };
}

function setup(opts: { signal?: AbortSignal } = {}): { ctx: Ctx; fetch: ReplayFetch; log: ReturnType<typeof captureLog> } {
  const fetch = browseReplay();
  const log = captureLog();
  const ctx = { ...testContext({ fetch, signal: opts.signal }), log };
  return { ctx, fetch, log };
}

const ref = (input: string): VideoRef => {
  const r = matchYouTube(input);
  if (!r) throw new Error(`no match for ${input}`);
  return r;
};

async function ids(input: string, ctx: Ctx, limit?: number): Promise<string[]> {
  const out: string[] = [];
  for await (const r of listYouTube(ref(input), ctx, limit ? { limit } : {})) out.push(r.nativeId);
  return out;
}

function errorOf(p: Promise<unknown>): Promise<Vid2ContextError> {
  return p.then(
    () => {
      throw new Error('expected a rejection');
    },
    (err: unknown) => {
      if (!(err instanceof Vid2ContextError)) throw err;
      return err;
    },
  );
}

const callBodies = (fetch: ReplayFetch): Record<string, unknown>[] =>
  fetch.calls.map((c) => ({ endpoint: endpointOf(c), ...bodyOf(c) }));

beforeEach(() => resetBreaker());

describe('matchYouTube list inputs', () => {
  it.each([
    // channels, with and without tabs
    ['https://www.youtube.com/@alliancemotorworks', 'channel', 'youtube:channel:@alliancemotorworks', '@alliancemotorworks'],
    [
      'https://www.youtube.com/@alliancemotorworks/videos',
      'channel',
      'youtube:channel:@alliancemotorworks/videos',
      '@alliancemotorworks',
    ],
    ['youtube.com/@NASA/shorts', 'channel', 'youtube:channel:@NASA/shorts', '@NASA'],
    ['https://m.youtube.com/@NASA/streams', 'channel', 'youtube:channel:@NASA/streams', '@NASA'],
    ['https://www.youtube.com/@NASA/playlists?view=1', 'channel', 'youtube:channel:@NASA/playlists', '@NASA'],
    ['https://www.youtube.com/@NASA/featured', 'channel', 'youtube:channel:@NASA/featured', '@NASA'],
    ['https://www.youtube.com/@NASA/community', 'channel', 'youtube:channel:@NASA', '@NASA'],
    [
      'https://www.youtube.com/channel/UCdEjP_BjQ5audhxLKKzZl2A/videos',
      'channel',
      'youtube:channel:UCdEjP_BjQ5audhxLKKzZl2A/videos',
      'UCdEjP_BjQ5audhxLKKzZl2A',
    ],
    [
      'https://music.youtube.com/channel/UCdEjP_BjQ5audhxLKKzZl2A',
      'channel',
      'youtube:channel:UCdEjP_BjQ5audhxLKKzZl2A',
      'UCdEjP_BjQ5audhxLKKzZl2A',
    ],
    ['https://www.youtube.com/c/GoogleDevelopers', 'channel', 'youtube:channel:c:GoogleDevelopers', 'c:GoogleDevelopers'],
    [
      'https://www.youtube.com/user/GoogleDevelopers/videos',
      'channel',
      'youtube:channel:user:GoogleDevelopers/videos',
      'user:GoogleDevelopers',
    ],
    // playlists
    [
      'https://www.youtube.com/playlist?list=PLHeawKfarQSPKIjpe86at3Ttc2sz7uD_b',
      'playlist',
      'youtube:playlist:PLHeawKfarQSPKIjpe86at3Ttc2sz7uD_b',
      'PLHeawKfarQSPKIjpe86at3Ttc2sz7uD_b',
    ],
    [
      'https://www.youtube.com/watch?list=PL59FEE129ADFF2B12',
      'playlist',
      'youtube:playlist:PL59FEE129ADFF2B12',
      'PL59FEE129ADFF2B12',
    ],
    [
      'https://www.youtube.com/playlist?list=UULA_DiR1FfKNvjuUpBHmylQ',
      'playlist',
      'youtube:playlist:UULA_DiR1FfKNvjuUpBHmylQ',
      'UULA_DiR1FfKNvjuUpBHmylQ',
    ],
    [
      'https://music.youtube.com/playlist?list=OLAK5uy_kXBLmmc8Gq4lIzSFK1yw6NUFtFqwdpGHs',
      'playlist',
      'youtube:playlist:OLAK5uy_kXBLmmc8Gq4lIzSFK1yw6NUFtFqwdpGHs',
      'OLAK5uy_kXBLmmc8Gq4lIzSFK1yw6NUFtFqwdpGHs',
    ],
    [
      'https://www.youtube.com/embed/videoseries?list=PLwP_SiAcdui0KVebT0mU9Apz359a4ubsC',
      'playlist',
      'youtube:playlist:PLwP_SiAcdui0KVebT0mU9Apz359a4ubsC',
      'PLwP_SiAcdui0KVebT0mU9Apz359a4ubsC',
    ],
    // search
    ['ytsearch:g wagon buyers guide', 'playlist', 'youtube:ytsearch:g wagon buyers guide', 'ytsearch:g wagon buyers guide'],
    ['ytsearch5:g wagon buyers guide', 'playlist', 'youtube:ytsearch5:g wagon buyers guide', 'ytsearch5:g wagon buyers guide'],
    [
      'https://www.youtube.com/results?search_query=g+wagon+buyers+guide',
      'playlist',
      'youtube:ytsearch:g wagon buyers guide',
      'ytsearch:g wagon buyers guide',
    ],
  ])('%s', (input, kind, id, nativeId) => {
    const r = ref(input);
    expect(r).toMatchObject({ platform: 'youtube', kind, id, nativeId, input });
  });

  it('keeps a watch URL with both v= and list= a video ref', () => {
    expect(ref('https://www.youtube.com/watch?v=cCPsdFdlshc&list=PLHeawKfarQSPKIjpe86at3Ttc2sz7uD_b').id).toBe(
      'youtube:cCPsdFdlshc',
    );
    expect(ref('https://www.youtube.com/watch?v=cCPsdFdlshc&list=RDcCPsdFdlshc').id).toBe('youtube:cCPsdFdlshc');
  });

  it('finds the playlist a video URL sits in, never a mix', () => {
    const input = 'https://www.youtube.com/watch?v=PzJL3aBRas8&list=PLHeawKfarQSPKIjpe86at3Ttc2sz7uD_b';
    expect(matchYouTubeList(input)).toEqual({
      input,
      platform: 'youtube',
      kind: 'playlist',
      id: 'youtube:playlist:PLHeawKfarQSPKIjpe86at3Ttc2sz7uD_b',
      nativeId: 'PLHeawKfarQSPKIjpe86at3Ttc2sz7uD_b',
      url: 'https://www.youtube.com/playlist?list=PLHeawKfarQSPKIjpe86at3Ttc2sz7uD_b',
    });
    expect(matchYouTubeList('https://youtu.be/PzJL3aBRas8?list=PLHeawKfarQSPKIjpe86at3Ttc2sz7uD_b&index=1')?.nativeId).toBe(
      'PLHeawKfarQSPKIjpe86at3Ttc2sz7uD_b',
    );
    expect(matchYouTubeList('https://www.youtube.com/watch?v=cCPsdFdlshc&list=RDcCPsdFdlshc')).toBeNull();
    expect(matchYouTubeList('https://www.youtube.com/watch?v=cCPsdFdlshc')).toBeNull();
    expect(matchYouTubeList('https://www.youtube.com/playlist?list=PLHeawKfarQSPKIjpe86at3Ttc2sz7uD_b')).toBeNull();
    expect(matchYouTubeList('https://www.youtube.com/watch?v=cCPsdFdlshc&list=WL')).toBeNull();
  });

  it('builds canonical URLs for list refs', () => {
    expect(ref('https://www.youtube.com/@alliancemotorworks/videos').url).toBe(
      'https://www.youtube.com/@alliancemotorworks/videos',
    );
    expect(ref('https://www.youtube.com/user/GoogleDevelopers').url).toBe('https://www.youtube.com/user/GoogleDevelopers');
    expect(ref('ytsearch3:g wagon').url).toBe('https://www.youtube.com/results?search_query=g%20wagon');
  });

  it('rejects mixes and malformed searches with unsupported-input', () => {
    expect(() => matchYouTube('https://www.youtube.com/playlist?list=RDcCPsdFdlshc')).toThrow(
      expect.objectContaining({ code: 'unsupported-input' }),
    );
    expect(() => matchYouTube('ytsearch:   ')).toThrow(expect.objectContaining({ code: 'unsupported-input' }));
    expect(() => matchYouTube('ytsearch0:cats')).toThrow(expect.objectContaining({ code: 'unsupported-input' }));
    expect(() => matchYouTube('ytsearch201:cats')).toThrow(expect.objectContaining({ code: 'unsupported-input' }));
  });

  it.each([
    'https://vimeo.com/channels/staffpicks',
    'https://example.com/@alliancemotorworks',
    'https://example.com/playlist?list=PLHeawKfarQSPKIjpe86at3Ttc2sz7uD_b',
    'https://notyoutube.com/results?search_query=cats',
    'https://www.youtube.com/feed/subscriptions',
    'https://www.youtube.com/results',
    'https://www.youtube.com/@',
    'https://www.youtube.com/channel/not-a-channel-id',
    'https://www.youtube.com/playlist?list=WL',
    'search: cats',
    'ytsearchfoo:cats',
  ])('does not match %s', (input) => {
    expect(matchYouTube(input)).toBeNull();
  });
});

describe('listYouTube: playlists', () => {
  it('lists a playlist in playlist order with refs like single-video refs plus the listed title', async () => {
    const { ctx, fetch } = setup();
    const input = 'https://www.youtube.com/playlist?list=PLHeawKfarQSPKIjpe86at3Ttc2sz7uD_b';
    const refs: VideoRef[] = [];
    for await (const r of listYouTube(ref(input), ctx)) refs.push(r);
    expect(refs.map((r) => r.nativeId)).toEqual([
      'PzJL3aBRas8',
      '1Xx1fmHIsiA',
      'AS6LYBzFtEU',
      'EO1PYUnXHiM',
      'U7Dmgpp5W-Q',
      ...refs.slice(5).map((r) => r.nativeId),
    ]);
    expect(refs).toHaveLength(9);
    expect(refs[0]).toEqual({
      ...videoRef(input, 'PzJL3aBRas8'),
      title: "Why I'm Selling My DREAM G-Wagon (Custom Build 2015 Mercedes G550)",
    });
    expect(callBodies(fetch)).toEqual([
      { endpoint: 'browse', browseId: 'VLPLHeawKfarQSPKIjpe86at3Ttc2sz7uD_b', params: 'wgYCCAA%3D' },
    ]);
  });

  it('follows continuation pages and stops requesting once the limit is reached', async () => {
    const input = 'https://www.youtube.com/playlist?list=UULA_DiR1FfKNvjuUpBHmylQ';
    const all = setup();
    const many = await ids(input, all.ctx, 150);
    expect(many).toHaveLength(150);
    expect(new Set(many).size).toBe(150);
    expect(all.fetch.calls).toHaveLength(2);
    expect(bodyOf(all.fetch.calls[1] as RecordedCall)).toHaveProperty('continuation');

    // The first page holds exactly 100 items: a limit of 100 must not fetch page 2.
    const exact = setup();
    expect(await ids(input, exact.ctx, 100)).toEqual(many.slice(0, 100));
    expect(exact.fetch.calls).toHaveLength(1);

    const few = setup();
    expect(await ids(input, few.ctx, 10)).toEqual(many.slice(0, 10));
    expect(few.fetch.calls).toHaveLength(1);
  });

  it('de-duplicates and ignores the related-playlists continuation', async () => {
    const { ctx, fetch, log } = setup();
    const list = await ids('https://www.youtube.com/playlist?list=PLwP_SiAcdui0KVebT0mU9Apz359a4ubsC', ctx);
    // The playlist shows 96 videos; MxMrnsxX9ZA is in it twice.
    expect(list).toHaveLength(95);
    expect(list.filter((id) => id === 'MxMrnsxX9ZA')).toHaveLength(1);
    expect(fetch.calls).toHaveLength(1);
    expect(log.lines.find((l) => l.msg === 'youtube: skipped list entries')?.data).toMatchObject({
      duplicates: 1,
      unavailable: 0,
    });
  });

  it('skips private and deleted entries and counts them in a log line', async () => {
    const { ctx, log } = setup();
    const list = await ids('https://www.youtube.com/playlist?list=PL59FEE129ADFF2B12', ctx);
    expect(list).toEqual([
      'EjN5avRvApk',
      'nnsSUqgkDwU',
      'xgrcK9Ozb_Q',
      'oXHHkROejik',
      'Hhgfz0zPmH4',
      'EKuG2M6R4VM',
      'BrXPcaRlBqo',
      'dsUXAEzaC3Q',
    ]);
    expect(log.lines.find((l) => l.msg === 'youtube: skipped list entries')?.data).toMatchObject({ unavailable: 3, listed: 8 });
  });

  it('maps a playlist that does not exist to not-found', async () => {
    const { ctx } = setup();
    const err = await errorOf(ids('https://www.youtube.com/playlist?list=PLtPgu7CB4gbY9oDN3drwC3cMbJggS7dKl', ctx));
    expect(err.code).toBe('not-found');
    expect(err.message).toContain('The playlist does not exist.');
    expect(err.hint).toBeTruthy();
  });

  it('respects ctx.signal between pages', async () => {
    const controller = new AbortController();
    const { ctx, fetch } = setup({ signal: controller.signal });
    const seen: string[] = [];
    const run = (async () => {
      for await (const r of listYouTube(ref('https://www.youtube.com/playlist?list=UULA_DiR1FfKNvjuUpBHmylQ'), ctx)) {
        seen.push(r.nativeId);
        if (seen.length === 1) controller.abort();
      }
    })();
    await expect(run).rejects.toMatchObject({ name: 'AbortError' });
    // The rest of page 1 is already in memory; page 2 is never requested.
    expect(seen).toHaveLength(100);
    expect(fetch.calls).toHaveLength(1);
  });
});

describe('listYouTube: channels', () => {
  it('resolves a handle, then lists every upload through the UU playlist, newest first', async () => {
    const { ctx, fetch } = setup();
    const list = await ids('https://www.youtube.com/@alliancemotorworks', ctx);
    expect(list).toHaveLength(89);
    expect(list.slice(0, 2)).toEqual(['R12_oVK4QmY', 'jd7NraQ9WAg']);
    expect(callBodies(fetch)).toEqual([
      { endpoint: 'navigation/resolve_url', url: 'https://www.youtube.com/@alliancemotorworks/videos' },
      { endpoint: 'browse', browseId: 'VLUUdEjP_BjQ5audhxLKKzZl2A', params: 'wgYCCAA%3D' },
    ]);
  });

  it('falls back to the tab when the upload playlist is missing, and lists nothing when the tab is absent', async () => {
    const { ctx, fetch, log } = setup();
    // This channel has no live streams: UULV... does not exist, and the streams
    // request answers with the Home tab selected.
    expect(await ids('https://www.youtube.com/@alliancemotorworks/streams', ctx)).toEqual([]);
    expect(callBodies(fetch).map((c) => c.browseId ?? c.url)).toEqual([
      'https://www.youtube.com/@alliancemotorworks/streams',
      'VLUULVdEjP_BjQ5audhxLKKzZl2A',
      'UCdEjP_BjQ5audhxLKKzZl2A',
    ]);
    expect(log.lines.some((l) => l.msg.includes('no such tab'))).toBe(true);
  });

  it('expands the playlists tab into the videos of each playlist, de-duplicated', async () => {
    const { ctx, fetch } = setup();
    const list = await ids('https://www.youtube.com/@alliancemotorworks/playlists', ctx);
    expect(list).toHaveLength(32);
    expect(new Set(list).size).toBe(32);
    // The G-Wagon Buyer's Guide is one of the four playlists on the tab.
    const browsed = callBodies(fetch).map((c) => c.browseId);
    expect(browsed).toContain('VLPLHeawKfarQSPKIjpe86at3Ttc2sz7uD_b');
    expect(browsed.filter((b) => typeof b === 'string' && b.startsWith('VLPL'))).toHaveLength(4);
  });

  it('maps a handle that does not exist to not-found', async () => {
    const { ctx } = setup();
    const err = await errorOf(ids('https://www.youtube.com/@thishandledoesnotexist-zq9x7k2', ctx));
    expect(err.code).toBe('not-found');
    expect(err.hint).toBeTruthy();
  });

  it('maps a channel id that does not exist to not-found after trying the shortcut', async () => {
    const { ctx, fetch } = setup();
    const err = await errorOf(ids('https://www.youtube.com/channel/UCxxxxxxxxxxxxxxxxxxxxxx/videos', ctx));
    expect(err.code).toBe('not-found');
    expect(err.message).toContain('This channel does not exist.');
    expect(callBodies(fetch).map((c) => c.endpoint)).toEqual(['browse', 'navigation/resolve_url', 'browse']);
  });

  it('parses a channel videos tab and its continuation page', () => {
    const first = parsePage(JSON.parse(read('browse-nasa-videos-tab.json')), { continuation: false });
    expect(first.selectedTab).toBe('videos');
    expect(first.items).toHaveLength(30);
    expect(first.items.every((i) => i.type === 'video' && i.available)).toBe(true);
    expect(first.next).toBeTruthy();
    const second = parsePage(JSON.parse(read('browse-nasa-videos-tab-p2.json')), { continuation: true });
    expect(second.items.length).toBeGreaterThan(0);
    const firstIds = new Set(first.items.map((i) => i.id));
    expect(second.items.some((i) => firstIds.has(i.id))).toBe(false);
  });
});

describe('listYouTube: search', () => {
  it('pages through search results up to the requested count', async () => {
    const { ctx, fetch } = setup();
    const list = await ids('ytsearch30:g wagon buyers guide', ctx);
    expect(list).toHaveLength(30);
    expect(new Set(list).size).toBe(30);
    expect(list.slice(0, 2)).toEqual(['13OYIYC_rlE', 'cCPsdFdlshc']);
    expect(callBodies(fetch)[0]).toEqual({ endpoint: 'search', query: 'g wagon buyers guide', params: 'EgIQAQ%3D%3D' });
    expect(fetch.calls).toHaveLength(2);
  });

  it('defaults to 20 results and honours a smaller count or limit', async () => {
    const def = setup();
    expect(await ids('ytsearch:g wagon buyers guide', def.ctx)).toHaveLength(20);
    expect(def.fetch.calls).toHaveLength(1);
    const five = setup();
    expect(await ids('ytsearch5:g wagon buyers guide', five.ctx)).toHaveLength(5);
    const limited = setup();
    expect(await ids('ytsearch30:g wagon buyers guide', limited.ctx, 3)).toHaveLength(3);
  });
});

describe('a video URL inside a playlist', () => {
  const WATCH = 'https://www.youtube.com/watch?v=PzJL3aBRas8&list=PLHeawKfarQSPKIjpe86at3Ttc2sz7uD_b';
  const registry = new Registry([youtubeSource], 'node');

  it('resolves to the video, with the playlist beside it', () => {
    const { ref: video, list } = registry.resolve(WATCH);
    expect(video.id).toBe('youtube:PzJL3aBRas8');
    expect(list?.id).toBe('youtube:playlist:PLHeawKfarQSPKIjpe86at3Ttc2sz7uD_b');
    expect(registry.resolve('https://www.youtube.com/watch?v=PzJL3aBRas8').list).toBeUndefined();
  });

  it('expands to the one video by default, without a request', async () => {
    const { ctx, fetch } = setup();
    expect((await expandInput(registry, WATCH, ctx)).map((r) => r.id)).toEqual(['youtube:PzJL3aBRas8']);
    expect(fetch.calls).toHaveLength(0);
  });

  it('expands to every video of the playlist with list: true', async () => {
    const { ctx } = setup();
    const refs = await expandInput(registry, WATCH, ctx, { list: true });
    expect(refs).toHaveLength(9);
    expect(refs[0]?.nativeId).toBe('PzJL3aBRas8');
    expect((await expandInput(registry, WATCH, setup().ctx, { list: true, limit: 3 })).length).toBe(3);
  });

  it('leaves inputs without a playlist alone under list: true', async () => {
    const { ctx } = setup();
    const refs = await expandInput(registry, 'https://www.youtube.com/watch?v=cCPsdFdlshc&list=RDcCPsdFdlshc', ctx, {
      list: true,
    });
    expect(refs.map((r) => r.id)).toEqual(['youtube:cCPsdFdlshc']);
  });
});

describe('listing hints: title and duration', () => {
  it('reads each lockup title and its duration badge', () => {
    const page = parsePage(JSON.parse(read('browse-gwagon-badges.json')), { continuation: false });
    const videos = page.items.filter((i) => i.type === 'video');
    expect(videos).toHaveLength(9);
    expect(videos[0]).toEqual({
      type: 'video',
      id: 'PzJL3aBRas8',
      available: true,
      title: "Why I'm Selling My DREAM G-Wagon (Custom Build 2015 Mercedes G550)",
      durationSec: 698,
    });
    expect(videos.map((v) => (v.type === 'video' ? v.durationSec : undefined))).toEqual([
      698, 907, 1354, 539, 1285, 1834, 721, 822, 1084,
    ]);
  });

  it('reads title and lengthText from classic video renderers', () => {
    const page = parsePage(JSON.parse(read('search-search.json')), {
      continuation: false,
      sectionLevelNext: true,
      skipShelves: true,
    });
    expect(page.items[0]).toMatchObject({
      type: 'video',
      title: 'Mercedes G Wagon W463 buyers guide (1990-2017) Common problems and costly repairs to avoid G-Class',
      durationSec: 2544,
    });
  });

  it('gives unavailable entries no title', () => {
    const page = parsePage(JSON.parse(read('browse-unavailable.json')), { continuation: false });
    const hidden = page.items.filter((i) => i.type === 'video' && !i.available);
    expect(hidden.length).toBe(3);
    for (const h of hidden) expect(h).not.toHaveProperty('title');
  });

  it('parses clock durations and nothing else', () => {
    expect(clockSeconds('8:59')).toBe(539);
    expect(clockSeconds('1:02:03')).toBe(3723);
    expect(clockSeconds('0:07')).toBe(7);
    expect(clockSeconds('LIVE')).toBeUndefined();
    expect(clockSeconds('SHORTS')).toBeUndefined();
    expect(clockSeconds('1:2')).toBeUndefined();
    expect(clockSeconds(undefined)).toBeUndefined();
  });
});

describe('listMetadata', () => {
  it('reads playlist metadata from the browse response', async () => {
    const { ctx } = setup();
    const m = await listMetadata(ref('https://www.youtube.com/playlist?list=PLHeawKfarQSPKIjpe86at3Ttc2sz7uD_b'), ctx);
    expect(m.title).toBe("G-Wagon Buyer's Guide");
    expect(m.channel).toEqual({
      name: 'Alliance Motorworks',
      id: 'UCdEjP_BjQ5audhxLKKzZl2A',
      url: 'https://www.youtube.com/@alliancemotorworks',
    });
    expect(m.description).toContain('G Wagon');
    expect(m.thumbnailUrl).toMatch(/^https:\/\/i\.ytimg\.com\//);
    expect(m.chapters).toEqual([]);
    expect(m.extra).toEqual({ kind: 'playlist', itemCount: 9 });
  });

  it('reads channel metadata after resolving the handle', async () => {
    const { ctx } = setup();
    const m = await listMetadata(ref('https://www.youtube.com/@alliancemotorworks'), ctx);
    expect(m.title).toBe('Alliance Motorworks');
    expect(m.channel).toMatchObject({ name: 'Alliance Motorworks', id: 'UCdEjP_BjQ5audhxLKKzZl2A' });
    expect(m.extra).toMatchObject({ kind: 'channel', handle: '@alliancemotorworks' });
    expect(typeof (m.extra as { itemCount?: unknown }).itemCount).toBe('number');
  });

  it('describes a search without any request', async () => {
    const { ctx, fetch } = setup();
    const m = await listMetadata(ref('ytsearch5:g wagon buyers guide'), ctx);
    expect(m).toMatchObject({ title: 'YouTube search: g wagon buyers guide', extra: { kind: 'search', count: 5 } });
    expect(fetch.calls).toHaveLength(0);
  });

  it('maps a missing playlist to not-found', async () => {
    const { ctx } = setup();
    const err = await errorOf(listMetadata(ref('https://www.youtube.com/playlist?list=PLtPgu7CB4gbY9oDN3drwC3cMbJggS7dKl'), ctx));
    expect(err.code).toBe('not-found');
  });
});

// Live: real innertube calls. Run with LIVE=1. The G-Wagon Buyer's Guide
// playlist (Alliance Motorworks, 9 public videos on 2026-11-14) is the owner's
// motivating series.
describe.skipIf(!process.env.LIVE)('live YouTube lists', () => {
  const live = () => createContext({ runtime: 'node', env: {} });
  const registry = new Registry([youtubeSource], 'node');
  const GWAGON = 'https://www.youtube.com/playlist?list=PLHeawKfarQSPKIjpe86at3Ttc2sz7uD_b';

  it('expands a public playlist in order through expandInput', async () => {
    const refs = await expandInput(registry, GWAGON, live(), { limit: 10 });
    console.error('live playlist', JSON.stringify(refs.map((r) => r.id)));
    expect(refs.length).toBeGreaterThanOrEqual(3);
    expect(refs[0]).toMatchObject(videoRef(GWAGON, refs[0]?.nativeId ?? ''));
    expect(new Set(refs.map((r) => r.id)).size).toBe(refs.length);
  }, 60_000);

  it('returns 5 video refs for ytsearch5:', async () => {
    const refs = await expandInput(registry, 'ytsearch5:g wagon buyers guide', live());
    console.error('live search', JSON.stringify(refs.map((r) => r.id)));
    expect(refs).toHaveLength(5);
    expect(refs.every((r) => r.kind === 'video' && /^youtube:[A-Za-z0-9_-]{11}$/.test(r.id))).toBe(true);
  }, 60_000);

  it('lists a channel by handle, newest first', async () => {
    const refs = await expandInput(registry, 'https://www.youtube.com/@alliancemotorworks/videos', live(), { limit: 5 });
    console.error('live channel', JSON.stringify(refs.map((r) => r.id)));
    expect(refs).toHaveLength(5);
  }, 60_000);

  it('reads playlist metadata', async () => {
    const m = await youtubeSource.getMetadata(registry.resolve(GWAGON).ref, live());
    expect(m.title).toBe("G-Wagon Buyer's Guide");
    expect(m.extra).toMatchObject({ kind: 'playlist' });
  }, 60_000);
});

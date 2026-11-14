import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createContext, getVideoContext, Registry, Vid2ContextError, type VideoRef } from '@vid2context/core';
import { type RecordedCall, type Route, replayFetch, testContext } from '@vid2context/core/testing';
import { describe, expect, it } from 'vitest';
import { bilibiliCaptions, bilibiliSource } from '../src/index.ts';
import { md5Hex } from '../src/md5.ts';
import { av2bv, bv2av, matchBilibili, parseRef } from '../src/url.ts';
import { mixinKey, signQuery } from '../src/wbi.ts';

// Fixtures are real recordings (see test/fixtures/README.md).
const text = (name: string) => readFileSync(join(import.meta.dirname, 'fixtures', name), 'utf8');
const bytes = (name: string) => new Uint8Array(readFileSync(join(import.meta.dirname, 'fixtures', name)));
const json = { 'content-type': 'application/json; charset=utf-8' };
const API = 'https://api.bilibili.com';

const MULTI = 'BV1Sx411S71m'; // 38 parts, creator subtitles in German (de-DE)
const PLAIN = 'BV1xx411c79H'; // av706, one part, no subtitles
const AI = 'BV1GPWi6SECk'; // AI subtitles (ai-zh)

const nav = JSON.parse(text('nav.json')) as { data: { wbi_img: { img_url: string; sub_url: string } } };
const KEY = mixinKey(nav.data.wbi_img.img_url, nav.data.wbi_img.sub_url);

/** Recorded player and playurl responses, served only when the request carries a valid WBI signature. */
function signed(path: string, file: string): Route {
  return {
    url: (u) => u.href.startsWith(`${API}${path}?`),
    response: (call: RecordedCall) => {
      const q = new URL(call.url).searchParams;
      const rid = q.get('w_rid');
      q.delete('w_rid');
      const params = Object.fromEntries([...q.entries()].filter(([k]) => k !== 'wts'));
      if (rid !== signQuery(params, KEY, Number(q.get('wts'))).split('w_rid=')[1])
        throw new Error(`bad WBI signature on ${call.url}`);
      return { body: text(file), headers: json };
    },
  };
}

function biliReplay(extra: Route[] = []) {
  return replayFetch([
    ...extra,
    { url: `${API}/x/web-interface/nav`, response: { body: text('nav.json'), headers: json } },
    ...[MULTI, PLAIN, AI].flatMap((b) => [
      { url: `${API}/x/web-interface/view?bvid=${b}`, response: { body: text(`view-${b}.json`), headers: json } },
      { url: `${API}/x/tag/archive/tags?bvid=${b}`, response: { body: text(`tags-${b}.json`), headers: json } },
    ]),
    { url: `${API}/x/web-interface/view?bvid=BV1GJ411x7h7`, response: { body: text('view-not-found.json'), headers: json } },
    { url: `${API}/x/web-interface/view?bvid=BV1Tv411T7uh`, response: { body: text('view-invisible.json'), headers: json } },
    {
      url: `${API}/x/v2/dm/view?type=1&oid=139538988&pid=9775917`,
      response: { body: text('dmview-139538988.json'), headers: json },
    },
    {
      url: `${API}/x/v2/dm/view?type=1&oid=139551808&pid=9775917`,
      response: { body: text('dmview-139551808.json'), headers: json },
    },
    { url: `${API}/x/v2/dm/view?type=1&oid=3724723&pid=706`, response: { body: text('dmview-3724723.json'), headers: json } },
    {
      url: `${API}/x/v2/dm/view?type=1&oid=43572004328&pid=117608837881830`,
      response: { body: text('dmview-43572004328.json'), headers: json },
    },
    signed('/x/player/wbi/v2', 'player-BV1Sx411S71m-139538988.json'),
    signed('/x/player/wbi/playurl', 'playurl-BV1xx411c79H-3724723.json'),
    ...['33b9371132e0bbec2e862c19d4b289f739cbb536', 'a74dab831cee9d3ef875379c6e17c54142ed7d56'].map((h) => ({
      url: `https://aisubtitle.hdslb.com/bfs/subtitle/${h}.json`,
      response: { body: text(`subtitle-${h}.json`), headers: json },
    })),
    {
      url: 'https://aisubtitle.hdslb.com/bfs/ai_subtitle/prod/117608837881830435720043283380072d1a5b5e20b73876e6f09b3fa3',
      response: { body: text('subtitle-ai-117608837881830435720043283380072d1a5b5e20b73876e6f09b3fa3.json'), headers: json },
    },
  ]);
}

const ref = (input: string): VideoRef => {
  const r = matchBilibili(input);
  if (!r) throw new Error(`no match for ${input}`);
  return r;
};

async function rejection(p: Promise<unknown> | undefined): Promise<Vid2ContextError> {
  try {
    await p;
  } catch (err) {
    if (err instanceof Vid2ContextError) return err;
    throw err;
  }
  throw new Error('expected a rejection');
}

describe('ids and URLs', () => {
  it('converts av numbers and BV ids both ways (pairs from the view API)', () => {
    for (const [aid, bvid] of [
      [706, 'BV1xx411c79H'],
      [9775917, 'BV1Sx411S71m'],
      [6731067, 'BV1ys411472E'],
      [941747210, 'BV1qW4y1a7fU'],
      [117608837881830, 'BV1GPWi6SECk'],
    ] as const) {
      expect(av2bv(aid)).toBe(bvid);
      expect(bv2av(bvid)).toBe(aid);
    }
  });

  it.each([
    ['https://www.bilibili.com/video/BV1xx411c79H', 'bilibili:BV1xx411c79H', 'video'],
    ['https://www.bilibili.com/video/BV1xx411c79H/?spm_id_from=333.788', 'bilibili:BV1xx411c79H', 'video'],
    ['https://www.bilibili.com/video/av706', 'bilibili:BV1xx411c79H', 'video'],
    ['bilibili.com/video/BV1Sx411S71m?p=2', 'bilibili:BV1Sx411S71m_p2', 'video'],
    ['https://www.bilibili.com/video/BV1Sx411S71m?p=1', 'bilibili:BV1Sx411S71m', 'video'],
    ['https://www.bilibili.com/video/BV1Sx411S71m?p=all', 'bilibili:playlist:BV1Sx411S71m', 'playlist'],
    ['https://m.bilibili.com/video/BV1xx411c79H', 'bilibili:BV1xx411c79H', 'video'],
    ['https://player.bilibili.com/player.html?aid=706&page=1', 'bilibili:BV1xx411c79H', 'video'],
    ['https://player.bilibili.com/player.html?bvid=BV1Sx411S71m&p=3', 'bilibili:BV1Sx411S71m_p3', 'video'],
    ['https://b23.tv/BV1xx411c79H', 'bilibili:BV1xx411c79H', 'video'],
    ['https://b23.tv/aBcD123', 'bilibili:b23:aBcD123', 'video'],
    ['BV1xx411c79H', 'bilibili:BV1xx411c79H', 'video'],
    ['av706', 'bilibili:BV1xx411c79H', 'video'],
  ])('%s -> %s', (input, id, kind) => {
    expect(matchBilibili(input)).toMatchObject({ id, kind, platform: 'bilibili' });
  });

  it('builds canonical refs and rejects other inputs', () => {
    expect(ref('https://www.bilibili.com/video/av706?p=2')).toEqual({
      input: 'https://www.bilibili.com/video/av706?p=2',
      platform: 'bilibili',
      kind: 'video',
      id: 'bilibili:BV1xx411c79H_p2',
      nativeId: 'BV1xx411c79H_p2',
      url: 'https://www.bilibili.com/video/BV1xx411c79H?p=2',
    });
    expect(parseRef(ref('https://b23.tv/aBcD123'))).toEqual({ short: 'aBcD123' });
    for (const input of [
      'https://www.youtube.com/watch?v=jNQXAC9IVRw',
      'https://www.bilibili.com/bangumi/play/ep21495/',
      'https://space.bilibili.com/15282326',
      'https://www.bilibili.com/video/BV1xx411c79',
      'jNQXAC9IVRw',
    ]) {
      expect(matchBilibili(input), input).toBeNull();
    }
  });
});

describe('WBI signature', () => {
  it('implements MD5', () => {
    expect(md5Hex('')).toBe('d41d8cd98f00b204e9800998ecf8427e');
    expect(md5Hex('The quick brown fox jumps over the lazy dog')).toBe('9e107d9d372bb6826bd81d3542a419d6');
    expect(md5Hex('中文')).toBe('a7bac2239fcdcb3a067903d8077c4a07');
    expect(md5Hex('a'.repeat(200))).toBe('887f30b43b2867f4a9accceee7d16e6c');
  });

  it('derives the mixin key from the recorded nav keys and signs like bilibili and yt-dlp', () => {
    // nav.json returned these image stems on 2026-11-14; the expected values come from yt-dlp's
    // _get_wbi_key/_sign_wbi run in Python on the same input (the documented example vector).
    expect(KEY).toBe('ea1db124af3c7062474693fa704f4ff8');
    expect(signQuery({ foo: '114', bar: '514', zab: 1919810 }, KEY, 1702204169)).toBe(
      'bar=514&foo=114&wts=1702204169&zab=1919810&w_rid=8f6f2b5b3d485fe1886cec6a0be8c5d4',
    );
    expect(signQuery({ bvid: 'BV1xx411c79H', cid: 3724723, fnval: 16 }, KEY, 1794676000)).toBe(
      'bvid=BV1xx411c79H&cid=3724723&fnval=16&wts=1794676000&w_rid=f2c7702fb6ed9a5d27efed094866c6fc',
    );
    expect(signQuery({ keyword: "it's (ok)!*" }, KEY, 1).startsWith('keyword=its%20ok&wts=1&')).toBe(true);
  });
});

describe('metadata', () => {
  it('maps the view API, tags and the requested part of a multi-part video', async () => {
    const fetch = biliReplay();
    const ctx = testContext({ fetch });
    const meta = await bilibiliSource.getMetadata(ref(`https://www.bilibili.com/video/${MULTI}?p=2`), ctx);
    expect(meta).toMatchObject({
      title: '【德语CC字幕】Kurzgesagt德语科普【38P合集】 (P2 2Was kam vor der Geschichte_ Der Ursprung der Menschheit)',
      channel: { name: 'Deutschlernen-', id: '15282326', url: 'https://space.bilibili.com/15282326' },
      durationSec: 577,
      publishedAt: '2017-04-11T13:34:27.000Z',
      chapters: [],
      extra: { bvid: MULTI, aid: 9775917, cid: 139551808, part: 2, parts: 38, original: false },
    });
    expect(meta.thumbnailUrl).toMatch(/^https:\/\/i\d\.hdslb\.com\/bfs\/archive\//);
    expect(meta.tags).toContain('科学');
    // The player call (chapters) is WBI-signed; the replay route rejects a bad signature.
    expect(fetch.calls.some((c) => c.url.includes('/x/player/wbi/v2?') && c.url.includes('w_rid='))).toBe(true);
    expect(fetch.calls.every((c) => !c.url.startsWith(API) || c.headers.referer === 'https://www.bilibili.com/')).toBe(true);
  });

  it('describes single videos and lists the parts of a multi-part one', async () => {
    const ctx = testContext({ fetch: biliReplay() });
    const meta = await bilibiliSource.getMetadata(ref(`https://www.bilibili.com/video/av706`), ctx);
    expect(meta).toMatchObject({
      title: '【東方】Bad Apple!! ＰＶ【影絵】',
      durationSec: 219,
      channel: { name: '折射' },
      extra: { parts: 1, cid: 3724723 },
    });
    expect(meta.tags?.[0]).toBe('BAD APPLE!!');

    const list = ref(`https://www.bilibili.com/video/${MULTI}?p=all`);
    expect((await bilibiliSource.getMetadata(list, ctx)).extra?.parts).toHaveLength(38);
    const items: VideoRef[] = [];
    for await (const item of bilibiliSource.listItems?.(list, ctx, { limit: 3 }) ?? []) items.push(item);
    expect(items.map((i) => i.id)).toEqual([`bilibili:${MULTI}`, `bilibili:${MULTI}_p2`, `bilibili:${MULTI}_p3`]);
    expect(items[2]?.url).toBe(`https://www.bilibili.com/video/${MULTI}?p=3`);
  });

  it('maps API error codes and missing parts', async () => {
    const ctx = testContext({ fetch: biliReplay() });
    expect((await rejection(bilibiliSource.getMetadata(ref('BV1GJ411x7h7'), ctx))).code).toBe('not-found');
    expect((await rejection(bilibiliSource.getMetadata(ref('BV1Tv411T7uh'), ctx))).code).toBe('unavailable');
    const missing = await rejection(bilibiliSource.getMetadata(ref(`https://www.bilibili.com/video/${MULTI}?p=99`), ctx));
    expect(missing.code).toBe('not-found');
    expect(missing.hint).toContain('?p=all');
  });

  it('resolves b23.tv short links with one HEAD request inside getMetadata', async () => {
    const b23 = JSON.parse(text('b23-BV1xx411c79H.json')) as { status: number; headers: Record<string, string> };
    const fetch = biliReplay([
      { method: 'HEAD', url: 'https://b23.tv/aBcD123', response: { status: b23.status, headers: b23.headers, body: '' } },
    ]);
    const short = ref('https://b23.tv/aBcD123');
    expect(fetch.calls).toHaveLength(0);
    const meta = await bilibiliSource.getMetadata(short, testContext({ fetch }));
    expect(meta.ref.id).toBe(`bilibili:${PLAIN}`);
    expect(meta.title).toBe('【東方】Bad Apple!! ＰＶ【影絵】');
    expect(fetch.calls.filter((c) => c.method === 'HEAD')).toHaveLength(1);
  });
});

describe('captions', () => {
  it('maps creator subtitles of the requested part to segments', async () => {
    const ctx = testContext({ fetch: biliReplay() });
    const t = await bilibiliCaptions.getCaptions(ref(MULTI), {}, ctx);
    expect(t).toMatchObject({ language: 'de-DE', origin: 'creator-captions', producer: 'bilibili-captions' });
    expect(t?.segments[1]).toEqual({
      startSec: 1.08,
      endSec: 4.84,
      text: 'Impfungen sind wahnsinnig wichtig für die Bekämpfung von Krankheiten.',
    });
    const p2 = await bilibiliCaptions.getCaptions(ref(`https://www.bilibili.com/video/${MULTI}?p=2`), {}, ctx);
    expect(p2?.segments[0]?.text).toBe('Unsere Welt fühlt sich Normal an.');
    expect(await bilibiliCaptions.listTracks?.(ref(MULTI), ctx)).toEqual([
      { language: 'de-DE', name: 'Deutsch(DE)', origin: 'creator-captions' },
    ]);
  });

  it('marks AI subtitles as auto-captions and honours allowAuto and language', async () => {
    const ctx = testContext({ fetch: biliReplay() });
    const t = await bilibiliCaptions.getCaptions(ref(AI), { language: 'zh' }, ctx);
    expect(t).toMatchObject({ language: 'zh', origin: 'auto-captions' });
    expect(t?.segments[0]).toEqual({ startSec: 0.14, endSec: 2.56, text: '岩浆碰到水会发生什么' });
    expect(await bilibiliCaptions.getCaptions(ref(AI), { allowAuto: false }, ctx)).toBeNull();
    expect(await bilibiliCaptions.getCaptions(ref(MULTI), { language: 'en' }, ctx)).toBeNull();
    expect(await bilibiliCaptions.getCaptions(ref(PLAIN), {}, ctx)).toBeNull();
  });

  it('sends BILIBILI_SESSDATA as a cookie to the API (never to the subtitle CDN) and merges the player list', async () => {
    const fetch = biliReplay();
    const ctx = testContext({ fetch, env: { BILIBILI_SESSDATA: 'sessdata-test-value' } });
    await bilibiliCaptions.getCaptions(ref(MULTI), {}, ctx);
    const api = fetch.calls.filter((c) => c.url.startsWith(API));
    expect(api.length).toBeGreaterThan(0);
    expect(api.every((c) => c.headers.cookie === 'SESSDATA=sessdata-test-value')).toBe(true);
    expect(fetch.calls.some((c) => c.url.includes('/x/player/wbi/v2?'))).toBe(true);
    expect(fetch.calls.filter((c) => c.url.includes('hdslb.com')).every((c) => c.headers.cookie === undefined)).toBe(true);
  });
});

describe('audio', () => {
  const head = JSON.parse(text('audio-30232-head.json')) as {
    request: { url: string };
    status: number;
    headers: Record<string, string>;
  };

  it('downloads the smallest DASH audio stream itself, with the Referer, and returns bytes', async () => {
    const fetch = biliReplay([
      { url: head.request.url, response: { status: head.status, headers: head.headers, body: bytes('audio-30232-head.m4s') } },
    ]);
    const ctx = testContext({ fetch });
    const audio = await bilibiliSource.getAudio?.(ref(PLAIN), ctx);
    expect(audio).toMatchObject({ kind: 'bytes', mimeType: 'audio/mp4', filename: `${PLAIN}.m4a`, durationSec: 220 });
    expect(audio?.kind === 'bytes' ? audio.data.byteLength : 0).toBe(4096);
    const download = fetch.calls.find((c) => c.url === head.request.url);
    expect(download?.headers.referer).toBe('https://www.bilibili.com/');
    expect(fetch.calls.some((c) => c.url.includes('/x/player/wbi/playurl?') && c.url.includes('fnval=16'))).toBe(true);
  });

  it('refuses audio above BILIBILI_MAX_AUDIO_MB before downloading it', async () => {
    const fetch = biliReplay();
    const ctx = testContext({ fetch, env: { BILIBILI_MAX_AUDIO_MB: '1' } });
    const err = await rejection(bilibiliSource.getAudio?.(ref(PLAIN), ctx));
    expect(err.code).toBe('too-large');
    expect(err.hint).toContain('BILIBILI_MAX_AUDIO_MB');
    expect(fetch.calls.some((c) => c.url.includes('.m4s'))).toBe(false);
  });
});

describe.skipIf(!process.env.LIVE)('bilibili (live)', () => {
  const live = () => createContext({ runtime: 'node', env: process.env });

  it('returns creator subtitles for a public video through the pipeline', async () => {
    const registry = new Registry([bilibiliSource, bilibiliCaptions], 'node');
    const context = await getVideoContext(registry, `https://www.bilibili.com/video/${MULTI}`, { mode: 'captions' }, live());
    expect(context.transcript).toMatchObject({ origin: 'creator-captions', language: 'de-DE', producer: 'bilibili-captions' });
    expect(context.metadata.extra?.parts).toBe(38);
    console.error(
      '[live] bilibili first lines:',
      context.transcript.segments.slice(0, 4).map((s) => `[${s.startSec}] ${s.text}`),
    );
  });

  it('signs player and playurl requests with a live WBI key and downloads audio with the Referer', async () => {
    const ctx = live();
    const meta = await bilibiliSource.getMetadata(ref(PLAIN), ctx);
    expect(meta.durationSec).toBe(219);
    const audio = await bilibiliSource.getAudio?.(ref(PLAIN), ctx);
    expect(audio?.kind === 'bytes' ? audio.data.byteLength : 0).toBeGreaterThan(1_000_000);
    const ai = await bilibiliCaptions.getCaptions(ref(AI), {}, ctx);
    expect(ai?.origin).toBe('auto-captions');
  });
});

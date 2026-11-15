import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createContext, Vid2ContextError, type VideoRef } from '@vid2context/core';
import { replayFetch, testContext } from '@vid2context/core/testing';
import { createRegistry } from '@vid2context/registry/node';
import { describe, expect, it } from 'vitest';
import {
  audioRenditions,
  downloadAudio,
  FXTWITTER,
  fetchFxTwitter,
  fromSyndication,
  matchX,
  mediaSegments,
  parseRef,
  syndicationUrl,
  titleOf,
  type XMedia,
  xSource,
} from '../src/index.ts';

// Fixtures are real recordings (see test/fixtures/README.md).
const fixture = (name: string) => readFileSync(join(import.meta.dirname, 'fixtures', name));
const text = (name: string) => fixture(name).toString('utf8');
const json = { 'content-type': 'application/json; charset=utf-8' };

const ROMAN = '2094024294988701975'; // NASA, "Liftoff! @NASARoman ...", 33 s video, six MP4 renditions, a reply to NASA
const GIF = '1882872996031066248'; // NASA, Blue Ghost lander, one animated GIF
const TEXT = '20'; // "just setting up my twttr", no media
const MISSING = '1263569466313105408'; // 404 on both services
const SMALLEST = 'https://video.twimg.com/amplify_video/2094024240437547008/vid/avc1/480x270/UazEpdmCJehe4HMQ.mp4';

const syn = (id: string) => ({ url: syndicationUrl(id), response: { body: text(`syndication-${id}.json`), headers: json } });
const fx = (id: string) => ({
  url: `${FXTWITTER}/i/status/${id}`,
  response: { body: text(`fxtwitter-${id}.json`), headers: json },
});
const synMissing = (id: string) => ({
  url: syndicationUrl(id),
  response: { status: 404, body: text('syndication-404.html'), headers: { 'content-type': 'text/html;charset=utf-8' } },
});
const fxMissing = (id: string) => ({
  url: `${FXTWITTER}/i/status/${id}`,
  response: { status: 404, body: text('fxtwitter-404.json'), headers: json },
});
const mp4Head = {
  url: SMALLEST,
  response: {
    status: 206,
    body: new Uint8Array(fixture('mp4-480x270-head.mp4')),
    headers: { 'content-type': 'video/mp4', 'content-length': '4096', 'content-range': 'bytes 0-4095/558676' },
  },
};

const MASTER = 'https://video.twimg.com/amplify_video/2094024240437547008/pl/MeWHHniTISojYyQH.m3u8?v=d8b';
const AUDIO_32K = 'https://video.twimg.com/amplify_video/2094024240437547008/pl/mp4a/32000/CX9pVDZQCvbAiUsB.m3u8';
const SEGMENTS = [
  '5upmBTnQXx3UBWed.mp4',
  ...text('hls/mp4a-32000.m3u8')
    .split('\n')
    .filter((l) => l.startsWith('/amplify_video/'))
    .map((l) => l.split('/').at(-1) as string),
];
const m3u8 = { 'content-type': 'application/vnd.apple.mpegurl' };
const hls = [
  { url: MASTER, response: { body: text('hls/master.m3u8'), headers: m3u8 } },
  { url: AUDIO_32K, response: { body: text('hls/mp4a-32000.m3u8'), headers: m3u8 } },
  {
    url: /^https:\/\/video\.twimg\.com\/amplify_video\/2094024240437547008\/aud\/mp4a\//,
    response: (call: { url: string }) => ({
      body: new Uint8Array(fixture(`hls/${call.url.split('/').at(-1)}`)),
      headers: { 'content-type': call.url.endsWith('.mp4') ? 'video/mp4' : 'video/iso.segment' },
    }),
  },
];

function ref(input: string): VideoRef {
  const r = matchX(input);
  if (!r) throw new Error(`no match: ${input}`);
  return r;
}

async function rejection(p: Promise<unknown>): Promise<Vid2ContextError> {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(Vid2ContextError);
  return err as Vid2ContextError;
}

describe('matchX', () => {
  it('matches post URLs on every X host', () => {
    for (const input of [
      `https://x.com/NASA/status/${ROMAN}`,
      `https://twitter.com/NASA/status/${ROMAN}?s=20&t=abc`,
      `https://mobile.twitter.com/NASA/status/${ROMAN}`,
      `https://www.x.com/NASA/status/${ROMAN}/`,
      `x.com/NASA/status/${ROMAN}`,
      `https://x.com/i/status/${ROMAN}`,
      `https://x.com/i/web/status/${ROMAN}`,
      `https://twitter.com/NASA/statuses/${ROMAN}`,
      `https://fxtwitter.com/NASA/status/${ROMAN}`,
      `https://vxtwitter.com/NASA/status/${ROMAN}`,
      `https://fixupx.com/NASA/status/${ROMAN}`,
      `https://x.com/NASA/status/${ROMAN}/video/1`,
    ]) {
      expect(matchX(input), input).toMatchObject({
        platform: 'x',
        kind: 'video',
        id: `x:${ROMAN}`,
        nativeId: ROMAN,
        url: `https://x.com/i/status/${ROMAN}`,
      });
    }
  });

  it('keeps a media position after the first', () => {
    expect(matchX(`https://x.com/NASA/status/${ROMAN}/video/2`)).toMatchObject({
      id: `x:${ROMAN}_v2`,
      url: `https://x.com/i/status/${ROMAN}/video/2`,
    });
    expect(parseRef(ref(`https://x.com/NASA/status/${ROMAN}/photo/3`))).toEqual({ postId: ROMAN, media: 3 });
    expect(parseRef(ref(`https://x.com/NASA/status/${ROMAN}`))).toEqual({ postId: ROMAN });
  });

  it('leaves everything else alone', () => {
    for (const input of [
      'https://x.com/NASA',
      'https://x.com/i/broadcasts/1NxarovqbzDKj',
      'https://x.com/NASA/status/abc',
      'https://x.com/a/b/status/123',
      `https://example.com/NASA/status/${ROMAN}`,
      `https://notx.com/NASA/status/${ROMAN}`,
      'https://www.youtube.com/watch?v=jNQXAC9IVRw',
      ROMAN,
      `ftp://x.com/NASA/status/${ROMAN}`,
    ]) {
      expect(matchX(input), input).toBeNull();
    }
  });

  it('wins over the yt-dlp catch-all in the node registry', () => {
    const { source, ref: r } = createRegistry().resolve(`https://x.com/NASA/status/${ROMAN}`);
    expect(source.id).toBe('x');
    expect(r.id).toBe(`x:${ROMAN}`);
  });
});

describe('xSource metadata', () => {
  it('reads a video post from X syndication', async () => {
    const fetch = replayFetch([syn(ROMAN)]);
    const meta = await xSource.getMetadata(ref(`https://x.com/NASA/status/${ROMAN}`), testContext({ fetch }));

    expect(meta.ref).toMatchObject({ id: `x:${ROMAN}`, url: `https://x.com/NASA/status/${ROMAN}` });
    expect(meta.title).toBe('Liftoff! @NASARoman begins its flight to space. The Roman telescope’s wide field of view will...');
    expect(meta.description).toBe(
      'Liftoff! @NASARoman begins its flight to space. The Roman telescope’s wide field of view will generate never-before-seen images, revolutionizing our understanding of the universe.',
    );
    expect(meta.channel).toEqual({ name: 'NASA', id: '11348282', url: 'https://x.com/NASA' });
    expect(meta.durationSec).toBe(32.896);
    expect(meta.publishedAt).toBe('2026-08-30T11:27:51.000Z');
    expect(meta.thumbnailUrl).toBe('https://pbs.twimg.com/amplify_video_thumb/2094024240437547008/img/UIH-oa1BFucPXCpa.jpg');
    expect(meta.chapters).toEqual([]);

    const extra = meta.extra as Record<string, unknown>;
    expect(extra).toMatchObject({
      postId: ROMAN,
      handle: 'NASA',
      mediaType: 'video',
      mediaPosition: 1,
      mediaCount: 1,
      width: 3840,
      height: 2160,
      textLanguage: 'en',
      likes: 2454,
      replies: 52,
      replyTo: 'NASA',
      via: 'syndication',
      hls: 'https://video.twimg.com/amplify_video/2094024240437547008/pl/MeWHHniTISojYyQH.m3u8?v=d8b',
    });
    const variants = extra.variants as { quality: string; bitrate: number; url: string }[];
    expect(variants.map((v) => v.quality)).toEqual(['2160p', '1080p', '720p', '360p', '270p']);
    expect(variants[0]).toEqual({
      url: 'https://video.twimg.com/amplify_video/2094024240437547008/vid/avc1/3840x2160/qE7lB6dsLKuphA95.mp4',
      bitrate: 25128000,
      width: 3840,
      height: 2160,
      quality: '2160p',
    });
    expect(variants.at(-1)?.url).toBe(SMALLEST);
    // The post replies to an earlier NASA post that has its own video; only this post's media counts.
    expect(variants.every((v) => v.url.includes('/2094024240437547008/'))).toBe(true);
    expect(fetch.calls).toHaveLength(1);
  });

  it('sends the embed token X expects', () => {
    expect(syndicationUrl(ROMAN)).toMatch(
      new RegExp(`^https://cdn\\.syndication\\.twimg\\.com/tweet-result\\?id=${ROMAN}&lang=en&token=[0-9a-z]+$`),
    );
  });

  it('falls back to FxTwitter when syndication refuses the post', async () => {
    const fetch = replayFetch([synMissing(ROMAN), fx(ROMAN)]);
    const meta = await xSource.getMetadata(ref(`https://x.com/i/status/${ROMAN}`), testContext({ fetch }));
    expect(meta.title.startsWith('Liftoff! @NASARoman')).toBe(true);
    expect(meta.durationSec).toBe(32.896);
    expect(meta.channel).toEqual({ name: 'NASA', id: '11348282', url: 'https://x.com/NASA' });
    expect(meta.extra).toMatchObject({ via: 'fxtwitter', reposts: 688, views: 450541, replyTo: 'NASA', mediaType: 'video' });
    const variants = (meta.extra as { variants: { quality: string; url: string }[] }).variants;
    expect(variants.map((v) => v.quality)).toEqual(['2160p', '1080p', '720p', '360p', '270p']);
    expect(variants.at(-1)?.url).toBe(`${SMALLEST}?tag=29`);
    expect(fetch.calls.map((c) => new URL(c.url).host)).toEqual(['cdn.syndication.twimg.com', 'api.fxtwitter.com']);
  });

  it('says not-found when neither service has the post', async () => {
    const fetch = replayFetch([synMissing(MISSING), fxMissing(MISSING)]);
    const err = await rejection(xSource.getMetadata(ref(`https://x.com/a/status/${MISSING}`), testContext({ fetch })));
    expect(err.code).toBe('not-found');
    expect(err.hint).toMatch(/public posts/);
  });

  it('skips FxTwitter when X_FXTWITTER=0', async () => {
    const fetch = replayFetch([synMissing(MISSING)]);
    const ctx = testContext({ fetch, env: { X_FXTWITTER: '0' } });
    const err = await rejection(xSource.getMetadata(ref(`https://x.com/a/status/${MISSING}`), ctx));
    expect(err.code).toBe('not-found');
    expect(fetch.calls).toHaveLength(1);
  });

  it('sends the fallback to X_FXTWITTER_BASE_URL', async () => {
    const fetch = replayFetch([
      synMissing(ROMAN),
      { url: `https://fx.example.org/i/status/${ROMAN}`, response: { body: text(`fxtwitter-${ROMAN}.json`), headers: json } },
    ]);
    const ctx = testContext({ fetch, env: { X_FXTWITTER_BASE_URL: 'https://fx.example.org/' } });
    const meta = await xSource.getMetadata(ref(`https://x.com/i/status/${ROMAN}`), ctx);
    expect(meta.extra).toMatchObject({ via: 'fxtwitter' });
  });

  it('refuses a text-only post with a hint', async () => {
    const fetch = replayFetch([syn(TEXT)]);
    const err = await rejection(xSource.getMetadata(ref(`https://twitter.com/jack/status/${TEXT}`), testContext({ fetch })));
    expect(err.code).toBe('unavailable');
    expect(err.message).toBe('X post 20 has no video.');
    expect(err.hint).toMatch(/text only/);
  });

  it('refuses a media position the post does not have', async () => {
    const fetch = replayFetch([syn(ROMAN)]);
    const err = await rejection(xSource.getMetadata(ref(`https://x.com/NASA/status/${ROMAN}/video/2`), testContext({ fetch })));
    expect(err.code).toBe('not-found');
    expect(err.hint).toBe(`It has 1 media item. Try https://x.com/i/status/${ROMAN}.`);
  });

  it('describes a GIF from either service', async () => {
    for (const routes of [[syn(GIF)], [synMissing(GIF), fx(GIF)]]) {
      const fetch = replayFetch(routes);
      const meta = await xSource.getMetadata(ref(`https://x.com/NASA/status/${GIF}`), testContext({ fetch }));
      expect(meta.title).toBe('Everybody, wave!');
      expect(meta.durationSec).toBeUndefined();
      expect(meta.extra).toMatchObject({
        mediaType: 'gif',
        variants: [{ url: 'https://video.twimg.com/tweet_video/GiFPAi8WYAEgiBu.mp4' }],
      });
    }
  });
});

describe('xSource audio', () => {
  it('joins the lowest-bitrate HLS audio rendition into one m4a, reusing the metadata lookup', async () => {
    const fetch = replayFetch([syn(ROMAN), ...hls]);
    const ctx = testContext({ fetch });
    const r = ref(`https://x.com/NASA/status/${ROMAN}`);
    expect(xSource.canProvideAudio?.(r, ctx)).toBe(true);
    await xSource.getMetadata(r, ctx);
    const audio = await xSource.getAudio?.(r, ctx);
    expect(audio).toMatchObject({ kind: 'bytes', mimeType: 'audio/mp4', filename: `${ROMAN}.m4a`, durationSec: 32.896 });
    // Init segment then the eleven fragments, in playlist order: 140,530 bytes against 558,676 for the smallest MP4.
    const expected = Buffer.concat(SEGMENTS.map((s) => fixture(`hls/${s}`)));
    expect(expected.byteLength).toBe(140530);
    expect(audio?.kind === 'bytes' && Buffer.from(audio.data).equals(expected)).toBe(true);
    const urls = fetch.calls.map((c) => c.url);
    expect(urls.slice(0, 3)).toEqual([syndicationUrl(ROMAN), MASTER, AUDIO_32K]);
    expect(urls).toHaveLength(3 + SEGMENTS.length);
    expect(urls.some((u) => u.endsWith('.mp4') && u.includes('/vid/'))).toBe(false);
  });

  it('picks the 32 kbps rendition from the master playlist', () => {
    expect(audioRenditions(text('hls/master.m3u8'), MASTER).map((a) => a.bitrate)).toEqual([32000, 64000, 128000]);
    const seg = mediaSegments(text('hls/mp4a-32000.m3u8'), AUDIO_32K);
    expect(seg?.urls[0]).toBe(
      'https://video.twimg.com/amplify_video/2094024240437547008/aud/mp4a/0/0/32000/5upmBTnQXx3UBWed.mp4',
    );
    expect(seg?.urls).toHaveLength(12);
    expect(seg?.durationSec).toBeCloseTo(32.944, 3);
  });

  it('downloads the smallest MP4 when there is no HLS playlist', async () => {
    const post = fromSyndication(JSON.parse(text(`syndication-${ROMAN}.json`)));
    const { hls: _, ...media } = post.media[0] as XMedia;
    const fetch = replayFetch([mp4Head]);
    const audio = await downloadAudio(media, testContext({ fetch }), ROMAN, 'the test video');
    expect(audio).toMatchObject({ kind: 'bytes', mimeType: 'video/mp4', filename: `${ROMAN}.mp4`, durationSec: 32.896 });
    expect(audio.kind === 'bytes' && audio.data.byteLength).toBe(4096);
    expect(fetch.calls.map((c) => c.url)).toEqual([SMALLEST]);
  });

  it('refuses before downloading segments when the audio is over the cap', async () => {
    const fetch = replayFetch([syn(ROMAN), ...hls]);
    const ctx = testContext({ fetch, env: { VID2CONTEXT_MAX_MEDIA_MB: '0.1' } });
    const err = await rejection(xSource.getAudio?.(ref(`https://x.com/NASA/status/${ROMAN}`), ctx) as Promise<unknown>);
    expect(err.code).toBe('too-large');
    expect(err.hint).toMatch(/VID2CONTEXT_MAX_MEDIA_MB/);
    expect(fetch.calls.map((c) => c.url)).toEqual([syndicationUrl(ROMAN), MASTER, AUDIO_32K]);
  });

  it('refuses a GIF, which has no sound', async () => {
    const fetch = replayFetch([syn(GIF)]);
    const err = await rejection(
      xSource.getAudio?.(ref(`https://x.com/NASA/status/${GIF}`), testContext({ fetch })) as Promise<unknown>,
    );
    expect(err.code).toBe('unavailable');
    expect(err.message).toMatch(/GIF/);
  });

  it('only claims X refs', () => {
    const ctx = testContext({ fetch: replayFetch([]) });
    const yt: VideoRef = { input: 'x', platform: 'youtube', kind: 'video', id: 'youtube:jNQXAC9IVRw', nativeId: 'jNQXAC9IVRw' };
    expect(xSource.canProvideAudio?.(yt, ctx)).toBe(false);
  });
});

describe('titleOf', () => {
  it('falls back to the author when the text is only a link', () => {
    const post = {
      id: '1',
      text: 'https://t.co/abc',
      author: { name: 'NASA', handle: 'NASA' },
      hashtags: [],
      media: [],
      via: 'syndication' as const,
    };
    expect(titleOf(post)).toBe('Video by @NASA');
  });
});

describe.skipIf(!process.env.LIVE)('xSource live', () => {
  const ctx = () => createContext({ runtime: 'node', env: process.env as Record<string, string> });

  it('reads the NASA Roman launch post from syndication', async () => {
    const meta = await xSource.getMetadata(ref(`https://x.com/NASA/status/${ROMAN}`), ctx());
    expect(meta.channel?.url).toBe('https://x.com/NASA');
    expect(meta.extra).toMatchObject({ via: 'syndication', mediaType: 'video' });
    expect((meta.extra as { variants: unknown[] }).variants.length).toBeGreaterThan(1);
  });

  it('reads the same post from FxTwitter', async () => {
    const post = await fetchFxTwitter(ROMAN, ctx());
    expect(post.via).toBe('fxtwitter');
    expect(post.media[0]?.variants.length).toBeGreaterThan(1);
  });

  it('downloads the audio of a short video', async () => {
    const audio = await xSource.getAudio?.(ref(`https://x.com/NASA/status/${ROMAN}`), ctx());
    expect(audio).toMatchObject({ mimeType: 'audio/mp4' });
    expect(audio?.kind === 'bytes' && audio.data.byteLength).toBeGreaterThan(100_000);
  });
});

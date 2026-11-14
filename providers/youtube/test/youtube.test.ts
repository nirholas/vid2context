import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createContext, type VideoRef } from '@vid2context/core';
import { type RecordedCall, replayFetch, testContext } from '@vid2context/core/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import { parseSrv1, parseSrv3 } from '../src/captions/formats.ts';
import { chooseTrack } from '../src/captions/tracks.ts';
import { youtubeCaptions, youtubeSource } from '../src/index.ts';
import { parseDescriptionChapters } from '../src/metadata.ts';
import { resetBreaker } from '../src/resilience/breaker.ts';
import type { PlayerResponse } from '../src/resilience/player.ts';
import { matchYouTube } from '../src/url.ts';

// Fixtures are real recordings (see test/fixtures/README.md).
const fixture = (name: string) => readFileSync(join(import.meta.dirname, 'fixtures', name), 'utf8');
const player = (id: string) => JSON.parse(fixture(`player-${id}.json`)) as PlayerResponse;
const PLAYER_URL = 'https://www.youtube.com/youtubei/v1/player?prettyPrint=false';

// The 429 block page test opens the per-process circuit breaker; close it between tests.
beforeEach(() => resetBreaker());

function youtubeReplay() {
  return replayFetch([
    {
      method: 'POST',
      url: PLAYER_URL,
      response: (call: RecordedCall) => {
        const { videoId } = JSON.parse(String(call.body)) as { videoId: string };
        const name = ['jNQXAC9IVRw', 'cCPsdFdlshc'].includes(videoId) ? videoId : 'unavailable';
        return { body: fixture(`player-${name}.json`), headers: { 'content-type': 'application/json' } };
      },
    },
    { url: /timedtext\?v=jNQXAC9IVRw.*lang=en.*fmt=srv3/, response: { body: fixture('timedtext-jNQXAC9IVRw-en.srv3.xml') } },
    { url: /timedtext\?v=jNQXAC9IVRw.*lang=de.*fmt=srv3/, response: { body: fixture('timedtext-jNQXAC9IVRw-de.srv3.xml') } },
    { url: /timedtext\?v=cCPsdFdlshc.*tlang=de/, response: { status: 429, body: fixture('timedtext-429-blocked.html') } },
    { url: /timedtext\?v=cCPsdFdlshc.*lang=en.*fmt=srv3/, response: { body: fixture('timedtext-cCPsdFdlshc-en-asr.srv3.xml') } },
  ]);
}

const ref = (input: string): VideoRef => {
  const r = matchYouTube(input);
  if (!r) throw new Error(`no match for ${input}`);
  return r;
};

describe('matchYouTube', () => {
  it.each([
    ['https://www.youtube.com/watch?v=jNQXAC9IVRw', 'youtube:jNQXAC9IVRw'],
    ['https://youtu.be/jNQXAC9IVRw?si=abc', 'youtube:jNQXAC9IVRw'],
    ['youtube.com/watch?v=jNQXAC9IVRw&t=5s', 'youtube:jNQXAC9IVRw'],
    ['https://m.youtube.com/watch?v=jNQXAC9IVRw', 'youtube:jNQXAC9IVRw'],
    ['https://music.youtube.com/watch?v=jNQXAC9IVRw&feature=share', 'youtube:jNQXAC9IVRw'],
    ['https://www.youtube.com/shorts/jNQXAC9IVRw', 'youtube:jNQXAC9IVRw'],
    ['https://www.youtube.com/live/jNQXAC9IVRw?feature=share', 'youtube:jNQXAC9IVRw'],
    ['https://www.youtube-nocookie.com/embed/jNQXAC9IVRw', 'youtube:jNQXAC9IVRw'],
    ['jNQXAC9IVRw', 'youtube:jNQXAC9IVRw'],
    ['https://www.youtube.com/watch?v=cCPsdFdlshc&list=PLHeawKfarQSPKIjpe86at3Ttc2sz7uD_b', 'youtube:cCPsdFdlshc'],
    [
      'https://www.youtube.com/playlist?list=PLHeawKfarQSPKIjpe86at3Ttc2sz7uD_b',
      'youtube:playlist:PLHeawKfarQSPKIjpe86at3Ttc2sz7uD_b',
    ],
    ['https://www.youtube.com/@jawed', 'youtube:channel:@jawed'],
    ['https://www.youtube.com/channel/UC4QobU6STFB0P71PMvOGN5A', 'youtube:channel:UC4QobU6STFB0P71PMvOGN5A'],
  ])('%s -> %s', (input, id) => {
    expect(matchYouTube(input)?.id).toBe(id);
  });

  it('builds canonical refs and rejects other inputs', () => {
    expect(ref('https://youtu.be/jNQXAC9IVRw')).toEqual({
      input: 'https://youtu.be/jNQXAC9IVRw',
      platform: 'youtube',
      kind: 'video',
      id: 'youtube:jNQXAC9IVRw',
      nativeId: 'jNQXAC9IVRw',
      url: 'https://www.youtube.com/watch?v=jNQXAC9IVRw',
    });
    expect(ref('https://www.youtube.com/playlist?list=PLHeawKfarQSPKIjpe86at3Ttc2sz7uD_b').kind).toBe('playlist');
    expect(matchYouTube('https://vimeo.com/76979871')).toBeNull();
    expect(matchYouTube('https://www.youtube.com/feed/subscriptions')).toBeNull();
    expect(matchYouTube('/home/user/talk.mp3')).toBeNull();
  });
});

describe('timedtext parsers', () => {
  it('parses creator srv3 and decodes entities', () => {
    const segs = parseSrv3(fixture('timedtext-jNQXAC9IVRw-en.srv3.xml'));
    expect(segs).toHaveLength(6);
    expect(segs[0]).toEqual({ startSec: 1.2, endSec: 3.36, text: 'All right, so here we are, in front of the elephants' });
    expect(segs[3]?.text).toBe("and that's cool");
  });

  it('parses srv1 with its double-encoded entities to the same text', () => {
    const srv1 = parseSrv1(fixture('timedtext-jNQXAC9IVRw-en.srv1.xml'));
    expect(srv1.map((s) => s.text)).toEqual(parseSrv3(fixture('timedtext-jNQXAC9IVRw-en.srv3.xml')).map((s) => s.text));
  });

  it('joins auto-caption words, drops append paragraphs and removes overlaps', () => {
    const segs = parseSrv3(fixture('timedtext-cCPsdFdlshc-en-asr.srv3.xml'));
    expect(segs[0]).toEqual({ startSec: 0.64, endSec: 2.08, text: "so you're going to buy G wagon which" });
    expect(segs[1]?.text).toBe('year is best for you well in this video');
    expect(segs.every((s) => s.text.length > 0)).toBe(true);
    for (let i = 1; i < segs.length; i++) expect(segs[i]?.startSec).toBeGreaterThanOrEqual(segs[i - 1]?.endSec ?? 0);
    expect(segs.at(-1)?.startSec).toBeLessThan(1084);
  });
});

describe('chooseTrack', () => {
  const zoo = player('jNQXAC9IVRw').captions?.playerCaptionsTracklistRenderer?.captionTracks ?? [];
  const gw = player('cCPsdFdlshc').captions?.playerCaptionsTracklistRenderer?.captionTracks ?? [];

  it('prefers the default creator track and honours a requested language', () => {
    expect(chooseTrack(zoo, {}, 0)).toMatchObject({ origin: 'creator-captions', track: { languageCode: 'en' } });
    expect(chooseTrack(zoo, { language: 'de' }, 0)?.track.languageCode).toBe('de');
    expect(chooseTrack(zoo, { language: 'de-AT' }, 0)?.track.languageCode).toBe('de');
  });

  it('falls back to auto-captions, then translation, and respects allowAuto and allowTranslated', () => {
    expect(chooseTrack(gw, {})).toMatchObject({ origin: 'auto-captions', track: { languageCode: 'en' } });
    expect(chooseTrack(gw, { allowAuto: false })).toBeNull();
    expect(chooseTrack(gw, { language: 'de' })).toMatchObject({ origin: 'auto-captions', translateTo: 'de' });
    expect(chooseTrack(zoo, { language: 'fr', allowTranslated: false }, 0)).toBeNull();
  });
});

describe('description chapters', () => {
  it('reads the chapters in the real zoo description', () => {
    expect(parseDescriptionChapters(player('jNQXAC9IVRw').videoDetails?.shortDescription, 19)).toEqual([
      { title: 'Intro', startSec: 0, endSec: 5 },
      { title: 'The cool thing', startSec: 5, endSec: 17 },
      { title: 'End', startSec: 17, endSec: 19 },
    ]);
  });

  it('returns no chapters for descriptions without a 0:00 list', () => {
    expect(parseDescriptionChapters(player('cCPsdFdlshc').videoDetails?.shortDescription, 1084)).toEqual([]);
  });
});

describe('youtube providers (recorded responses)', () => {
  it('gets metadata and creator captions with one player request', async () => {
    const fetch = youtubeReplay();
    const ctx = testContext({ fetch });
    const r = ref('https://www.youtube.com/watch?v=jNQXAC9IVRw');
    const meta = await youtubeSource.getMetadata(r, ctx);
    expect(meta).toMatchObject({
      title: 'Me at the zoo',
      durationSec: 19,
      channel: { name: 'jawed', id: 'UC4QobU6STFB0P71PMvOGN5A' },
      tags: ['me at the zoo', 'jawed karim', 'first youtube video'],
      isLive: false,
    });
    expect(meta.chapters).toHaveLength(3);
    const t = await youtubeCaptions.getCaptions(r, {}, ctx);
    expect(t).toMatchObject({ language: 'en', origin: 'creator-captions', producer: 'youtube-captions' });
    expect(t?.segments).toHaveLength(6);
    expect(fetch.calls.filter((c) => c.url === PLAYER_URL)).toHaveLength(1);
  });

  it('lists tracks and returns auto-captions with the spoken language', async () => {
    const ctx = testContext({ fetch: youtubeReplay() });
    const r = ref('cCPsdFdlshc');
    expect(await youtubeCaptions.listTracks?.(r, ctx)).toEqual([
      { language: 'en', name: 'English (auto-generated)', origin: 'auto-captions', translatable: true },
    ]);
    expect((await youtubeSource.getMetadata(r, ctx)).language).toBe('en');
    const t = await youtubeCaptions.getCaptions(r, {}, ctx);
    expect(t?.origin).toBe('auto-captions');
    expect(t?.segments.length).toBeGreaterThan(300);
  });

  it('maps an unavailable video to not-found and the 429 block page to blocked', async () => {
    const ctx = testContext({ fetch: youtubeReplay() });
    await expect(youtubeSource.getMetadata(ref('xxxxxxxxxxx'), ctx)).rejects.toMatchObject({ code: 'not-found' });
    await expect(youtubeCaptions.getCaptions(ref('cCPsdFdlshc'), { language: 'de' }, ctx)).rejects.toMatchObject({
      code: 'blocked',
      status: 429,
    });
  });
});

describe.skipIf(!process.env.LIVE)('youtube providers (live)', () => {
  const ctx = createContext({ runtime: 'node', env: process.env });

  it('fetches real metadata and captions for jNQXAC9IVRw', async () => {
    const r = ref('https://www.youtube.com/watch?v=jNQXAC9IVRw');
    expect((await youtubeSource.getMetadata(r, ctx)).title).toBe('Me at the zoo');
    const t = await youtubeCaptions.getCaptions(r, { language: 'en' }, ctx);
    expect(t?.segments.map((s) => s.text).join(' ')).toContain('elephants');
  });
});

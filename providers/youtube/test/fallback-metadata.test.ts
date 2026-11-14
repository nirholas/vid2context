/**
 * Metadata when YouTube blocks the player from this IP: `next` and oEmbed
 * still answer (live on 2026-11-14 from a GCP VM), so a run keeps its title,
 * channel, description and chapters, and the transcript stage gets its turn.
 * Every response is a real recording (test/fixtures/README.md).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Vid2ContextError, type VideoRef } from '@vid2context/core';
import { type RecordedResponse, replayFetch, testContext } from '@vid2context/core/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import { fallbackMetadata, getYouTubeMetadata, parseOEmbed, parseWatch } from '../src/metadata/index.ts';
import { oembedUrl } from '../src/metadata/oembed.ts';
import { breakerRemainingSec, resetBreaker } from '../src/resilience/breaker.ts';
import { matchYouTube } from '../src/url.ts';

const fixture = (name: string) => readFileSync(join(import.meta.dirname, 'fixtures', name), 'utf8');
const json = (name: string): RecordedResponse => ({ body: fixture(name), headers: { 'content-type': 'application/json' } });
const ZOO = 'jNQXAC9IVRw';
const PLAYER_URL = 'https://www.youtube.com/youtubei/v1/player?prettyPrint=false';
const NEXT_URL = 'https://www.youtube.com/youtubei/v1/next?prettyPrint=false';

const ref = (id: string): VideoRef => {
  const r = matchYouTube(`https://www.youtube.com/watch?v=${id}`);
  if (!r) throw new Error('no match');
  return r;
};

/** The bot check on every player client (the recorded ANDROID_VR answer, served to ANDROID and IOS). */
const botPlayer = { method: 'POST', url: PLAYER_URL, response: json('player-android_vr-bot-jNQXAC9IVRw.json') };
const zooNext = { method: 'POST', url: NEXT_URL, response: json('metadata/next-fallback-jNQXAC9IVRw.json') };
const zooOEmbed = { url: oembedUrl(ZOO), response: json('metadata/oembed-jNQXAC9IVRw.json') };
const zooMaxres = { method: 'HEAD', url: `https://i.ytimg.com/vi/${ZOO}/maxresdefault.jpg`, response: { status: 404, body: '' } };

beforeEach(() => resetBreaker());

describe('parsing the fallback sources', () => {
  it('reads title, description and total views from next', () => {
    const w = parseWatch(JSON.parse(fixture('metadata/next-fallback-jNQXAC9IVRw.json')));
    expect(w.title).toBe('Me at the zoo');
    expect(w.description).toMatch(/^Microplastics are accumulating/);
    expect(w.description).toContain('00:00 Intro');
    expect(w.viewCount).toBeGreaterThan(400_000_000);
    expect(w.channelName).toBe('jawed');
  });

  it('reads oEmbed and rejects bodies without a title', () => {
    expect(parseOEmbed(JSON.parse(fixture('metadata/oembed-jNQXAC9IVRw.json')))).toEqual({
      title: 'Me at the zoo',
      authorName: 'jawed',
      authorUrl: 'https://www.youtube.com/@jawed',
      thumbnailUrl: 'https://i.ytimg.com/vi/jNQXAC9IVRw/hqdefault.jpg',
    });
    expect(parseOEmbed({})).toBeUndefined();
    expect(parseOEmbed('Bad Request')).toBeUndefined();
  });

  it('needs at least one source with a title', () => {
    expect(fallbackMetadata(ref(ZOO), undefined, undefined)).toBeNull();
  });
});

describe('getYouTubeMetadata with a blocked player', () => {
  it('builds metadata from next and oEmbed when every client gets the bot check', async () => {
    const fetch = replayFetch([botPlayer, zooNext, zooOEmbed, zooMaxres]);
    // The player block opens only the player breaker, so next is still sent.
    const meta = await getYouTubeMetadata(ref(ZOO), testContext({ fetch }));
    expect(breakerRemainingSec('direct', 'player')).toBe(600);
    expect(fetch.calls.some((c) => c.url === NEXT_URL)).toBe(true);
    expect(meta.title).toBe('Me at the zoo');
    expect(meta.channel).toEqual({
      name: 'jawed',
      id: 'UC4QobU6STFB0P71PMvOGN5A',
      url: 'https://www.youtube.com/channel/UC4QobU6STFB0P71PMvOGN5A',
    });
    expect(meta.publishedAt).toBe('2005-04-23');
    expect(meta.description).toContain('00:00 Intro');
    expect(meta.chapters.map((c) => [c.startSec, c.title])).toEqual([
      [0, 'Intro'],
      [5, 'The cool thing'],
      [17, 'End'],
    ]);
    expect(meta.thumbnailUrl).toBe('https://i.ytimg.com/vi/jNQXAC9IVRw/hqdefault.jpg');
    expect(meta.durationSec).toBeUndefined();
    expect(meta.extra).toMatchObject({
      metadataSource: 'next+oembed',
      playerBlocked: true,
      chapterSource: 'description',
      channelHandle: '@jawed',
    });
  });

  it('falls back to oEmbed alone when next fails too', async () => {
    // No recorded next answer: the request fails like a dropped connection.
    const fetch = replayFetch([botPlayer, zooOEmbed, zooMaxres]);
    const meta = await getYouTubeMetadata(ref(ZOO), testContext({ fetch }));
    expect(fetch.calls.some((c) => c.url === NEXT_URL)).toBe(true);
    expect(meta.title).toBe('Me at the zoo');
    expect(meta.channel).toEqual({ name: 'jawed', id: undefined, url: 'https://www.youtube.com/@jawed' });
    expect(meta.chapters).toEqual([]);
    expect(meta.extra).toMatchObject({
      metadataSource: 'oembed',
      playerBlocked: true,
      channelHandleUrl: 'https://www.youtube.com/@jawed',
    });
  });

  it('rethrows the block, with the client attempts, when neither next nor oEmbed answers', async () => {
    const id = 'xxxxxxxxxxx';
    const fetch = replayFetch([
      botPlayer,
      { url: oembedUrl(id), response: { status: 400, body: fixture('metadata/oembed-400-xxxxxxxxxxx.txt') } },
    ]);
    const err = await getYouTubeMetadata(ref(id), testContext({ fetch })).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Vid2ContextError);
    expect(err).toMatchObject({ code: 'blocked' });
    expect((err as { attempts?: { id: string }[] }).attempts?.map((a) => a.id)).toEqual(['youtube/android', 'youtube/ios']);
  });
});

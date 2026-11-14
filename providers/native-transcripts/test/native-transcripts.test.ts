import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getVideoContext, Registry, Vid2ContextError, type VideoRef } from '@vid2context/core';
import { replayFetch, testContext } from '@vid2context/core/testing';
import { describe, expect, it } from 'vitest';
import providers, {
  chooseVimeoTrack,
  loomCaptionsProvider,
  loomSource,
  matchLoom,
  matchVimeo,
  matchWistia,
  parseLoomChapters,
  parseVtt,
  trackOrigin,
  vimeoCaptionsProvider,
  vimeoSource,
  vttTime,
  wistiaCaptionsProvider,
  wistiaSource,
} from '../src/index.ts';
import type { VimeoConfig, VimeoTextTrack } from '../src/vimeo.ts';

// Every fixture is a real recorded response; see test/fixtures/README.md.
const fixture = (name: string) => readFileSync(join(import.meta.dirname, 'fixtures', name), 'utf8');
const json = { 'content-type': 'application/json' };
const html = { 'content-type': 'text/html; charset=UTF-8' };

const OEMBED = 'https://vimeo.com/api/oembed.json?url=https%3A%2F%2Fvimeo.com%2F';
const CONFIG = 'https://player.vimeo.com/video/';

function vimeoReplay() {
  const cfg76 = JSON.parse(fixture('vimeo-config-76979871.json')) as VimeoConfig;
  const cfg113 = JSON.parse(fixture('vimeo-config-1133654544.json')) as VimeoConfig;
  const trackUrl = (cfg: VimeoConfig, lang: string) => cfg.request?.text_tracks?.find((t) => t.lang === lang)?.url ?? '';
  return replayFetch([
    { url: `${OEMBED}76979871`, response: { body: fixture('vimeo-oembed-76979871.json'), headers: json } },
    { url: `${CONFIG}76979871/config`, response: { body: fixture('vimeo-config-76979871.json'), headers: json } },
    { url: trackUrl(cfg76, 'en'), response: { body: fixture('vimeo-76979871-en.vtt'), headers: { 'content-type': 'text/vtt' } } },
    { url: `${OEMBED}1133654544`, response: { body: fixture('vimeo-oembed-1133654544.json'), headers: json } },
    { url: `${CONFIG}1133654544/config`, response: { body: fixture('vimeo-config-1133654544.json'), headers: json } },
    { url: trackUrl(cfg113, 'en-x-autogen'), response: { body: fixture('vimeo-1133654544-en-x-autogen.vtt') } },
    { url: trackUrl(cfg113, 'de'), response: { body: fixture('vimeo-1133654544-de.vtt') } },
    { url: `${OEMBED}336812660`, response: { status: 404, body: fixture('vimeo-oembed-336812660-404.txt') } },
    { url: `${CONFIG}336812660/config`, response: { body: fixture('vimeo-config-336812660.json'), headers: json } },
    { url: `${OEMBED}1084537`, response: { body: fixture('vimeo-oembed-1084537.json'), headers: json } },
    { url: `${CONFIG}1084537/config`, response: { status: 403, body: fixture('vimeo-config-1084537-403.html'), headers: html } },
    { url: `${OEMBED}1000`, response: { status: 404, body: fixture('vimeo-oembed-1000-404.txt') } },
    { url: `${CONFIG}1000/config`, response: { status: 404, body: fixture('vimeo-config-1000-404.html'), headers: html } },
  ]);
}

const LOOM_ID = '09b1aa507cb846138847bf8e98b56a71';
const LOOM_MISSING = '0123456789abcdef0123456789abcdef';
function loomReplay() {
  return replayFetch([
    { url: `https://www.loom.com/share/${LOOM_ID}`, response: { body: fixture(`loom-share-${LOOM_ID}.html`), headers: html } },
    { url: /^https:\/\/cdn\.loom\.com\/mediametadata\/captions\/09b1aa507cb846138847bf8e98b56a71-1\.vtt\?/, response: { body: fixture(`loom-${LOOM_ID}.vtt`) } },
    { url: `https://www.loom.com/share/${LOOM_MISSING}`, response: { status: 404, body: fixture(`loom-share-${LOOM_MISSING}-404.html`), headers: html } },
  ]);
}

function wistiaReplay() {
  const routes = ['i5voqxuarc', '26sk4lmiix'].flatMap((id) => [
    { url: `https://fast.wistia.com/embed/medias/${id}.json`, response: { body: fixture(`wistia-media-${id}.json`), headers: json } },
    { url: `https://fast.wistia.com/embed/captions/${id}.json`, response: { body: fixture(`wistia-captions-${id}.json`), headers: json } },
  ]);
  routes.push({ url: 'https://fast.wistia.com/embed/medias/zzzzzzzzzz.json', response: { body: fixture('wistia-media-zzzzzzzzzz.json'), headers: json } });
  return replayFetch(routes);
}

function refOf(match: (s: string) => VideoRef | null, input: string): VideoRef {
  const r = match(input);
  if (!r) throw new Error(`no match for ${input}`);
  return r;
}

async function codeOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (err) {
    if (err instanceof Vid2ContextError) return err.code;
    throw err;
  }
  return 'resolved';
}

describe('matchVimeo', () => {
  it.each([
    ['https://vimeo.com/76979871', 'vimeo:76979871', 'https://vimeo.com/76979871'],
    ['vimeo.com/76979871?share=copy', 'vimeo:76979871', 'https://vimeo.com/76979871'],
    ['https://vimeo.com/336812660/abc123def4', 'vimeo:336812660', 'https://vimeo.com/336812660/abc123def4'],
    ['https://player.vimeo.com/video/7602340?title=0&byline=0', 'vimeo:7602340', 'https://vimeo.com/7602340'],
    ['https://player.vimeo.com/video/336812660?h=abc123def4', 'vimeo:336812660', 'https://vimeo.com/336812660/abc123def4'],
    ['https://vimeo.com/channels/staffpicks/1129015154', 'vimeo:1129015154', 'https://vimeo.com/1129015154'],
    ['https://vimeo.com/groups/motion/videos/76979871', 'vimeo:76979871', 'https://vimeo.com/76979871'],
    ['https://vimeo.com/showcase/11173434/video/1133654544', 'vimeo:1133654544', 'https://vimeo.com/1133654544'],
    ['https://vimeo.com/album/2222/video/76979871', 'vimeo:76979871', 'https://vimeo.com/76979871'],
  ])('%s -> %s', (input, id, url) => {
    const ref = refOf(matchVimeo, input);
    expect(ref).toMatchObject({ platform: 'vimeo', kind: 'video', id, url, input });
  });

  it.each([
    'https://vimeo.com/staff',
    'https://vimeo.com/showcase/11173434',
    'https://vimeo.com/channels/staffpicks',
    'https://vimeo.com/76979871/not-a-hash',
    'https://www.youtube.com/watch?v=jNQXAC9IVRw',
    'https://notvimeo.com/76979871',
    'ftp://vimeo.com/76979871',
  ])('ignores %s', (input) => {
    expect(matchVimeo(input)).toBeNull();
  });
});

describe('matchLoom and matchWistia', () => {
  it.each([
    `https://www.loom.com/share/${LOOM_ID}`,
    `https://www.loom.com/share/${LOOM_ID}?sid=1234`,
    `https://loom.com/embed/${LOOM_ID}`,
    `https://www.loom.com/share/Unstuck-your-team-with-Loom-${LOOM_ID}`,
  ])('loom %s', (input) => {
    expect(refOf(matchLoom, input)).toMatchObject({ platform: 'loom', id: `loom:${LOOM_ID}`, url: `https://www.loom.com/share/${LOOM_ID}` });
  });

  it.each([
    'https://www.loom.com/share/',
    'https://www.loom.com/share/notanid',
    `https://www.loom.com/share/x${LOOM_ID}`,
    `https://www.loom.com/looms/videos/${LOOM_ID}`,
  ])('loom ignores %s', (input) => {
    expect(matchLoom(input)).toBeNull();
  });

  it.each([
    'https://fast.wistia.net/embed/iframe/26sk4lmiix',
    'https://fast.wistia.com/embed/iframe/26sk4lmiix?videoFoam=true',
    'https://fast.wistia.com/embed/medias/26sk4lmiix.json',
    'https://home.wistia.com/medias/26sk4lmiix',
    'https://support.wi.st/medias/26sk4lmiix',
  ])('wistia %s', (input) => {
    expect(refOf(matchWistia, input)).toMatchObject({ platform: 'wistia', id: 'wistia:26sk4lmiix', url: 'https://fast.wistia.net/embed/iframe/26sk4lmiix' });
  });

  it.each(['https://wistia.com/medias/26sk4lmiix', 'https://fast.wistia.net/embed/iframe/SHORT', 'https://www.wistia.com/'])(
    'wistia ignores %s',
    (input) => {
      expect(matchWistia(input)).toBeNull();
    },
  );
});

describe('parseVtt', () => {
  it('parses a real Vimeo creator track, stripping italics', () => {
    const segs = parseVtt(fixture('vimeo-76979871-en.vtt'));
    expect(segs[0]).toEqual({ startSec: 5.237, endSec: 8.043, text: "Here at Vimeo, there's always one thing on our minds:" });
    expect(segs.every((s) => !/[<>]/.test(s.text) && s.endSec >= s.startSec)).toBe(true);
    expect(segs.length).toBeGreaterThan(10);
  });

  it('reads voice spans as speakers (Loom)', () => {
    const segs = parseVtt(fixture(`loom-${LOOM_ID}.vtt`));
    expect(segs[0]).toEqual({ startSec: 0, endSec: 2.32, text: 'Every team has the potential for greatness.', speaker: '0' });
  });

  it('gives the same segments with a BOM, CRLF line ends and a NOTE block', () => {
    const raw = fixture('vimeo-76979871-en.vtt');
    const variant = `﻿${raw.replace(/^WEBVTT\n/, 'WEBVTT - recorded from Vimeo\n\nNOTE\nadded for the parser test\n').replace(/\n/g, '\r\n')}`;
    expect(parseVtt(variant)).toEqual(parseVtt(raw));
  });

  it('collapses rolling auto-captions with cue settings and karaoke timestamps', () => {
    const segs = parseVtt(fixture('youtube-QYRbx7PhiB8-rolling.en.vtt'));
    expect(segs.slice(0, 3)).toEqual([
      { startSec: 0, endSec: 1.05, text: 'hello everyone welcome to' },
      { startSec: 1.05, endSec: 2.73, text: 'auto mechanics I hope you are' },
      { startSec: 2.73, endSec: 3.959, text: "well today I'm going to give you a" },
    ]);
    // Every spoken line appears once, in order, with no tags left.
    for (let i = 1; i < segs.length; i++) {
      expect(segs[i]?.text).not.toBe(segs[i - 1]?.text);
      expect(segs[i]?.startSec).toBeGreaterThanOrEqual(segs[i - 1]?.startSec ?? 0);
    }
    expect(segs.some((s) => /[<>]|&nbsp;/.test(s.text))).toBe(false);
  });

  it('reads short and long timestamps', () => {
    expect(vttTime('01:02:03.500')).toBe(3723.5);
    expect(vttTime('02:03.250')).toBe(123.25);
    expect(vttTime('00:00:01,040')).toBe(1.04);
  });

  it('returns no segments for a file without cues', () => {
    expect(parseVtt('WEBVTT\n\nNOTE nothing here\n')).toEqual([]);
  });
});

describe('vimeo', () => {
  it('maps track provenance to origin', () => {
    const cfg = JSON.parse(fixture('vimeo-config-1133654544.json')) as VimeoConfig;
    const tracks = cfg.request?.text_tracks ?? [];
    expect(tracks.map((t) => [t.lang, trackOrigin(t)])).toEqual([
      ['en-x-autogen', 'auto-captions'],
      ['de', 'creator-captions'],
      ['es', 'creator-captions'],
      ['fr', 'creator-captions'],
      ['ja', 'creator-captions'],
      ['ko', 'creator-captions'],
      ['pt', 'creator-captions'],
    ]);
  });

  it('chooses tracks by language, origin and the video locale', () => {
    const tracks = (JSON.parse(fixture('vimeo-config-1133654544.json')) as VimeoConfig).request?.text_tracks as VimeoTextTrack[];
    expect(chooseVimeoTrack(tracks, {}, 'en')?.lang).toBe('en-x-autogen');
    expect(chooseVimeoTrack(tracks, { language: 'de' }, 'en')?.lang).toBe('de');
    expect(chooseVimeoTrack(tracks, { language: 'en', allowAuto: false }, 'en')).toBeNull();
    expect(chooseVimeoTrack(tracks, { language: 'it' }, 'en')).toBeNull();
    const creatorOnly = (JSON.parse(fixture('vimeo-config-76979871.json')) as VimeoConfig).request?.text_tracks as VimeoTextTrack[];
    expect(chooseVimeoTrack(creatorOnly, {}, 'en')?.lang).toBe('en');
    expect(chooseVimeoTrack(creatorOnly, {})?.lang).toBe('de'); // no locale: the track Vimeo marks default
  });

  it('builds metadata from oEmbed and the player config', async () => {
    const ctx = testContext({ fetch: vimeoReplay() });
    const meta = await vimeoSource.getMetadata(refOf(matchVimeo, 'https://vimeo.com/76979871'), ctx);
    expect(meta).toMatchObject({
      title: 'The New Vimeo Player (You Know, For Videos)',
      channel: { name: 'Vimeo', id: '152184', url: 'https://vimeo.com/staff' },
      durationSec: 62,
      publishedAt: '2013-10-15T14:08:29',
      chapters: [],
      extra: { privacy: 'anybody', embedPermission: 'public', accountType: 'enterprise' },
    });
    expect(meta.thumbnailUrl).toMatch(/^https:\/\/i\.vimeocdn\.com\/video\/452001751-/);
    expect(meta.description).toMatch(/rebuilt our player/);
  });

  it('returns the creator track in the spoken language', async () => {
    const fetch = vimeoReplay();
    const ctx = testContext({ fetch });
    const ref = refOf(matchVimeo, 'https://vimeo.com/76979871');
    await vimeoSource.getMetadata(ref, ctx);
    const t = await vimeoCaptionsProvider.getCaptions(ref, {}, ctx);
    expect(t).toMatchObject({ language: 'en', origin: 'creator-captions', producer: 'vimeo-captions' });
    expect(t?.segments[0]?.text).toBe("Here at Vimeo, there's always one thing on our minds:");
    // The player config is fetched once per context and shared by metadata and captions.
    expect(fetch.calls.filter((c) => c.url.endsWith('/config'))).toHaveLength(1);
  });

  it('labels Vimeo speech recognition as auto-captions and keeps creator translations reachable', async () => {
    const ctx = testContext({ fetch: vimeoReplay() });
    const ref = refOf(matchVimeo, 'https://vimeo.com/1133654544');
    const auto = await vimeoCaptionsProvider.getCaptions(ref, {}, ctx);
    expect(auto).toMatchObject({ language: 'en', origin: 'auto-captions' });
    expect(auto?.segments[0]?.text).toBe('Welcome to Reframe 2025.');
    const de = await vimeoCaptionsProvider.getCaptions(ref, { language: 'de' }, ctx);
    expect(de).toMatchObject({ language: 'de', origin: 'creator-captions' });
    expect(de?.segments[0]?.text).toBe('Willkommen zu REFRAME 2025.');
    expect(await vimeoCaptionsProvider.listTracks?.(ref, ctx)).toContainEqual({ language: 'en', name: 'English (auto-generated)', origin: 'auto-captions' });
  });

  it('reports a private video as unavailable from both metadata and captions', async () => {
    const ctx = testContext({ fetch: vimeoReplay() });
    const ref = refOf(matchVimeo, 'https://vimeo.com/336812660');
    expect(await codeOf(vimeoSource.getMetadata(ref, ctx))).toBe('unavailable');
    expect(await codeOf(vimeoCaptionsProvider.getCaptions(ref, {}, ctx))).toBe('unavailable');
  });

  it('falls back to oEmbed metadata when the player config is behind a bot check, and reports captions as blocked', async () => {
    const ctx = testContext({ fetch: vimeoReplay() });
    const ref = refOf(matchVimeo, 'https://vimeo.com/1084537');
    const meta = await vimeoSource.getMetadata(ref, ctx);
    expect(meta).toMatchObject({ title: 'Big Buck Bunny', channel: { name: 'Blender' }, extra: { configBlocked: true, accountType: 'basic' } });
    expect(await codeOf(vimeoCaptionsProvider.getCaptions(ref, {}, ctx))).toBe('blocked');
  });

  it('reports a deleted video as not-found', async () => {
    const ctx = testContext({ fetch: vimeoReplay() });
    expect(await codeOf(vimeoSource.getMetadata(refOf(matchVimeo, 'https://vimeo.com/1000'), ctx))).toBe('not-found');
  });
});

describe('loom', () => {
  const ref = refOf(matchLoom, `https://www.loom.com/share/${LOOM_ID}`);

  it('reads metadata and chapters from the share page', async () => {
    const meta = await loomSource.getMetadata(ref, testContext({ fetch: loomReplay() }));
    expect(meta).toMatchObject({
      title: 'Unstuck your team with Loom',
      channel: { name: 'Hello Loom', id: '3860843' },
      durationSec: 60.101708,
      publishedAt: '2025-09-19T03:55:36.904Z',
      language: 'en',
      chapters: [
        { title: 'Stuck Teams and Challenges', startSec: 0, endSec: 47 },
        { title: 'The Future with Loom', startSec: 47, endSec: 60.101708 },
      ],
      extra: { privacy: 'public' },
    });
    expect(meta.thumbnailUrl).toBe(`https://cdn.loom.com/sessions/thumbnails/${LOOM_ID}-b5213f287fcef7f0.jpg`);
  });

  it('returns Loom speech recognition captions as auto-captions', async () => {
    const fetch = loomReplay();
    const ctx = testContext({ fetch });
    await loomSource.getMetadata(ref, ctx);
    const t = await loomCaptionsProvider.getCaptions(ref, {}, ctx);
    expect(t).toMatchObject({ language: 'en', origin: 'auto-captions', producer: 'loom-captions', model: 'instant_whisper' });
    expect(t?.segments[1]?.text).toBe('But most, most stuck. They stuck hard.');
    expect(fetch.calls.filter((c) => c.url.includes('/share/'))).toHaveLength(1);
    expect(await loomCaptionsProvider.getCaptions(ref, { allowAuto: false }, ctx)).toBeNull();
    expect(await loomCaptionsProvider.getCaptions(ref, { language: 'fr' }, ctx)).toBeNull();
  });

  it('reports a missing video as not-found', async () => {
    const missing = refOf(matchLoom, `https://www.loom.com/share/${LOOM_MISSING}`);
    expect(await codeOf(loomSource.getMetadata(missing, testContext({ fetch: loomReplay() })))).toBe('not-found');
  });

  it('parses chapter text', () => {
    expect(parseLoomChapters('00:00 Intro\n1:02:03 Late', 4000)).toEqual([
      { title: 'Intro', startSec: 0, endSec: 3723 },
      { title: 'Late', startSec: 3723, endSec: 4000 },
    ]);
    expect(parseLoomChapters(undefined)).toEqual([]);
  });
});

describe('wistia', () => {
  const ref = refOf(matchWistia, 'https://fast.wistia.net/embed/iframe/i5voqxuarc');

  it('reads metadata from the media JSON', async () => {
    const meta = await wistiaSource.getMetadata(ref, testContext({ fetch: wistiaReplay() }));
    expect(meta).toMatchObject({
      title: '"Laptop On Fire" Front Page Video - August 2025',
      description: 'a Front Page Videos (aka Frontpage / Home Page Videos) video',
      durationSec: 74.4896,
      publishedAt: '2025-08-04T21:30:55.000Z',
      chapters: [],
      extra: { mediaType: 'Video' },
    });
    expect(meta.thumbnailUrl).toBe('https://embed-ssl.wistia.com/deliveries/8598b6a601156150f32dabb4c6c0e6f1.jpg');
  });

  it('picks English among several tracks, drops audio descriptions, and honours a requested language', async () => {
    const ctx = testContext({ fetch: wistiaReplay() });
    const en = await wistiaCaptionsProvider.getCaptions(ref, {}, ctx);
    expect(en).toMatchObject({ language: 'en', origin: 'creator-captions', producer: 'wistia-captions' });
    expect(en?.segments[0]).toEqual({ startSec: 0.16, endSec: 1.54, text: 'You look stressed.' });
    expect(en?.segments.some((s) => /^Speaker \d+\.$/.test(s.text))).toBe(false);
    const nl = await wistiaCaptionsProvider.getCaptions(ref, { language: 'nl' }, ctx);
    expect(nl?.segments[0]?.text).toBe('Je ziet er gestrest uit.');
    expect(await wistiaCaptionsProvider.getCaptions(ref, { language: 'it' }, ctx)).toBeNull();
    expect((await wistiaCaptionsProvider.listTracks?.(ref, ctx))?.map((t) => t.language)).toEqual(['nl', 'en', 'es-MX', 'fr', 'de', 'pt', 'es']);
  });

  it('returns null for media without captions and not-found for an unknown id', async () => {
    const ctx = testContext({ fetch: wistiaReplay() });
    expect(await wistiaCaptionsProvider.getCaptions(refOf(matchWistia, 'https://fast.wistia.net/embed/iframe/26sk4lmiix'), {}, ctx)).toBeNull();
    expect(await codeOf(wistiaSource.getMetadata(refOf(matchWistia, 'https://fast.wistia.net/embed/iframe/zzzzzzzzzz'), ctx))).toBe('not-found');
  });
});

describe('pipeline', () => {
  it('resolves a plain Vimeo URL to vimeo and gets creator captions without speech-to-text', async () => {
    const registry = new Registry(providers, 'node');
    const ctx = testContext({ fetch: vimeoReplay() });
    const result = await getVideoContext(registry, 'https://vimeo.com/76979871', { mode: 'auto' }, ctx);
    expect(result.metadata.ref.id).toBe('vimeo:76979871');
    expect(result.transcript).toMatchObject({ origin: 'creator-captions', producer: 'vimeo-captions', language: 'en' });
    expect(result.attempts.some((a) => a.stage === 'stt' || a.stage === 'audio')).toBe(false);
  });

  it('declares only node and workers runtimes', () => {
    expect(new Set(providers.flatMap((p) => p.runtimes))).toEqual(new Set(['node', 'workers']));
  });
});

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { type Ctx, getVideoContext, Registry, Vid2ContextError, type VideoRef } from '@vid2context/core';
import { type Route, replayFetch, testContext } from '@vid2context/core/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  audioFilename,
  clearResolveCache,
  cueTime,
  episodeLocator,
  episodeUrl,
  feedRef,
  itemKey,
  looksLikeFeed,
  matchPodcast,
  normTitle,
  parseDuration,
  parseFeed,
  parseFeedChunks,
  parseHtmlTranscript,
  parseJsonChapters,
  parseJsonTranscript,
  parseSubtitles,
  parseXml,
  podcastSource,
  podcastTranscript,
  rankTranscripts,
} from '../src/index.ts';

const FIX = join(import.meta.dirname, 'fixtures');
const text = (name: string): string => readFileSync(join(FIX, name), 'utf8');
const bytes = (name: string): Uint8Array => new Uint8Array(readFileSync(join(FIX, name)));

const PNWR_FEED = 'https://rss.buzzsprout.com/1538779.rss';
const PC20_FEED = 'http://mp3s.nashownotes.com/pc20rss.xml';
const JRE_FEED = 'https://feeds.megaphone.fm/GLT1412515089';
const SSGL_FEED = 'https://feeds.megaphone.fm/NATIONALAERONAUTICSANDSPACEADMINISTRATION5360639309';
const XML = { 'content-type': 'application/rss+xml; charset=utf-8' };
const JSON_H = { 'content-type': 'application/json' };

const routes: Record<string, Route> = {
  pnwr: { url: PNWR_FEED, response: { headers: XML, body: text('pnwr-feed.xml') } },
  pc20: { url: PC20_FEED, response: { headers: XML, body: text('pc20-feed.xml') } },
  jre: { url: JRE_FEED, response: { headers: XML, body: text('jre-feed.xml') } },
  ssgl: { url: SSGL_FEED, response: { headers: XML, body: text('ssgl-feed.xml') } },
  pnwrVtt: {
    url: 'https://www.buzzsprout.com/1538779/20117890/transcript.vtt',
    response: { headers: { 'content-type': 'text/vtt' }, body: text('pnwr-20117890-transcript.vtt') },
  },
  pnwrSrt: {
    url: 'https://www.buzzsprout.com/1538779/20117890/transcript.srt',
    response: { headers: { 'content-type': 'application/x-subrip' }, body: text('pnwr-20117890-transcript.srt') },
  },
  pnwrChapters: {
    url: 'https://www.buzzsprout.com/1538779/20117890/chapters.json',
    response: { headers: JSON_H, body: text('pnwr-20117890-chapters.json') },
  },
  pc20Srt: {
    url: 'https://mp3s.nashownotes.com/PC20-278-Captions.srt',
    response: { headers: { 'content-type': 'application/x-subrip' }, body: text('pc20-278-captions.srt') },
  },
  pc20Chapters: {
    url: /^https:\/\/reflex\.livewire\.io\/chapters\/podcast\/.*PC20-278-Chapters\.json$/,
    response: { headers: JSON_H, body: text('pc20-278-chapters.json') },
  },
  pnwrLookup: {
    url: 'https://itunes.apple.com/lookup?id=1542481043&entity=podcastEpisode&limit=200',
    response: { headers: JSON_H, body: text('itunes-lookup-1542481043.json') },
  },
  ssglLookup: {
    url: 'https://itunes.apple.com/lookup?id=1445597915&entity=podcastEpisode&limit=200',
    response: { headers: JSON_H, body: text('itunes-lookup-1445597915.json') },
  },
};

const ctxWith = (list: Route[], env: Record<string, string> = {}) => {
  const fetch = replayFetch(list);
  return { fetch, ctx: testContext({ fetch, env }) };
};

function ref(input: string): VideoRef {
  const r = matchPodcast(input);
  if (!r) throw new Error(`no match for ${input}`);
  return r;
}

async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const x of it) out.push(x);
  return out;
}

async function rejection(p: Promise<unknown>): Promise<Vid2ContextError> {
  try {
    await p;
  } catch (err) {
    if (err instanceof Vid2ContextError) return err;
    throw err;
  }
  throw new Error('expected a Vid2ContextError');
}

function list(r: VideoRef, ctx: Ctx, opts?: { limit?: number }): Promise<VideoRef[]> {
  const fn = podcastSource.listItems;
  if (!fn) throw new Error('podcast source has no listItems');
  return collect(fn(r, ctx, opts));
}

const sha = (s: string) => createHash('sha256').update(s).digest('hex');

beforeEach(() => clearResolveCache());

describe('matching', () => {
  it('recognises feed URLs by extension, path and known host', () => {
    for (const url of [
      PNWR_FEED,
      PC20_FEED,
      JRE_FEED,
      'https://feeds.simplecast.com/Y8lFbOT4',
      'https://rss.art19.com/the-daily',
      'https://feeds.buzzsprout.com/1538779.rss',
      'https://anchor.fm/s/119db58c0/podcast/rss',
      'https://feeds.transistor.fm/safe-travels',
      'https://www.omnycontent.com/d/playlist/e73c998e/a91018a4/44710ecc/podcast.rss',
      'https://feed.podbean.com/keepyoureyesopen/feed.xml',
      'https://feeds.libsyn.com/633804/rss',
      'https://feeds.acast.com/public/shows/68343e1669c98f151d8f0020',
      'https://feeds.captivate.fm/inandaroundpodcasting/',
      'https://lexfridman.com/feed/podcast/',
      'https://cre.fm/feed/atom',
      'https://huffduffer.com/adactio/atom.xml',
    ]) {
      expect(looksLikeFeed(url), url).toBe(true);
      expect(matchPodcast(url)).toMatchObject({ platform: 'podcast', kind: 'feed' });
    }
  });

  it('builds feed refs with a sha256 of the canonical feed URL', () => {
    const r = ref(`${PNWR_FEED}#top`);
    expect(r).toEqual({
      input: `${PNWR_FEED}#top`,
      platform: 'podcast',
      kind: 'feed',
      id: `podcast:feed:${sha(PNWR_FEED)}`,
      nativeId: sha(PNWR_FEED),
      url: PNWR_FEED,
    });
  });

  it('accepts the explicit podcast: form for feeds the heuristics miss', () => {
    expect(matchPodcast('https://example.org/shows/weekly')).toBeNull();
    expect(ref('podcast:https://example.org/shows/weekly')).toMatchObject({
      kind: 'feed',
      url: 'https://example.org/shows/weekly',
    });
  });

  it('round-trips episode URLs (feed URL + #item=) to the same ref', () => {
    const url = episodeUrl(PNWR_FEED, 'Buzzsprout-20117890');
    expect(url).toBe(`${PNWR_FEED}#item=Buzzsprout-20117890`);
    const r = ref(url);
    expect(r).toMatchObject({ kind: 'video', platform: 'podcast', url, nativeId: sha(`${PNWR_FEED}\nBuzzsprout-20117890`) });
    expect(r.id).toBe(`podcast:${r.nativeId}`);
    expect(episodeLocator(r)).toEqual({ feedUrl: PNWR_FEED, key: 'Buzzsprout-20117890' });
    // Feeds outside the heuristics keep the explicit prefix so the URL still resolves here.
    const odd = episodeUrl('https://example.org/shows/weekly', 'urn:uuid:a b');
    expect(odd).toBe('podcast:https://example.org/shows/weekly#item=urn%3Auuid%3Aa%20b');
    expect(episodeLocator(ref(odd))).toEqual({ feedUrl: 'https://example.org/shows/weekly', key: 'urn:uuid:a b' });
  });

  it('recognises Apple Podcasts show and episode links', () => {
    expect(ref('https://podcasts.apple.com/us/podcast/podnews-weekly-review/id1542481043')).toMatchObject({
      kind: 'feed',
      id: 'podcast:feed:apple-1542481043',
      nativeId: 'apple-1542481043',
    });
    const ep = ref(
      'https://podcasts.apple.com/gb/podcast/iheart-the-business-deal-that-doesnt-make-any-sense/id1542481043?i=1000801656977&uo=4',
    );
    expect(ep).toMatchObject({
      kind: 'video',
      id: 'podcast:apple-1000801656977',
      url: 'https://podcasts.apple.com/gb/podcast/iheart-the-business-deal-that-doesnt-make-any-sense/id1542481043?i=1000801656977',
    });
    expect(matchPodcast('https://podcasts.apple.com/podcast/id1445597915')?.kind).toBe('feed');
    expect(matchPodcast('https://itunes.apple.com/us/podcast/small-steps-giant-leaps/id1445597915?mt=2')?.kind).toBe('feed');
  });

  it('recognises Spotify show and episode links and URIs', () => {
    expect(ref('https://open.spotify.com/show/4rOoJ6Egrf8K2IrywzwOMk?si=abc')).toMatchObject({
      kind: 'feed',
      id: 'podcast:feed:spotify-4rOoJ6Egrf8K2IrywzwOMk',
    });
    expect(ref('https://open.spotify.com/intl-de/episode/7Hf1JDw7XuetyEqlrIQLaG')).toMatchObject({
      kind: 'video',
      id: 'podcast:spotify-7Hf1JDw7XuetyEqlrIQLaG',
      url: 'https://open.spotify.com/episode/7Hf1JDw7XuetyEqlrIQLaG',
    });
    expect(ref('spotify:episode:7Hf1JDw7XuetyEqlrIQLaG').kind).toBe('video');
  });

  it('leaves YouTube, other platforms, media files, articles and sitemaps alone', () => {
    for (const input of [
      'https://www.youtube.com/watch?v=jNQXAC9IVRw',
      'https://www.youtube.com/feeds/videos.xml?channel_id=UC4QobU6STFB0P71PMvOGN5A',
      'https://vimeo.com/76979871',
      'https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC',
      'https://podcasts.apple.com/us/album/abbey-road/1441164426',
      'https://www.theverge.com/2024/1/1/24021000/feedback-loops-article',
      'https://example.org/blog/my-post',
      'https://example.org/sitemap.xml',
      'https://op3.dev/e/www.buzzsprout.com/1538779/episodes/6749611-the-podnews-weekly-review-the-last-word-in-podcast-news.mp3',
      'jNQXAC9IVRw',
      '/home/me/feed.xml',
    ]) {
      expect(matchPodcast(input), input).toBeNull();
    }
  });
});

describe('feed parsing', () => {
  it('reads the channel and Podcasting 2.0 item tags (podcast:transcript, podcast:chapters, podcast:person)', async () => {
    const { channel, items } = await parseFeed(text('pnwr-feed.xml'));
    expect(channel).toMatchObject({
      format: 'rss',
      title: 'Podnews Weekly Review',
      author: 'James Cridland and Sam Sethi',
      language: 'en',
      link: 'https://podnews.net',
      selfUrl: PNWR_FEED,
      image: 'https://storage.buzzsprout.com/h0w7hpcbjj7237mrrbhi6dshp83v?.jpg',
    });
    expect(channel.description).toMatch(/^The last word in podcasting news\./);
    expect(channel.persons.map((p) => p.name)).toEqual(['James Cridland', 'Sam Sethi']);
    expect(items).toHaveLength(4);
    const first = items[0];
    expect(first).toMatchObject({
      title: "iHeart - the business deal that doesn't make any sense",
      guid: 'Buzzsprout-20117890',
      publishedAt: '2026-11-13T03:00:00.000Z',
      durationSec: 4778,
      enclosure: {
        url: 'https://op3.dev/e/www.buzzsprout.com/1538779/episodes/20117890-iheart-the-business-deal-that-doesn-t-make-any-sense.mp3',
        type: 'audio/mpeg',
        length: 114719364,
      },
      chaptersUrl: 'https://www.buzzsprout.com/1538779/20117890/chapters.json',
    });
    expect(first?.transcripts.map((t) => t.type)).toEqual(['text/html', 'application/json', 'application/x-subrip', 'text/vtt']);
    expect(first?.description).toMatch(/Sam gets out of his sick bed/);
    expect(first?.description).not.toMatch(/<p>/);
    expect(first?.inlineChapters[1]).toEqual({ title: 'Is iHeart Selling Podcasts', startSec: 16, endSec: 275 });
    expect(items[3]).toMatchObject({ durationSec: 73, transcripts: [], season: 1 });
  });

  it('reads the Podcast Index feed: CDATA titles, application/srt transcripts, persons with groups, liveItems skipped', async () => {
    const { channel, items } = await parseFeed(text('pc20-feed.xml'));
    expect(channel).toMatchObject({ title: 'Podcasting 2.0', author: 'Podcast Index LLC', link: 'http://podcastindex.org' });
    expect(items.map((i) => i.guid)).toEqual(['PC20-278', 'PC20-277', 'PC20-276']);
    const ep = items[0];
    expect(ep).toMatchObject({
      title: 'Episode 278: "1 Billion Tokens!"',
      link: 'https://www.podpage.com/podcasting-20/1billion-tokens/',
      durationSec: 6293,
      transcripts: [{ url: 'https://mp3s.nashownotes.com/PC20-278-Captions.srt', type: 'application/srt', rel: 'captions' }],
      chaptersType: 'application/json',
    });
    expect(ep?.persons[0]).toEqual({
      name: 'Adam Curry',
      role: 'host',
      group: 'cast',
      href: 'http://curry.com',
      img: 'https://feeds.podcastindex.org/adam_avatar.jpg',
    });
  });

  it('reads plain iTunes-style feeds (megaphone) with CDATA guids and episode numbers', async () => {
    const { channel, items } = await parseFeed(text('ssgl-feed.xml'));
    expect(channel).toMatchObject({
      title: 'Small Steps, Giant Leaps',
      author: 'National Aeronautics and Space Administration (NASA)',
      language: 'en-US',
      link: 'https://www.nasa.gov/podcasts/small-steps-giant-leaps/',
    });
    expect(items[0]).toMatchObject({
      title: 'Supercomputing',
      guid: 'f7a05c70-dd5b-11f1-b073-879875e7952e',
      publishedAt: '2026-11-10T23:10:00.000Z',
      durationSec: 1031,
      episode: 186,
      enclosure: {
        url: 'https://traffic.megaphone.fm/NATIONALAERONAUTICSANDSPACEADMINISTRATION1474801934.mp3',
        type: 'audio/mpeg',
      },
    });
    // length="0" means unknown, not empty.
    expect(items[0]?.enclosure?.length).toBeUndefined();
    expect(items[0]?.image).toMatch(/^https:\/\/megaphone\.imgix\.net\//);
  });

  it('reads Atom feeds: enclosure links, ids, published dates, xml:lang', async () => {
    const huff = await parseFeed(text('huffduffer-adactio-atom.xml'));
    expect(huff.channel).toMatchObject({
      format: 'atom',
      title: 'adactio on Huffduffer',
      link: 'https://huffduffer.com/adactio',
      image: 'https://huffduffer.com/images/podcast.jpg',
    });
    expect(huff.items).toHaveLength(4);
    expect(huff.items[0]).toMatchObject({
      guid: 'urn:uuid:4af84d7c-8211-abb2-3281-13e58bebb3f9',
      link: 'https://huffduffer.com/adactio/719053',
      publishedAt: '2026-10-17T00:39:15.000Z',
      enclosure: {
        url: 'https://emergencemagazine.org/app/uploads/2026/10/James_Bridle_Benchmarking_2026-10-14_WEB.mp3',
        type: 'audio/mpeg',
      },
    });
    const cre = await parseFeed(text('cre-atom.xml'));
    expect(cre.channel).toMatchObject({ format: 'atom', title: 'CRE: Technik, Kultur, Gesellschaft', language: 'de' });
    // Empty <id></id>: the item key falls back to the entry link.
    expect(cre.items[0]?.guid).toBeUndefined();
    expect(itemKey(cre.items[0] as never)).toBe('https://cre.fm/cre225-permakultur');
    expect(cre.items[0]?.title).toBe('CRE225 Permakultur');
  });

  it('parses the same feed identically when it arrives in tiny chunks', async () => {
    const whole = await parseFeed(text('pnwr-feed.xml'));
    const src = text('pnwr-feed.xml');
    const chunks: string[] = [];
    for (let i = 0; i < src.length; i += 7) chunks.push(src.slice(i, i + 7));
    const events = await collect(parseFeedChunks(chunks));
    expect(events[0]?.type).toBe('channel');
    expect(events.filter((e) => e.type === 'item').map((e) => (e.type === 'item' ? e.item : null))).toEqual(whole.items);
  });

  it('refuses documents that are not feeds', async () => {
    const err = await rejection(parseFeed('<!doctype html><html><body><p>hi</p></body></html>'));
    expect(err.code).toBe('unsupported-input');
    expect(err.hint).toMatch(/RSS feed URL/);
  });

  it('handles namespaces bound to other prefixes, entities and comments', () => {
    const root = parseXml(
      '<?xml version="1.0"?><!-- c --><rss xmlns:pc="https://podcastindex.org/namespace/1.0"><channel><pc:transcript url="a&amp;b"/><title>A &amp; B &#8211; C</title></channel></rss>',
    );
    const channel = root?.children[0];
    expect(channel?.children[0]).toMatchObject({ name: 'podcast:transcript', attrs: { url: 'a&b' } });
    expect(channel?.children[1]?.text).toBe('A & B – C');
  });

  it('parses durations', () => {
    expect(parseDuration('1:02:03')).toBe(3723);
    expect(parseDuration('62:03')).toBe(3723);
    expect(parseDuration('3723')).toBe(3723);
    expect(parseDuration('0')).toBeUndefined();
    expect(parseDuration('about an hour')).toBeUndefined();
  });
});

describe('transcripts', () => {
  it('prefers VTT, then SRT, then JSON, then HTML, and the requested language first', () => {
    const list = [
      { url: 'h', type: 'text/html' },
      { url: 'j', type: 'application/json' },
      { url: 's', type: 'application/x-subrip' },
      { url: 'v', type: 'text/vtt' },
      { url: 'x', type: 'application/pdf' },
    ];
    expect(rankTranscripts(list).map((t) => t.format)).toEqual(['vtt', 'srt', 'json', 'html']);
    const langs = [
      { url: 'v-en', type: 'text/vtt', language: 'en' },
      { url: 's-es', type: 'application/srt', language: 'es' },
    ];
    expect(rankTranscripts(langs, 'es-MX')[0]?.url).toBe('s-es');
  });

  it('parses VTT with voice spans into speakers', () => {
    const segs = parseSubtitles(text('pnwr-20117890-transcript.vtt'));
    expect(segs[0]).toEqual({
      startSec: 0.16,
      endSec: 4.08,
      text: "Coming up, iHeart's Podcasts for Sale or not?",
      speaker: 'James Cridland',
    });
    expect(segs[4]?.speaker).toBe('Sam Sethi');
  });

  it('parses SRT, taking "Name:" turn labels as speakers that carry over', () => {
    const segs = parseSubtitles(text('pnwr-20117890-transcript.srt'));
    expect(segs.slice(0, 3)).toEqual([
      { startSec: 0.16, endSec: 3.839, text: "Coming up, iHeart's Podcasts for Sale or", speaker: 'James Cridland' },
      { startSec: 3.839, endSec: 4.08, text: 'not?', speaker: 'James Cridland' },
      { startSec: 4.48, endSec: 7.2, text: 'With James Cridland and Sam Sethi.', speaker: 'Announcer' },
    ]);
    const pc20 = parseSubtitles(text('pc20-278-captions.srt'));
    expect(pc20[0]).toEqual({
      startSec: 0.5,
      endSec: 6.349,
      text: 'Podcasting 2.0 for November 13, 2026, episode 278, 1 Billion',
    });
    expect(cueTime('01:02:03,500')).toBe(3723.5);
  });

  it('merges word-level JSON transcripts into phrases per speaker', () => {
    const segs = parseJsonTranscript(text('pnwr-20117890-transcript.json'));
    expect(segs[0]).toEqual({
      startSec: 0.16,
      endSec: 4.08,
      text: "Coming up, iHeart's Podcasts for Sale or not?",
      speaker: 'James Cridland',
    });
    expect(segs[1]?.speaker).toBe('Announcer');
    expect(segs.every((s) => s.endSec >= s.startSec)).toBe(true);
  });

  it('reads HTML transcripts per paragraph, with times when the page has them', () => {
    const { segments, timed } = parseHtmlTranscript(text('pnwr-20117890-transcript.html'));
    expect(timed).toBe(true);
    expect(segments[0]).toEqual({
      startSec: 0,
      endSec: 4,
      text: "Coming up, iHeart's Podcasts for Sale or not?",
      speaker: 'James Cridland',
    });
    expect(segments[1]).toMatchObject({ startSec: 4, speaker: 'Announcer' });
    const untimed = parseHtmlTranscript('<html><body><p>First paragraph.</p><p>Second.</p></body></html>');
    expect(untimed.timed).toBe(false);
    expect(untimed.segments.map((s) => [s.startSec, s.text])).toEqual([
      [0, 'First paragraph.'],
      [0, 'Second.'],
    ]);
  });
});

describe('chapters', () => {
  it('maps JSON chapters with end times from the next start and the duration', () => {
    const ch = parseJsonChapters(text('pnwr-20117890-chapters.json'), 4778);
    expect(ch[0]).toEqual({ title: 'Welcome And Top Stories', startSec: 0, endSec: 16 });
    expect(ch[ch.length - 1]?.endSec).toBe(4778);
    const pc20 = parseJsonChapters(text('pc20-278-chapters.json'));
    expect(pc20).toHaveLength(39);
    expect(pc20[0]).toEqual({ title: '1 Billion Tokens! Welcome to the Boardroom', startSec: 0, endSec: 58 });
  });
});

describe('podcast source and podcast-transcript captions (replayed)', () => {
  const PNWR_EP = `${PNWR_FEED}#item=Buzzsprout-20117890`;

  it('lists episodes newest first and respects the limit', async () => {
    const { ctx } = ctxWith([routes.pnwr as Route]);
    const all = await list(ref(PNWR_FEED), ctx);
    expect(all.map((r) => r.url)).toEqual([
      PNWR_EP,
      `${PNWR_FEED}#item=Buzzsprout-20081931`,
      `${PNWR_FEED}#item=Buzzsprout-20044916`,
      `${PNWR_FEED}#item=616dcd50-8387-46a2-a149-bdee833c4a47`,
    ]);
    expect(all[0]).toEqual(ref(PNWR_EP));
    const two = await list(ref(PNWR_FEED), ctx, { limit: 2 });
    expect(two).toHaveLength(2);
  });

  it('returns episode metadata with chapters from podcast:chapters and persons', async () => {
    const { ctx } = ctxWith([routes.pnwr as Route, routes.pnwrChapters as Route]);
    const meta = await podcastSource.getMetadata(ref(PNWR_EP), ctx);
    expect(meta).toMatchObject({
      title: "iHeart - the business deal that doesn't make any sense",
      channel: { name: 'Podnews Weekly Review', id: PNWR_FEED, url: 'https://podnews.net' },
      durationSec: 4778,
      publishedAt: '2026-11-13T03:00:00.000Z',
      language: 'en',
      thumbnailUrl: 'https://storage.buzzsprout.com/h0w7hpcbjj7237mrrbhi6dshp83v?.jpg',
    });
    expect(meta.chapters).toHaveLength(15);
    expect(meta.chapters[1]).toEqual({ title: 'Is iHeart Selling Podcasts', startSec: 16, endSec: 275 });
    expect((meta.extra?.persons as { name: string }[] | undefined)?.map((p) => p.name)).toEqual(['James Cridland', 'Sam Sethi']);
  });

  it("falls back to the feed's inline psc:chapters when the chapters URL fails", async () => {
    const { ctx } = ctxWith([routes.pnwr as Route]);
    const meta = await podcastSource.getMetadata(ref(PNWR_EP), ctx);
    expect(meta.chapters[0]).toEqual({ title: 'Welcome And Top Stories', startSec: 0, endSec: 16 });
  });

  it('returns the VTT native transcript, the best of four types', async () => {
    const { ctx, fetch } = ctxWith([routes.pnwr as Route, routes.pnwrVtt as Route]);
    const t = await podcastTranscript.getCaptions(ref(PNWR_EP), {}, ctx);
    expect(t).toMatchObject({ origin: 'native-transcript', producer: 'podcast-transcript', language: 'en' });
    expect(t?.segments[0]?.speaker).toBe('James Cridland');
    expect(fetch.calls.map((c) => c.url)).toEqual([PNWR_FEED, 'https://www.buzzsprout.com/1538779/20117890/transcript.vtt']);
    const tracks = await podcastTranscript.listTracks?.(ref(PNWR_EP), ctx);
    expect(tracks?.map((x) => x.name)).toEqual([
      'VTT (text/vtt)',
      'SRT (application/x-subrip)',
      'JSON (application/json)',
      'HTML (text/html)',
    ]);
  });

  it('falls through to the next transcript type when one fails', async () => {
    const { ctx } = ctxWith([routes.pnwr as Route, routes.pnwrSrt as Route]);
    const t = await podcastTranscript.getCaptions(ref(PNWR_EP), {}, ctx);
    expect(t?.segments[0]?.text).toBe("Coming up, iHeart's Podcasts for Sale or");
  });

  it('returns null for episodes without podcast:transcript', async () => {
    const { ctx } = ctxWith([routes.pnwr as Route]);
    expect(
      await podcastTranscript.getCaptions(ref(`${PNWR_FEED}#item=616dcd50-8387-46a2-a149-bdee833c4a47`), {}, ctx),
    ).toBeNull();
  });

  it('runs the pipeline on a feed episode with a native transcript and never reaches speech-to-text', async () => {
    const { ctx } = ctxWith([routes.pc20 as Route, routes.pc20Srt as Route, routes.pc20Chapters as Route]);
    const registry = new Registry([podcastSource, podcastTranscript], 'node');
    const result = await getVideoContext(registry, `${PC20_FEED}#item=PC20-278`, { mode: 'auto', storage: null }, ctx);
    expect(result.metadata.title).toBe('Episode 278: "1 Billion Tokens!"');
    expect(result.metadata.chapters).toHaveLength(39);
    expect(result.transcript).toMatchObject({ origin: 'native-transcript', producer: 'podcast-transcript', language: 'en' });
    expect(result.transcript.segments.length).toBeGreaterThan(50);
    expect(result.attempts.some((a) => a.stage === 'stt' || a.stage === 'audio')).toBe(false);
  });

  it('says clearly when an episode has left the feed', async () => {
    const { ctx } = ctxWith([routes.pnwr as Route]);
    const err = await rejection(podcastSource.getMetadata(ref(`${PNWR_FEED}#item=Buzzsprout-1`), ctx));
    expect(err.code).toBe('not-found');
    expect(err.hint).toMatch(/Feeds drop old episodes/);
  });

  it('reports a moved feed as not-found with a hint', async () => {
    const { ctx } = ctxWith([{ url: PNWR_FEED, response: { status: 404, body: 'Not Found' } }]);
    const err = await rejection(list(feedRef(PNWR_FEED, PNWR_FEED), ctx));
    expect(err.code).toBe('not-found');
    expect(err.hint).toMatch(/moved/);
  });
});

describe('Apple Podcasts (replayed iTunes Lookup)', () => {
  it('resolves an episode link by track id to the feed item and its native transcript', async () => {
    const { ctx } = ctxWith([routes.pnwrLookup as Route, routes.pnwr as Route, routes.pnwrVtt as Route]);
    const r = ref(
      'https://podcasts.apple.com/us/podcast/iheart-the-business-deal-that-doesnt-make-any-sense/id1542481043?i=1000801656977',
    );
    const t = await podcastTranscript.getCaptions(r, {}, ctx);
    expect(t).toMatchObject({ origin: 'native-transcript', ref: r });
    expect(t?.segments.length).toBeGreaterThan(10);
  });

  it('falls back to the URL slug for episodes older than the lookup window', async () => {
    const { ctx } = ctxWith([routes.ssglLookup as Route, routes.ssgl as Route]);
    const r = ref('https://podcasts.apple.com/us/podcast/small-steps-giant-leaps-episode-0-preview/id1445597915?i=1000668876787');
    const meta = await podcastSource.getMetadata(r, ctx);
    expect(meta).toMatchObject({ title: 'Small Steps, Giant Leaps: Episode 0, Preview', durationSec: 229 });
    expect(meta.extra).toMatchObject({ feedUrl: SSGL_FEED, apple: { showId: '1445597915', episodeId: '1000668876787' } });
  });

  it('lists a show link through its feed', async () => {
    const { ctx } = ctxWith([routes.pnwrLookup as Route, routes.pnwr as Route]);
    const items = await list(ref('https://podcasts.apple.com/us/podcast/podnews-weekly-review/id1542481043'), ctx, {
      limit: 3,
    });
    expect(items[0]?.url).toBe(`${PNWR_FEED}#item=Buzzsprout-20117890`);
    expect(items).toHaveLength(3);
  });
});

describe('Spotify (replayed oEmbed, embed page, iTunes Search)', () => {
  const spotify = (kind: string, id: string): Route[] => [
    {
      url: `https://open.spotify.com/oembed?url=${encodeURIComponent(`https://open.spotify.com/${kind}/${id}`)}`,
      response: { headers: JSON_H, body: text(`spotify-oembed-${kind}-${id}.json`) },
    },
    {
      url: `https://open.spotify.com/embed/${kind}/${id}`,
      response: { headers: { 'content-type': 'text/html' }, body: text(`spotify-embed-${kind}-${id}.html`) },
    },
  ];

  it('accepts a match only when the show title, episode title and release date agree', async () => {
    const { ctx, fetch } = ctxWith([
      ...spotify('episode', '7Hf1JDw7XuetyEqlrIQLaG'),
      {
        url: 'https://itunes.apple.com/search?media=podcast&limit=10&term=The%20Joe%20Rogan%20Experience',
        response: { headers: JSON_H, body: text('itunes-search-the-joe-rogan-experience.json') },
      },
      routes.jre as Route,
    ]);
    const r = ref('https://open.spotify.com/episode/7Hf1JDw7XuetyEqlrIQLaG');
    const meta = await podcastSource.getMetadata(r, ctx);
    expect(meta).toMatchObject({
      title: '#2581 - Protect Our Parks 18',
      channel: { name: 'The Joe Rogan Experience', id: JRE_FEED },
    });
    expect(meta.extra).toMatchObject({
      guid: '8ea2bc8c-df8a-11f1-b646-13979babfcd7',
      spotify: { episodeId: '7Hf1JDw7XuetyEqlrIQLaG' },
    });
    // Only the exact show title was read; the four look-alike shows in the search were not.
    expect(
      fetch.calls.filter((c) => c.url.includes('megaphone') || c.url.includes('anchor') || c.url.includes('libsyn')),
    ).toHaveLength(1);
  });

  it('resolves a show link to its feed via the latest episode', async () => {
    const { ctx } = ctxWith([
      ...spotify('show', '4rOoJ6Egrf8K2IrywzwOMk'),
      {
        url: 'https://itunes.apple.com/search?media=podcast&limit=10&term=The%20Joe%20Rogan%20Experience',
        response: { headers: JSON_H, body: text('itunes-search-the-joe-rogan-experience.json') },
      },
      routes.jre as Route,
    ]);
    const items = await list(ref('https://open.spotify.com/show/4rOoJ6Egrf8K2IrywzwOMk'), ctx);
    expect(items).toHaveLength(3);
    expect(episodeLocator(items[0] as VideoRef)?.feedUrl).toBe(JRE_FEED);
  });

  it('rejects low-confidence matches with a hint to paste the RSS feed', async () => {
    const { ctx } = ctxWith([
      ...spotify('show', '5CfCWKI5pZ28U0uOzXkDHe'),
      {
        url: 'https://itunes.apple.com/search?media=podcast&limit=10&term=Without%20Fail',
        response: { headers: JSON_H, body: text('itunes-search-without-fail.json') },
      },
    ]);
    const err = await rejection(list(ref('https://open.spotify.com/show/5CfCWKI5pZ28U0uOzXkDHe'), ctx));
    expect(err.code).toBe('unsupported-input');
    expect(err.message).toMatch(/Without Fail/);
    expect(err.hint).toMatch(/RSS feed URL/);
  });

  it('normalizes titles for comparison', () => {
    expect(normTitle('#504 – Russia-Ukraine War')).toBe(normTitle('#504 - Russia Ukraine war'));
    expect(normTitle('News & Politics')).toBe('news and politics');
  });
});

describe('enclosure audio (replayed redirect chain)', () => {
  const hops = JSON.parse(text('pnwr-trailer-hops.json')) as { url: string; status: number; headers: Record<string, string> }[];
  const TRAILER = `${PNWR_FEED}#item=616dcd50-8387-46a2-a149-bdee833c4a47`;
  const hopRoutes = (body: Uint8Array): Route[] =>
    hops.map((h, i) => ({
      url: h.url,
      response: { status: h.status, headers: h.headers, body: i === hops.length - 1 ? body : '' },
    }));

  it('follows tracking redirects hop by hop and returns bytes with an audio file name', async () => {
    const mp3 = bytes('pnwr-trailer.mp3');
    const { ctx, fetch } = ctxWith([routes.pnwr as Route, ...hopRoutes(mp3)]);
    expect(podcastSource.canProvideAudio?.(ref(TRAILER), ctx)).toBe(true);
    const audio = await podcastSource.getAudio?.(ref(TRAILER), ctx);
    expect(audio).toMatchObject({
      kind: 'bytes',
      mimeType: 'audio/mpeg',
      filename: '6749611-the-podnews-weekly-review-the-last-word-in-podcast-news.mp3',
    });
    expect(audio?.kind === 'bytes' ? audio.data.byteLength : 0).toBe(916092);
    expect(fetch.calls.slice(1).map((c) => c.url)).toEqual(hops.map((h) => h.url));
    expect(fetch.calls[1]?.headers['user-agent']).toMatch(/^vid2context\//);
  });

  it('enforces VID2CONTEXT_MAX_MEDIA_MB from the enclosure length, content-length and the stream', async () => {
    const mp3 = bytes('pnwr-trailer.mp3');
    // The feed declares 114 MB: refused before any download.
    const big = ctxWith([routes.pnwr as Route], { VID2CONTEXT_MAX_MEDIA_MB: '100' });
    const e1 = await rejection(
      podcastSource.getAudio?.(ref(`${PNWR_FEED}#item=Buzzsprout-20117890`), big.ctx) as Promise<unknown>,
    );
    expect(e1.code).toBe('too-large');
    expect(e1.hint).toMatch(/VID2CONTEXT_MAX_MEDIA_MB/);
    expect(big.fetch.calls).toHaveLength(1);
    // The trailer is 0.87 MB: refused at the final hop's content-length.
    const small = ctxWith([routes.pnwr as Route, ...hopRoutes(mp3)], { VID2CONTEXT_MAX_MEDIA_MB: '0.5' });
    const e2 = await rejection(podcastSource.getAudio?.(ref(TRAILER), small.ctx) as Promise<unknown>);
    expect(e2.code).toBe('too-large');
    // Without a content-length the cap applies while streaming.
    const noLen = hopRoutes(mp3).map((r, i, all) =>
      i === all.length - 1 && typeof r.response === 'object'
        ? { ...r, response: { ...r.response, headers: { 'content-type': 'audio/mpeg' } } }
        : r,
    );
    const stream = ctxWith([routes.pnwr as Route, ...noLen], { VID2CONTEXT_MAX_MEDIA_MB: '0.5' });
    const e3 = await rejection(podcastSource.getAudio?.(ref(TRAILER), stream.ctx) as Promise<unknown>);
    expect(e3.code).toBe('too-large');
  });

  it('stops when the signal aborts', async () => {
    const ac = new AbortController();
    ac.abort();
    const fetch = replayFetch([routes.pnwr as Route]);
    const ctx = testContext({ fetch, signal: ac.signal });
    await expect(podcastSource.getAudio?.(ref(TRAILER), ctx)).rejects.toThrow();
  });

  it('names files with a real audio extension even when the URL has none', () => {
    expect(audioFilename(['https://audio.buzzsprout.com/9ogawcx1pih931bknlkr31ik77k4?x=1'], 'audio/mpeg')).toBe(
      '9ogawcx1pih931bknlkr31ik77k4.mp3',
    );
    expect(audioFilename(['https://op3.dev/e/a/b.m4a'], 'audio/mp4')).toBe('b.m4a');
  });

  it('lists an Atom feed given in the explicit podcast: form', async () => {
    const huffFeed = 'https://huffduffer.com/adactio/atom';
    const { ctx } = ctxWith([
      {
        url: huffFeed,
        response: { headers: { 'content-type': 'application/atom+xml' }, body: text('huffduffer-adactio-atom.xml') },
      },
    ]);
    const items = await list(ref(`podcast:${huffFeed}`), ctx);
    expect(items).toHaveLength(4);
    expect(items[0]?.url).toBe(`podcast:${huffFeed}#item=urn%3Auuid%3A4af84d7c-8211-abb2-3281-13e58bebb3f9`);
  });
});

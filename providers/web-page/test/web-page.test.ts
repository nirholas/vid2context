import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expandInput, getVideoContext, Registry, Vid2ContextError } from '@vid2context/core';
import { type Route, replayFetch, testContext } from '@vid2context/core/testing';
import nativeProviders from '@vid2context/provider-native-transcripts';
import youtubeProviders from '@vid2context/provider-youtube';
import { describe, expect, it } from 'vitest';
import { discoverInHtml, isoDurationSec } from '../src/discover.ts';
import { fetchPage, isPrivateHost, MAX_HTML_BYTES } from '../src/fetch-page.ts';
import webPageProviders, {
  classifyVideoUrl,
  createWebPageSource,
  discoverVideos,
  matchPage,
  paragraphs,
  registryResolve,
  untimedSegments,
  webPageSource,
  webPageTranscript,
} from '../src/index.ts';

// Every page and response is a real recording; see test/fixtures/README.md.
const fixture = (name: string) => readFileSync(join(import.meta.dirname, 'fixtures', name), 'utf8');
const responses = JSON.parse(fixture('responses.json')) as {
  redirects: Record<string, { status: number; location: string; body: string }>;
  pages: Record<string, { status: number; 'content-type': string }>;
  nonHtml: { url: string; status: number; 'content-type': string; body: string };
};

const OPENCULTURE = 'https://www.openculture.com/2012/07/ts_eliot_reads_his_modernist_masterpieces.html';
const TED = 'https://www.ted.com/talks/sir_ken_robinson_do_schools_kill_creativity';
const W3 = 'https://www.w3schools.com/html/html5_video.asp';
const WISTIA = 'https://wistia.com/';
const YOUTUBE = 'https://www.youtube.com/watch?v=jNQXAC9IVRw';
const FILES: Record<string, string> = {
  [OPENCULTURE]: 'openculture-ts-eliot.html',
  [TED]: 'ted-do-schools-kill-creativity.html',
  [W3]: 'w3schools-html5-video.html',
  [WISTIA]: 'wistia-home.html',
  [YOUTUBE]: 'youtube-watch-jNQXAC9IVRw.html',
};

function pageRoutes(): Route[] {
  const routes: Route[] = Object.entries(FILES).map(([url, file]) => ({
    url,
    response: { status: 200, headers: { 'content-type': responses.pages[url]?.['content-type'] ?? '' }, body: fixture(file) },
  }));
  for (const [url, r] of Object.entries(responses.redirects)) {
    routes.push({ url, response: { status: r.status, headers: { location: r.location }, body: r.body } });
  }
  routes.push({
    url: responses.nonHtml.url,
    response: {
      status: responses.nonHtml.status,
      headers: { 'content-type': responses.nonHtml['content-type'] },
      body: responses.nonHtml.body,
    },
  });
  routes.push({
    url: 'https://www.openculture.com/this-page-does-not-exist-vid2context-test',
    response: { status: 404, headers: { 'content-type': 'text/html; charset=UTF-8' }, body: fixture('openculture-404.html') },
  });
  return routes;
}

const discover = (url: string) => discoverInHtml(fixture(FILES[url] ?? ''), new URL(url)).videos;

async function codeOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (err) {
    if (err instanceof Vid2ContextError) return err.code;
    throw err;
  }
  return 'resolved';
}

function ref(input: string) {
  const r = matchPage(input);
  if (!r) throw new Error(`no match for ${input}`);
  return r;
}

const registry = () => new Registry([...webPageProviders, ...nativeProviders, ...youtubeProviders], 'node');

describe('matchPage', () => {
  it('accepts only the explicit page: form', () => {
    expect(matchPage(`page:${OPENCULTURE}`)).toEqual({
      input: `page:${OPENCULTURE}`,
      platform: 'web',
      kind: 'page',
      id: `web:page:${OPENCULTURE}`,
      nativeId: OPENCULTURE,
      url: OPENCULTURE,
    });
    expect(matchPage(`page:${OPENCULTURE}#comments`)?.nativeId).toBe(OPENCULTURE);
    expect(matchPage(OPENCULTURE)).toBeNull();
    expect(matchPage('page:ftp://example.com/x')).toBeNull();
    expect(matchPage('page:')).toBeNull();
    expect(matchPage('page:not a url')).toBeNull();
  });

  it('accepts page-video refs produced by listItems', () => {
    expect(matchPage(`page-video:0:${TED}`)).toMatchObject({
      platform: 'web',
      kind: 'video',
      id: `web:page-video:0:${TED}`,
      url: TED,
    });
  });

  it('never claims plain URLs in a registry, so catch-alls keep them', () => {
    const r = registry();
    expect(r.resolve(`page:${OPENCULTURE}`).source.id).toBe('web-page');
    expect(r.resolve('https://vimeo.com/7602340').source.id).toBe('vimeo');
    expect(() => r.resolve(OPENCULTURE)).toThrow(/No source understands/);
  });
});

describe('discoverInHtml on real pages', () => {
  it('finds a protocol-relative YouTube iframe, a Vimeo iframe and a video link, ignoring the article oEmbed link', () => {
    expect(discover(OPENCULTURE)).toEqual([
      { input: 'https://www.youtube.com/watch?v=CqvhMeZ2PlY', platform: 'youtube', source: 'iframe' },
      { input: 'https://vimeo.com/7602340', platform: 'vimeo', source: 'iframe' },
      { input: 'https://www.youtube.com/watch?v=PLNsPhKlucY', platform: 'youtube', source: 'link', title: 'here' },
    ]);
  });

  it('merges og:video and a JSON-LD VideoObject with its transcript into one entry', () => {
    const videos = discover(TED);
    expect(videos).toHaveLength(1);
    expect(videos[0]).toMatchObject({
      input: 'https://www.ted.com/talks/sir_ken_robinson_do_schools_kill_creativity',
      platform: 'ted',
      source: 'og',
      title: 'Do schools kill creativity?',
      durationSec: 1151,
      uploadDate: '2006-06-27T00:11:00Z',
      language: 'en',
      author: 'Sir Ken Robinson',
      ldIndex: 0,
      hasTranscript: true,
    });
    expect(videos[0]?.thumbnailUrl).not.toContain('&amp;');
    expect(videos[0]?.transcript?.startsWith("Good morning. How are you? (Audience) Good. It's been great")).toBe(true);
  });

  it('resolves relative <video> sources, de-duplicates repeats and ignores <source> inside <picture>', () => {
    expect(discover(W3)).toEqual([
      { input: 'https://www.w3schools.com/html/mov_bbb.mp4', platform: 'media', source: 'video-tag' },
      { input: 'https://www.w3schools.com/html/mov_bbb.ogg', platform: 'media', source: 'video-tag' },
    ]);
  });

  it('finds og:video files and <wistia-player> elements in page order', () => {
    expect(discover(WISTIA).map((v) => [v.source, v.platform, v.input])).toEqual([
      ['og', 'media', 'https://embed-ssl.wistia.com/deliveries/d6dabb7632fefe63d4599f8ea7d69eb6e846c113.mp4'],
      ['iframe', 'wistia', 'https://fast.wistia.net/embed/iframe/i5voqxuarc'],
      ['iframe', 'wistia', 'https://fast.wistia.net/embed/iframe/t4iedqjz0j'],
      ['iframe', 'wistia', 'https://fast.wistia.net/embed/iframe/7sc5jnc9e0'],
    ]);
  });

  it('reports a video page once although oEmbed, og:video and JSON-LD all describe it', () => {
    const videos = discover(YOUTUBE);
    expect(videos).toHaveLength(1);
    expect(videos[0]).toMatchObject({
      input: 'https://www.youtube.com/watch?v=jNQXAC9IVRw',
      platform: 'youtube',
      source: 'oembed',
      title: 'Me at the zoo',
    });
    expect(videos[0]?.uploadDate).toBe('2005-04-23T20:31:52-07:00');
  });

  it('reads page title, description, image and language', () => {
    const info = discoverInHtml(fixture(FILES[OPENCULTURE] ?? ''), new URL(OPENCULTURE));
    expect(info.title).toMatch(/^T\.S\. Eliot Reads His Modernist Masterpieces/);
    expect(info.language).toBe('en-US');
    expect(info.image).toBe('https://cdn8.openculture.com/wp-content/uploads/2012/07/23194035/eliot-reads.png');
  });
});

describe('classifyVideoUrl', () => {
  it.each([
    ['https://www.youtube-nocookie.com/embed/jNQXAC9IVRw?rel=0', 'youtube', 'https://www.youtube.com/watch?v=jNQXAC9IVRw'],
    ['https://player.vimeo.com/video/336812660?h=abc123def4', 'vimeo', 'https://vimeo.com/336812660/abc123def4'],
    [
      'https://www.loom.com/embed/09b1aa507cb846138847bf8e98b56a71',
      'loom',
      'https://www.loom.com/share/09b1aa507cb846138847bf8e98b56a71',
    ],
    [
      'https://fast.wistia.net/embed/iframe/26sk4lmiix?videoFoam=true',
      'wistia',
      'https://fast.wistia.net/embed/iframe/26sk4lmiix',
    ],
    ['https://home.wistia.com/medias/26sk4lmiix', 'wistia', 'https://fast.wistia.net/embed/iframe/26sk4lmiix'],
    ['https://www.dailymotion.com/embed/video/x8abc12', 'dailymotion', 'https://www.dailymotion.com/video/x8abc12'],
    ['https://geo.dailymotion.com/player.html?video=x8abc12', 'dailymotion', 'https://www.dailymotion.com/video/x8abc12'],
    ['https://dai.ly/x8abc12', 'dailymotion', 'https://www.dailymotion.com/video/x8abc12'],
    ['https://player.twitch.tv/?video=v2245012345&parent=example.com', 'twitch', 'https://www.twitch.tv/videos/2245012345'],
    ['https://player.twitch.tv/?channel=SomeChannel&parent=example.com', 'twitch', 'https://www.twitch.tv/somechannel'],
    [
      'https://clips.twitch.tv/embed?clip=BraveTallCookie-abc&parent=example.com',
      'twitch',
      'https://clips.twitch.tv/BraveTallCookie-abc',
    ],
    ['https://rumble.com/embed/v5abc12/?pub=4', 'rumble', 'https://rumble.com/embed/v5abc12/'],
    ['https://embed.ted.com/talks/sir_ken_robinson_do_schools_kill_creativity', 'ted', TED],
  ])('%s', (url, platform, input) => {
    expect(classifyVideoUrl(new URL(url))).toEqual({ platform, input });
  });

  it.each([
    'https://www.youtube.com/embed/videoseries?list=PLHeawKfarQSPKIjpe86at3Ttc2sz7uD_b',
    'https://www.youtube.com/@w3schools',
    'https://www.googletagmanager.com/ns.html?id=GTM-KTCFC3S',
    'https://vimeo.com/staff',
  ])('ignores %s', (url) => {
    expect(classifyVideoUrl(new URL(url))).toBeNull();
  });
});

describe('safe fetching', () => {
  it.each([
    ['127.0.0.1', true],
    ['127.1.2.3', true],
    ['10.0.0.8', true],
    ['172.16.4.1', true],
    ['192.168.1.20', true],
    ['169.254.169.254', true],
    ['100.64.0.1', true],
    ['0.0.0.0', true],
    ['224.0.0.1', true],
    ['localhost', true],
    ['api.localhost', true],
    ['printer.local', true],
    ['service.internal', true],
    ['intranet', true],
    ['[::1]', true],
    ['[::]', true],
    ['[fd12:3456::1]', true],
    ['[fe80::1]', true],
    ['[::ffff:7f00:1]', true],
    ['[64:ff9b::a00:1]', true],
    ['www.openculture.com', false],
    ['8.8.8.8', false],
    ['172.32.0.1', false],
    ['[2606:4700:4700::1111]', false],
    ['[::ffff:808:808]', false],
  ])('isPrivateHost(%s) is %s', (host, expected) => {
    expect(isPrivateHost(host)).toBe(expected);
  });

  it.each([
    'http://127.0.0.1/admin',
    'http://localhost:8787/',
    'http://[::1]/',
    'http://2130706433/',
    'http://169.254.169.254/latest/meta-data/',
    'file:///etc/passwd',
    'https://user:secret@www.openculture.com/',
  ])('refuses %s without making a request', async (url) => {
    const fetch = replayFetch(pageRoutes());
    expect(await codeOf(discoverVideos(url, testContext({ fetch })))).toBe('bad-request');
    expect(fetch.calls).toHaveLength(0);
  });

  it('follows absolute and relative redirects', async () => {
    const fetch = replayFetch(pageRoutes());
    const ctx = testContext({ fetch });
    const a = await fetchPage('http://www.openculture.com/2012/07/ts_eliot_reads_his_modernist_masterpieces.html', ctx);
    expect(a.url.href).toBe(OPENCULTURE);
    const b = await fetchPage('https://www.ted.com/talks/ken_robinson_do_schools_kill_creativity', ctx);
    expect(b.url.href).toBe(TED);
    expect(fetch.calls.every((c) => c.method === 'GET')).toBe(true);
  });

  it('gives up after too many redirects', async () => {
    // Serve the recorded http->https redirect for both URLs, so the chain never ends.
    const r = responses.redirects['http://www.openculture.com/2012/07/ts_eliot_reads_his_modernist_masterpieces.html'];
    const loop = {
      status: r?.status ?? 301,
      headers: { location: 'http://www.openculture.com/2012/07/ts_eliot_reads_his_modernist_masterpieces.html' },
      body: '',
    };
    const fetch = replayFetch([{ url: /openculture\.com/, response: loop }]);
    expect(await codeOf(fetchPage(OPENCULTURE, testContext({ fetch })))).toBe('upstream');
    expect(fetch.calls).toHaveLength(6);
  });

  it('cuts a page at the byte cap', async () => {
    expect(MAX_HTML_BYTES).toBe(2 * 1024 * 1024);
    const page = await fetchPage(OPENCULTURE, testContext({ fetch: replayFetch(pageRoutes()) }), { maxBytes: 10_000 });
    expect(page.truncated).toBe(true);
    expect(new TextEncoder().encode(page.html).byteLength).toBeLessThanOrEqual(10_000);
    const full = await fetchPage(OPENCULTURE, testContext({ fetch: replayFetch(pageRoutes()) }));
    expect(full.truncated).toBe(false);
  });

  it('refuses non-HTML responses and maps a 404 page to not-found', async () => {
    const ctx = testContext({ fetch: replayFetch(pageRoutes()) });
    expect(await codeOf(fetchPage(responses.nonHtml.url, ctx))).toBe('unsupported-input');
    expect(await codeOf(fetchPage('https://www.openculture.com/this-page-does-not-exist-vid2context-test', ctx))).toBe(
      'not-found',
    );
  });
});

describe('listItems and the pipeline', () => {
  it('expands page: into refs of the sources that own each video', async () => {
    const ctx = testContext({ fetch: replayFetch(pageRoutes()) });
    const refs = await expandInput(registry(), `page:${OPENCULTURE}`, ctx);
    expect(refs.map((r) => r.id)).toEqual(['youtube:CqvhMeZ2PlY', 'vimeo:7602340', 'youtube:PLNsPhKlucY']);
    expect(await expandInput(registry(), `page:${OPENCULTURE}`, ctx, { limit: 1 })).toHaveLength(1);
  });

  it('skips videos no source understands', async () => {
    const ctx = testContext({ fetch: replayFetch(pageRoutes()) });
    const refs = await expandInput(registry(), `page:${WISTIA}`, ctx);
    expect(refs.map((r) => r.id)).toEqual(['wistia:i5voqxuarc', 'wistia:t4iedqjz0j', 'wistia:7sc5jnc9e0']);
  });

  it('turns a JSON-LD transcript into a page-video ref with an untimed native transcript', async () => {
    const r = registry();
    const ctx = testContext({ fetch: replayFetch(pageRoutes()) });
    const refs = await expandInput(r, `page:${TED}`, ctx);
    expect(refs.map((x) => x.input)).toEqual([`page-video:0:${TED}`]);
    const result = await getVideoContext(r, refs[0]?.input ?? '', { mode: 'captions' }, ctx);
    expect(result.metadata).toMatchObject({
      title: 'Do schools kill creativity?',
      durationSec: 1151,
      channel: { name: 'Sir Ken Robinson' },
      language: 'en',
    });
    expect(result.transcript).toMatchObject({
      origin: 'native-transcript',
      producer: 'web-page-transcript/untimed',
      language: 'en',
    });
    // TED publishes the transcript as one paragraph; it stays one segment, spanning the whole talk.
    expect(result.transcript.segments).toHaveLength(1);
    expect(result.transcript.segments[0]).toMatchObject({ startSec: 0, endSec: 1151 });
    expect(await webPageTranscript.getCaptions(refs[0] ?? ref(`page-video:0:${TED}`), { language: 'fr' }, ctx)).toBeNull();
  });

  it('prefers the page transcript over a catch-all, and resolves through a full registry when given one', async () => {
    const r = registry();
    const source = createWebPageSource({ resolve: registryResolve(r) });
    const ctx = testContext({ fetch: replayFetch(pageRoutes()) });
    const ref = matchPage(`page:${OPENCULTURE}`);
    if (!ref || !source.listItems) throw new Error('setup');
    const ids: string[] = [];
    for await (const item of source.listItems(ref, ctx)) ids.push(item.id);
    expect(ids).toEqual(['youtube:CqvhMeZ2PlY', 'vimeo:7602340', 'youtube:PLNsPhKlucY']);
    const withCatchAll = createWebPageSource({
      resolve: (input) => ({
        ref: { input, platform: 'ted', kind: 'video', id: `ted:${input}`, nativeId: input, url: input },
        catchAll: true,
      }),
    });
    const tedRef = matchPage(`page:${TED}`);
    if (!tedRef || !withCatchAll.listItems) throw new Error('setup');
    const ted: string[] = [];
    for await (const item of withCatchAll.listItems(tedRef, ctx)) ted.push(item.input);
    expect(ted).toEqual([`page-video:0:${TED}`]);
  });

  it('describes a page in its metadata, including what discovery found', async () => {
    const ctx = testContext({ fetch: replayFetch(pageRoutes()) });
    const meta = await webPageSource.getMetadata(ref(`page:${OPENCULTURE}`), ctx);
    expect(meta.title).toMatch(/^T\.S\. Eliot/);
    expect((meta.extra?.videos as unknown[]).length).toBe(3);
  });

  it('fetches a page once per context across metadata, listing and transcript', async () => {
    const fetch = replayFetch(pageRoutes());
    const ctx = testContext({ fetch });
    const r = registry();
    const refs = await expandInput(r, `page:${TED}`, ctx);
    await getVideoContext(r, refs[0]?.input ?? '', { mode: 'captions' }, ctx);
    expect(fetch.calls.filter((c) => c.url === TED)).toHaveLength(1);
  });

  it('only supports page-video refs for transcripts', () => {
    expect(webPageTranscript.supports(ref(`page-video:0:${TED}`))).toBe(true);
    expect(webPageTranscript.supports(ref(`page:${TED}`))).toBe(false);
  });
});

describe('helpers', () => {
  it('parses ISO 8601 durations', () => {
    expect(isoDurationSec('PT19M11S')).toBe(1151);
    expect(isoDurationSec('P0DT1H0M2.5S')).toBe(3602.5);
    expect(isoDurationSec('PT')).toBeUndefined();
    expect(isoDurationSec('19:11')).toBeUndefined();
    expect(isoDurationSec(undefined)).toBeUndefined();
  });

  it('splits paragraphs without inventing timings', () => {
    expect(paragraphs('First part.\n\nSecond  part.\r\n\r\nThird.')).toEqual(['First part.', 'Second part.', 'Third.']);
    expect(paragraphs('Line one\nLine two')).toEqual(['Line one', 'Line two']);
    expect(untimedSegments('A\n\nB', 90)).toEqual([
      { startSec: 0, endSec: 90, text: 'A' },
      { startSec: 0, endSec: 90, text: 'B' },
    ]);
    expect(untimedSegments('A')).toEqual([{ startSec: 0, endSec: 0, text: 'A' }]);
  });

  it('declares only node and workers runtimes', () => {
    expect(new Set(webPageProviders.flatMap((p) => p.runtimes))).toEqual(new Set(['node', 'workers']));
  });
});

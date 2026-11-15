import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createContext, type Logger, type VideoContext, type VideoRef } from '@vid2context/core';
import { type RecordedCall, replayFetch, testContext } from '@vid2context/core/testing';
import { describe, expect, it } from 'vitest';
import {
  cleanTitle,
  detectShort,
  extractLinks,
  getYouTubeMetadata,
  largestThumbnail,
  parseChapterLine,
  parseDateText,
  parseDescriptionChapters,
  parseMicroformat,
  parseWatch,
  pickChapters,
  toMetadata,
} from '../src/metadata/index.ts';
import type { PlayerResponse } from '../src/resilience/player.ts';
import { matchYouTube } from '../src/url.ts';

// Real recordings, see test/fixtures/README.md, "Metadata and chapters".
const dir = join(import.meta.dirname, 'fixtures', 'metadata');
const read = (name: string) => readFileSync(join(dir, name), 'utf8');

const VIDEOS = {
  chapters: '2VDV87iHfKw',
  precedence: 'Rq5gJVxz55Q',
  'past-live': '9JTLxLyF59M',
  short: '0U0O-P43MNQ',
  live: 'rFZHOHl-L8A',
  upcoming: 'zWHMFJII-sA',
  age: 'HtVdAasjOgU',
  members: '2a1cufNNiyQ',
  zoo: 'jNQXAC9IVRw',
} as const;
type Label = keyof typeof VIDEOS;
const labelOf = (id: string) => (Object.entries(VIDEOS).find(([, v]) => v === id)?.[0] ?? '') as Label;

const player = (label: Label) => JSON.parse(read(`player-${label}-${VIDEOS[label]}.json`)) as PlayerResponse;
const next = (label: Label) => JSON.parse(read(`next-${label}-${VIDEOS[label]}.json`)) as unknown;
const webPlayer = (label: Label) => JSON.parse(read(`microformat-${label}-${VIDEOS[label]}.json`)) as unknown;
const maxresStatus = JSON.parse(read('maxres-status.json')) as Record<string, number>;

const ref = (input: string): VideoRef => {
  const r = matchYouTube(input);
  if (!r) throw new Error(`no match for ${input}`);
  return r;
};

const PLAYER_URL = 'https://www.youtube.com/youtubei/v1/player?prettyPrint=false';
const NEXT_URL = 'https://www.youtube.com/youtubei/v1/next?prettyPrint=false';
type Body = { videoId: string; context: { client: { clientName: string } } };
const bodyOf = (call: RecordedCall) => JSON.parse(String(call.body)) as Body;
const videoIdOf = (call: RecordedCall) => bodyOf(call).videoId;
const json = (body: string) => ({ body, headers: { 'content-type': 'application/json' } });

/**
 * Replays the recorded player (ANDROID), WEB player (microformat), next and
 * maxres HEAD responses. `withNext: false` leaves next unrecorded, so it fails.
 */
function metadataReplay(opts: { withNext?: boolean } = {}) {
  return replayFetch([
    {
      method: 'POST',
      url: PLAYER_URL,
      response: (call) => {
        const id = videoIdOf(call);
        const web = bodyOf(call).context.client.clientName === 'WEB';
        return json(read(`${web ? 'microformat' : 'player'}-${labelOf(id)}-${id}.json`));
      },
    },
    ...(opts.withNext === false
      ? []
      : [
          {
            method: 'POST',
            url: NEXT_URL,
            response: (call: RecordedCall) => json(read(`next-${labelOf(videoIdOf(call))}-${videoIdOf(call)}.json`)),
          },
        ]),
    {
      method: 'HEAD',
      url: /^https:\/\/i\.ytimg\.com\/vi\/[\w-]{11}\/maxresdefault\.jpg$/,
      response: (call) => ({ status: maxresStatus[call.url.split('/')[4] ?? ''] ?? 404, body: '' }),
    },
  ]);
}

/** Metadata through the recorded responses, with the opt-in microformat request on unless `withMicroformat: false`. */
async function metadataFor(label: Label, input: string = VIDEOS[label], opts: { withMicroformat?: boolean } = {}) {
  const fetch = metadataReplay();
  const env = opts.withMicroformat === false ? {} : { YOUTUBE_METADATA_MICROFORMAT: '1' };
  const meta = await getYouTubeMetadata(ref(input), testContext({ fetch, env }));
  return { meta, calls: fetch.calls };
}

describe('description chapters', () => {
  it('parses the 3 creator chapters of "Me at the zoo" (shared context fixture) with endSec', () => {
    const ctx = JSON.parse(
      readFileSync(new URL('../../../tests/fixtures/contexts/youtube-jNQXAC9IVRw.json', import.meta.url), 'utf8'),
    ) as VideoContext;
    expect(parseDescriptionChapters(ctx.metadata.description, ctx.metadata.durationSec)).toEqual([
      { title: 'Intro', startSec: 0, endSec: 5 },
      { title: 'The cool thing', startSec: 5, endSec: 17 },
      { title: 'End', startSec: 17, endSec: 19 },
    ]);
  });

  it('parses h:mm:ss lists and closes the last chapter at the duration', () => {
    const d = player('precedence').videoDetails;
    const chapters = parseDescriptionChapters(d?.shortDescription, Number(d?.lengthSeconds));
    expect(chapters).toHaveLength(37);
    expect(chapters[0]).toEqual({ title: 'Python Course Introduction', startSec: 0, endSec: 127 });
    expect(chapters.at(-1)).toEqual({ title: 'Writing Clean Functions', startSec: 45969, endSec: 46973 });
    expect(chapters.every((c) => c.endSec !== undefined && c.endSec > c.startSec)).toBe(true);
  });

  // descriptions.json: 74 real descriptions that contain timestamps, each with
  // the chapters YouTube itself derived from it (DESCRIPTION_CHAPTERS markers).
  const samples = JSON.parse(read('descriptions.json')) as {
    id: string;
    description: string;
    youtubeChapters: [string, number][] | null;
  }[];
  // The creator wrote a valid list but YouTube rendered no description chapters
  // for these (some get auto chapters instead). Creator chapters win here.
  const YOUTUBE_SHOWS_NONE = ['Rq5gJVxz55Q', 'KZtvWKpXPro', 'nU2a2lm6vDE', 'HNnenTYO2zM', 'Y2xCyequ3u4', '-7O8pI-1Bq0'];
  // "0:00 - 0:30: Brief overview": YouTube keeps "0:30: " in the title, this parser reads it as a time range.
  const RANGES = '3LKZMo3JRF4';

  it('agrees with YouTube on every other recorded description, including strays that must not become chapters', () => {
    const checked = samples.filter((s) => !YOUTUBE_SHOWS_NONE.includes(s.id) && s.id !== RANGES);
    expect(checked.length).toBeGreaterThan(60);
    for (const s of checked) {
      const ours = parseDescriptionChapters(s.description).map((c) => [c.title, c.startSec]);
      expect([s.id, ours]).toEqual([s.id, s.youtubeChapters ?? []]);
    }
    // Some of the checked ones have timestamps but no valid list (stray or not from 0:00).
    expect(checked.filter((s) => s.youtubeChapters === null).length).toBeGreaterThanOrEqual(5);
  });

  it('keeps valid creator lists YouTube did not render, and reads time ranges', () => {
    for (const id of YOUTUBE_SHOWS_NONE) {
      const s = samples.find((x) => x.id === id);
      expect(s?.youtubeChapters).toBeNull();
      expect(parseDescriptionChapters(s?.description).length).toBeGreaterThanOrEqual(4);
    }
    const ranged = samples.find((x) => x.id === RANGES);
    const ours = parseDescriptionChapters(ranged?.description);
    expect(ours.slice(0, 4).map((c) => [`${c.title}`, c.startSec])).toEqual(
      (ranged?.youtubeChapters ?? []).map(([t, s]) => [t.replace(/^\d+:\d\d: /, ''), s]),
    );
  });

  it('reads one line the way YouTube does', () => {
    // Lines quoted from the recorded descriptions.
    expect(parseChapterLine('00:00:00 Introduction')).toEqual({ title: 'Introduction', startSec: 0 });
    expect(parseChapterLine("00:06 \u2013 Jet Tila's Spicy Miso Ramen")).toEqual({
      title: "Jet Tila's Spicy Miso Ramen",
      startSec: 6,
    });
    expect(parseChapterLine('Fly Like Love by Intr0beatz 5:20')).toEqual({ title: 'Fly Like Love by Intr0beatz', startSec: 320 });
    expect(parseChapterLine(' 2. Rolling In The Deep \u2014 Adele 03:30')).toEqual({
      title: '2. Rolling In The Deep \u2014 Adele',
      startSec: 210,
    });
    expect(parseChapterLine('0:31 - 1:20: Timestamps on Spotify')).toEqual({ title: 'Timestamps on Spotify', startSec: 31 });
    // Timestamps inside a sentence are not chapters.
    expect(
      parseChapterLine('South Park: The Stick of Truth Any% Current Patch (Mage) Speedrun in 1:23:45 by someone'),
    ).toBeNull();
    expect(parseChapterLine('The joke lands around 3:45')).toBeNull();
    expect(parseChapterLine('Skip to 12:30')).toBeNull();
  });

  it('cleans titles like YouTube: edge emoji, doubled spaces, wrapping quotes', () => {
    expect(cleanTitle('✅ Recipe #2  Easy, Juicy and So Delicious Mashed Potato Nests with Ground Beef Recipe \u{1F60B}')).toBe(
      'Recipe #2 Easy, Juicy and So Delicious Mashed Potato Nests with Ground Beef Recipe',
    );
    expect(cleanTitle(`"If it's this easy, why would anyone need you?"`)).toBe("If it's this easy, why would anyone need you?");
  });
});

describe('watch page (next) parsing', () => {
  it('reads date, likes, channel handle, subscribers and both marker lists', () => {
    const w = parseWatch(next('zoo'));
    expect(w).toMatchObject({
      dateText: 'Apr 23, 2005',
      publishedAt: '2005-04-23',
      likeCount: 20138329,
      channelName: 'jawed',
      channelId: 'UC4QobU6STFB0P71PMvOGN5A',
      channelHandle: '@jawed',
      subscriberCountText: '6.74M subscribers',
      membersOnly: false,
      descriptionMarkers: [
        { title: 'Intro', startSec: 0 },
        { title: 'The cool thing', startSec: 5 },
        { title: 'End', startSec: 17 },
      ],
      autoChapters: [],
    });
    const precedence = parseWatch(next('precedence'));
    expect(precedence.descriptionMarkers).toEqual([]);
    expect(precedence.autoChapters[0]).toEqual({ title: 'Course introduction', startSec: 0 });
  });

  it('parses the date line forms YouTube uses', () => {
    expect(parseDateText('Apr 23, 2005')).toBe('2005-04-23');
    expect(parseDateText('Premiered Feb 24, 2026')).toBe('2026-02-24');
    expect(parseDateText('Streamed live on Apr 1, 2026')).toBe('2026-04-01');
    expect(parseDateText('Started streaming on Aug 19, 2026')).toBe('2026-08-19');
    expect(parseDateText('Scheduled for Nov 15, 2026')).toBeUndefined();
    expect(parseDateText('Streamed live 23 hours ago')).toBeUndefined();
  });
});

describe('youtube metadata', () => {
  it('fills every field for a video with creator chapters, in one player, one next and one WEB player request', async () => {
    const { meta, calls } = await metadataFor('chapters');
    // next and the WEB player run in parallel, so their order varies.
    expect(calls.map((c) => `${c.method} ${c.url.split('?')[0]} ${bodyOf(c).context.client.clientName}`).sort()).toEqual([
      'POST https://www.youtube.com/youtubei/v1/next WEB',
      'POST https://www.youtube.com/youtubei/v1/player ANDROID',
      'POST https://www.youtube.com/youtubei/v1/player WEB',
    ]);
    expect(meta).toMatchObject({
      title: "David Spade Talks SNL, Chris Farley & Norm Macdonald (FULL EPISODE) | Conan O'Brien Needs A Friend",
      durationSec: 3758,
      publishedAt: '2025-06-16T04:00:04-07:00',
      thumbnailUrl: 'https://i.ytimg.com/vi/2VDV87iHfKw/maxresdefault.jpg',
      language: 'en',
      isLive: false,
      channel: {
        name: 'Team Coco',
        id: 'UCi7GJNg51C3jgmYTUwqoUXA',
        url: 'https://www.youtube.com/channel/UCi7GJNg51C3jgmYTUwqoUXA',
      },
      extra: {
        likeCount: 16105,
        dateText: 'Jun 16, 2025',
        uploadDate: '2025-06-16T04:00:04-07:00',
        category: 'Comedy',
        isUnlisted: false,
        channelHandle: '@TeamCoco',
        channelHandleUrl: 'https://www.youtube.com/@TeamCoco',
        subscriberCountText: '9.22M subscribers',
        isShort: false,
        isLive: false,
        isUpcoming: false,
        ageRestricted: false,
        membersOnly: false,
        playability: 'OK',
        chapterSource: 'description',
      },
    });
    expect(meta.description).toBe(player('chapters').videoDetails?.shortDescription);
    expect(meta.tags).toEqual(player('chapters').videoDetails?.keywords);
    expect(meta.extra?.viewCount).toBe(Number(player('chapters').videoDetails?.viewCount));
    expect(meta.chapters).toHaveLength(9);
    expect(meta.chapters[1]).toEqual({ title: 'Conan’s Pomegranate Tree', startSec: 27, endSec: 630 });
    expect(meta.chapters.at(-1)).toEqual({ title: 'Mark Twain Prize', startSec: 3710, endSec: 3758 });
  });

  it('by default keeps to one player, one next and one HEAD request, with the date from the watch page', async () => {
    const { meta, calls } = await metadataFor('chapters', VIDEOS.chapters, { withMicroformat: false });
    expect(calls.map((c) => `${c.method} ${c.url.split('?')[0]}`).sort()).toEqual([
      'HEAD https://i.ytimg.com/vi/2VDV87iHfKw/maxresdefault.jpg',
      'POST https://www.youtube.com/youtubei/v1/next',
      'POST https://www.youtube.com/youtubei/v1/player',
    ]);
    expect(meta.publishedAt).toBe('2025-06-16');
    expect(meta.thumbnailUrl).toBe('https://i.ytimg.com/vi/2VDV87iHfKw/maxresdefault.jpg');
    expect(meta.extra?.category).toBeUndefined();
    expect(meta.extra?.uploadDate).toBeUndefined();
  });

  it('reads category, timestamps, Shorts and live broadcast fields from the microformat', () => {
    expect(parseMicroformat(webPlayer('zoo'))).toMatchObject({
      category: 'Film & Animation',
      publishDate: '2005-04-23T20:31:52-07:00',
      uploadDate: '2005-04-23T20:31:52-07:00',
      isShortsEligible: false,
      isUnlisted: false,
      channelHandle: '@jawed',
    });
    expect(parseMicroformat(webPlayer('short'))?.isShortsEligible).toBe(true);
    expect(parseMicroformat(webPlayer('past-live'))).toMatchObject({
      liveStartedAt: '2026-04-02T00:16:16+00:00',
      liveEndedAt: '2026-04-02T01:02:11+00:00',
      isLiveNow: false,
    });
    expect(parseMicroformat(player('zoo'))).toBeUndefined();
  });

  it('prefers creator chapters over key moments', async () => {
    const { meta } = await metadataFor('precedence');
    expect(meta.extra?.chapterSource).toBe('description');
    expect(meta.chapters[1]?.title).toBe('Python Learning Roadmap');
  });

  it('falls back to YouTube chapter markers, then to key moments', () => {
    // Without a description (a player response that lacks it), the markers decide.
    const zoo = pickChapters(undefined, 19, parseWatch(next('zoo')));
    expect(zoo).toEqual({
      source: 'markers',
      chapters: [
        { title: 'Intro', startSec: 0, endSec: 5 },
        { title: 'The cool thing', startSec: 5, endSec: 17 },
        { title: 'End', startSec: 17, endSec: 19 },
      ],
    });
    expect(pickChapters(undefined, 19, undefined)).toEqual({ chapters: [] });
  });

  it('uses key moments for a past live stream without creator chapters', async () => {
    const { meta } = await metadataFor('past-live');
    expect(meta).toMatchObject({
      publishedAt: '2026-04-01T18:10:08-07:00',
      isLive: false,
      extra: {
        chapterSource: 'key-moments',
        isLiveContent: true,
        isLive: false,
        dateText: 'Streamed live on Apr 1, 2026',
        category: 'News & Politics',
        liveStartedAt: '2026-04-02T00:16:16+00:00',
        liveEndedAt: '2026-04-02T01:02:11+00:00',
      },
    });
    expect(meta.chapters[0]).toEqual({ title: 'Artemis 2 mission update', startSec: 0, endSec: 155.68 });
    expect(meta.chapters.at(-1)).toEqual({ title: 'C-SPAN programming', startSec: 2534.56, endSec: 2770 });
  });

  it('flags a Short from the microformat, its vertical streams, or a /shorts/ URL', async () => {
    const { meta } = await metadataFor('short', 'https://www.youtube.com/watch?v=0U0O-P43MNQ');
    expect(meta.extra?.isShort).toBe(true);
    expect(meta.durationSec).toBe(33);
    const shortRef = ref('0U0O-P43MNQ');
    expect(detectShort(shortRef, player('short'), 33, parseMicroformat(webPlayer('short')))).toBe(true);
    expect(detectShort(shortRef, player('short'), 33)).toBe(true);
    expect(detectShort(ref('2VDV87iHfKw'), player('chapters'), 3758, parseMicroformat(webPlayer('chapters')))).toBe(false);
    expect(detectShort(ref('https://www.youtube.com/shorts/jNQXAC9IVRw'), player('zoo'), 19)).toBe(true);
    expect(detectShort(ref('jNQXAC9IVRw'), player('zoo'), 19)).toBe(false);
    expect(detectShort(ref('2VDV87iHfKw'), player('chapters'), 3758)).toBe(false);
  });

  it('reports a live stream with its viewers and no duration', async () => {
    const { meta } = await metadataFor('live');
    expect(meta).toMatchObject({
      isLive: true,
      durationSec: undefined,
      publishedAt: '2026-08-19T00:31:51-07:00',
      extra: {
        isLive: true,
        isUpcoming: false,
        liveViewers: 10409,
        playability: 'OK',
        isShort: false,
        liveStartedAt: '2026-08-19T07:43:43+00:00',
      },
    });
  });

  it('reports an upcoming stream with its scheduled start instead of throwing', async () => {
    const { meta } = await metadataFor('upcoming');
    expect(meta).toMatchObject({
      title: 'ULA launches Vulcan launches Amazon Leo (LV-01)',
      publishedAt: undefined,
      extra: {
        isUpcoming: true,
        premiereAt: '2026-11-15T16:11:00.000Z',
        dateText: 'Scheduled for Nov 15, 2026',
        playability: 'LIVE_STREAM_OFFLINE',
        category: 'Science & Technology',
      },
    });
    expect(meta.extra?.liveStartedAt).toBeUndefined();
  });

  it('reports age-restricted and members-only videos instead of throwing', async () => {
    const age = (await metadataFor('age')).meta;
    expect(age.extra).toMatchObject({ ageRestricted: true, membersOnly: false, playability: 'LOGIN_REQUIRED' });
    expect(age.publishedAt).toBe('2014-06-05T11:07:43-07:00');
    expect(age.extra?.category).toBe('Gaming');
    const members = (await metadataFor('members')).meta;
    expect(members.extra).toMatchObject({ membersOnly: true, ageRestricted: false, playability: 'UNPLAYABLE' });
    expect(members.channel?.name).toBe('Linus Tech Tips');
    // The watch page's members-only badge alone is enough.
    expect(parseWatch(next('members')).membersOnly).toBe(true);
  });

  it('keeps the largest listed thumbnail when maxresdefault does not exist', async () => {
    const { meta, calls } = await metadataFor('zoo');
    // The microformat lists no maxresdefault (the CDN answers 404), so no HEAD check is needed.
    expect(maxresStatus.jNQXAC9IVRw).toBe(404);
    expect(calls.map((c) => c.method)).not.toContain('HEAD');
    expect(meta.thumbnailUrl).toBe(largestThumbnail(player('zoo').videoDetails?.thumbnail?.thumbnails));
    expect(meta.thumbnailUrl).toMatch(/\/hqdefault\.jpg/);
  });

  it('returns player metadata and logs when the next request fails', async () => {
    const warnings: string[] = [];
    const quiet = () => {};
    const log: Logger = { debug: quiet, info: quiet, error: quiet, warn: (msg) => warnings.push(msg) };
    const ctx = createContext({ runtime: 'node', env: {}, fetch: metadataReplay({ withNext: false }), log });
    const meta = await getYouTubeMetadata(ref('jNQXAC9IVRw'), ctx);
    expect(meta.title).toBe('Me at the zoo');
    expect(meta.chapters).toHaveLength(3);
    expect(meta.extra?.chapterSource).toBe('description');
    expect(meta.publishedAt).toBeUndefined();
    expect(meta.extra?.likeCount).toBeUndefined();
    expect(warnings).toEqual(['youtube: next request failed; returning player metadata only']);
  });

  it('builds the same metadata from the pure toMetadata', () => {
    const meta = toMetadata(ref('jNQXAC9IVRw'), player('zoo'), { watch: parseWatch(next('zoo')) });
    expect(meta.extra?.channelHandle).toBe('@jawed');
    expect(meta.publishedAt).toBe('2005-04-23');
  });
});

describe('description links', () => {
  it('extracts URLs in order, de-duplicated, without trailing punctuation', () => {
    expect(extractLinks(player('zoo').videoDetails?.shortDescription)).toEqual([
      'https://www.youtube.com/watch?v=0PT5c1z3LL8',
      'https://www.youtube.com/watch?v=RRBN_4L09Mg',
    ]);
    const links = extractLinks(player('chapters').videoDetails?.shortDescription);
    expect(links).toHaveLength(9);
    expect(new Set(links).size).toBe(links.length);
    expect(links.every((l) => /^https?:\/\/\S+[^.,;:!?)]$/.test(l))).toBe(true);
    expect(extractLinks('Docs (see https://vid2context.dev/docs). Also https://vid2context.dev/docs.')).toEqual([
      'https://vid2context.dev/docs',
    ]);
  });
});

describe.skipIf(!process.env.LIVE)('youtube metadata (live)', () => {
  const live = () => createContext({ runtime: 'node', env: process.env });

  it('jNQXAC9IVRw', async () => {
    const meta = await getYouTubeMetadata(ref('https://www.youtube.com/watch?v=jNQXAC9IVRw'), live());
    expect(meta.title).toBe('Me at the zoo');
    expect(meta.publishedAt).toBe('2005-04-23');
    expect(meta.extra?.channelHandle).toBe('@jawed');
    expect(meta.chapters.map((c) => c.endSec)).toEqual([5, 17, 19]);
    expect(meta.extra?.chapterSource).toBe('description');
  });

  it('jNQXAC9IVRw with the opt-in microformat request', async () => {
    const ctx = createContext({ runtime: 'node', env: { ...process.env, YOUTUBE_METADATA_MICROFORMAT: '1' } });
    const meta = await getYouTubeMetadata(ref('jNQXAC9IVRw'), ctx);
    expect(meta.publishedAt).toBe('2005-04-23T20:31:52-07:00');
    expect(meta.extra?.category).toBe('Film & Animation');
    expect(meta.extra?.isShort).toBe(false);
  });

  it('a chaptered video', async () => {
    const meta = await getYouTubeMetadata(ref('https://www.youtube.com/watch?v=2VDV87iHfKw'), live());
    expect(meta.chapters.length).toBeGreaterThanOrEqual(3);
    expect(meta.chapters.every((c) => typeof c.endSec === 'number')).toBe(true);
    expect(meta.extra?.chapterSource).toBe('description');
    expect(meta.thumbnailUrl).toBe('https://i.ytimg.com/vi/2VDV87iHfKw/maxresdefault.jpg');
  });
});

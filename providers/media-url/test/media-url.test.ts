import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { type Ctx, createContext, getVideoContext } from '@vid2context/core';
import { type RecordedResponse, replayFetch, testContext } from '@vid2context/core/testing';
import { describe, expect, it } from 'vitest';
import { canonicalUrl, matchMediaUrl, maxMediaBytes, mediaUrl, sha256Hex, titleFromUrl, urlExtension } from '../src/index.ts';

const FIX = join(import.meta.dirname, 'fixtures');
interface Recorded {
  url: string;
  status: number;
  headers: Record<string, string>;
}
const rec = (name: string): Recorded => JSON.parse(readFileSync(join(FIX, name), 'utf8'));
const HEAD = rec('discovery.head.json');
const RANGE = rec('discovery.range.json');
const BIG_HEAD = rec('crew13.head.json');
const MP3 = new Uint8Array(readFileSync(join(FIX, 'discovery-nice-to-be-in-orbit.mp3')));
const URL_MP3 = HEAD.url;

const asResponse = (r: Recorded, body: string | Uint8Array = ''): RecordedResponse => ({
  status: r.status,
  headers: r.headers,
  body,
});

function ref(url: string) {
  const r = matchMediaUrl(url);
  if (!r) throw new Error(`no match for ${url}`);
  return r;
}

describe('matchMediaUrl', () => {
  it('matches http(s) URLs with media extensions, ignoring query strings and fragments', () => {
    const r = matchMediaUrl(URL_MP3);
    expect(r).toMatchObject({ platform: 'media', kind: 'video', url: URL_MP3 });
    expect(r?.id).toBe(`media:${r?.nativeId}`);
    expect(r?.nativeId).toBe(createHash('sha256').update(URL_MP3).digest('hex').slice(0, 32));
    expect(matchMediaUrl(`${URL_MP3}?download=1#t=3`)?.url).toBe(`${URL_MP3}?download=1`);
    expect(matchMediaUrl('https://cdn.example.org/talks/keynote.MP4?sig=abc')).not.toBeNull();
    expect(matchMediaUrl('http://example.org/a.opus')).not.toBeNull();
  });

  it('leaves pages, platform URLs, streams and non-http inputs alone', () => {
    expect(matchMediaUrl('https://www.youtube.com/watch?v=jNQXAC9IVRw')).toBeNull();
    expect(matchMediaUrl('https://example.org/episode.html')).toBeNull();
    expect(matchMediaUrl('https://example.org/live.m3u8')).toBeNull();
    expect(matchMediaUrl('https://example.org/page?file=a.mp3')).toBeNull();
    expect(matchMediaUrl('ftp://example.org/a.mp3')).toBeNull();
    expect(matchMediaUrl('/home/me/a.mp3')).toBeNull();
  });

  it('helpers: extension, canonical form, title', () => {
    expect(urlExtension('https://a.org/x/y.M4A?q=1.mp4')).toBe('.m4a');
    expect(canonicalUrl('HTTPS://A.ORG/x.mp3#frag')).toBe('https://a.org/x.mp3');
    expect(titleFromUrl(URL_MP3)).toBe('Discovery - Nice to be in orbit');
  });
});

describe('sha256Hex', () => {
  it('matches node:crypto for short, block-boundary and multi-byte inputs', () => {
    for (const s of ['', 'abc', 'a'.repeat(55), 'a'.repeat(56), 'a'.repeat(64), 'a'.repeat(200), URL_MP3, 'café \u{1f680}']) {
      expect(sha256Hex(s)).toBe(createHash('sha256').update(s, 'utf8').digest('hex'));
    }
  });
});

describe('mediaUrl.getMetadata', () => {
  it('reads size and type from a recorded HEAD response', async () => {
    const fetch = replayFetch([{ method: 'HEAD', url: URL_MP3, response: asResponse(HEAD) }]);
    const meta = await mediaUrl.getMetadata(ref(URL_MP3), testContext({ fetch }));
    expect(meta).toMatchObject({
      title: 'Discovery - Nice to be in orbit',
      chapters: [],
      extra: {
        url: URL_MP3,
        fileName: 'Discovery_-_Nice_to_be_in_orbit.mp3',
        sizeBytes: 135296,
        contentType: 'audio/mpeg',
        lastModified: 'Mon, 20 Apr 2020 10:56:29 GMT',
        isVideo: false,
      },
    });
    expect(fetch.calls).toHaveLength(1);
  });

  it('falls back to a ranged GET when HEAD is refused, reading the size from content-range', async () => {
    const fetch = replayFetch([
      { method: 'HEAD', url: URL_MP3, response: { status: 405, body: '' } },
      { method: 'GET', url: URL_MP3, response: asResponse(RANGE, MP3.slice(0, 1)) },
    ]);
    const meta = await mediaUrl.getMetadata(ref(URL_MP3), testContext({ fetch }));
    expect(meta.extra).toMatchObject({ sizeBytes: 135296, contentType: 'audio/mpeg' });
    expect(fetch.calls[1]?.headers.range).toBe('bytes=0-0');
  });

  it('reports a missing file as not-found so the pipeline stops', async () => {
    const fetch = replayFetch([{ method: 'HEAD', url: URL_MP3, response: { status: 404, body: '' } }]);
    await expect(mediaUrl.getMetadata(ref(URL_MP3), testContext({ fetch }))).rejects.toMatchObject({ code: 'not-found' });
  });
});

describe('mediaUrl.getAudio', () => {
  it('downloads the real mp3 bytes with a mime type and file name stt rungs accept', async () => {
    const fetch = replayFetch([{ method: 'GET', url: URL_MP3, response: asResponse(HEAD, MP3) }]);
    const audio = await mediaUrl.getAudio?.(ref(URL_MP3), testContext({ fetch }));
    expect(audio).toMatchObject({ kind: 'bytes', mimeType: 'audio/mpeg', filename: 'Discovery_-_Nice_to_be_in_orbit.mp3' });
    expect(audio?.kind === 'bytes' && audio.data).toEqual(MP3);
  });

  it('refuses a file over VID2CONTEXT_MAX_MEDIA_MB from its content-length before reading the body', async () => {
    // Real HEAD headers of a 206,115,140-byte (196.6 MB) NASA launch broadcast, served with no body:
    // the cap must trip on content-length alone.
    const fetch = replayFetch([{ method: 'GET', url: BIG_HEAD.url, response: asResponse(BIG_HEAD) }]);
    expect(maxMediaBytes({})).toBe(200 * 1024 * 1024);
    const ctx = testContext({ fetch, env: { VID2CONTEXT_MAX_MEDIA_MB: '150' } });
    const err = await mediaUrl.getAudio?.(ref(BIG_HEAD.url), ctx).catch((e) => e);
    expect(err).toMatchObject({ code: 'too-large', hint: expect.stringContaining('VID2CONTEXT_MAX_MEDIA_MB') });
    expect(err.message).toBe('The media is 196.6 MB, over the 150 MB limit.');
  });

  it('enforces a lower cap from env while streaming', async () => {
    const fetch = replayFetch([{ method: 'GET', url: URL_MP3, response: asResponse(HEAD, MP3) }]);
    const ctx = testContext({ fetch, env: { VID2CONTEXT_MAX_MEDIA_MB: '0.1' } });
    await expect(mediaUrl.getAudio?.(ref(URL_MP3), ctx)).rejects.toMatchObject({ code: 'too-large' });
  });

  it('refuses an HTML page served at a media-looking URL', async () => {
    const fetch = replayFetch([
      {
        method: 'GET',
        url: URL_MP3,
        response: { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' }, body: '<html></html>' },
      },
    ]);
    await expect(mediaUrl.getAudio?.(ref(URL_MP3), testContext({ fetch }))).rejects.toMatchObject({ code: 'unavailable' });
  });

  it('leaves video URLs to ffmpeg on Node and caps them at audio size elsewhere', async () => {
    const video = ref('https://upload.wikimedia.org/wikipedia/commons/talk.mp4');
    expect(mediaUrl.canProvideAudio?.(video, testContext({ runtime: 'node' }))).toBe(false);
    expect(mediaUrl.canProvideAudio?.(video, testContext({ runtime: 'workers' }))).toBe(true);
    expect(mediaUrl.canProvideAudio?.(ref(URL_MP3), testContext({ runtime: 'node' }))).toBe(true);
    // The recorded 206 MB content-length, served for a video URL on Workers.
    const fetch = replayFetch([{ method: 'HEAD', url: video.url as string, response: asResponse(BIG_HEAD) }]);
    const err = await mediaUrl.getAudio?.(video, testContext({ runtime: 'workers', fetch })).catch((e) => e);
    expect(err).toMatchObject({ code: 'too-large', hint: expect.stringContaining('ffmpeg') });
  });
});

describe.skipIf(!process.env.LIVE)('media-url (LIVE)', () => {
  const live = (): Ctx => createContext({ runtime: 'node', env: { ...process.env } });

  it('reads metadata from the real URL', async () => {
    const meta = await mediaUrl.getMetadata(ref(URL_MP3), live());
    expect(meta.extra).toMatchObject({ sizeBytes: 135296, contentType: 'audio/mpeg' });
  });

  it('transcribes a real direct mp3 URL through the full pipeline with the keyless OVH rung', { timeout: 180_000 }, async () => {
    const { createRegistry } = await import('@vid2context/registry/node');
    const registry = createRegistry();
    const ctx = live();
    const result = await getVideoContext(registry, URL_MP3, { mode: 'auto', chain: { only: ['ovh'] }, storage: null }, ctx);
    expect(result.transcript.origin).toBe('stt');
    expect(result.transcript.producer).toMatch(/^stt\/ovh\//);
    expect(
      result.transcript.segments
        .map((s) => s.text)
        .join(' ')
        .toLowerCase(),
    ).toContain('orbit');
    expect(result.attempts.find((a) => a.stage === 'audio')).toMatchObject({ id: 'media-url', outcome: 'ok' });
  });
});

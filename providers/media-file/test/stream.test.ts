import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createContext, getVideoContext, Registry, type VideoRef } from '@vid2context/core';
import { replayFetch, testContext } from '@vid2context/core/testing';
import { findTools } from '@vid2context/ffmpeg';
import { describe, expect, it } from 'vitest';
import {
  matchStream,
  mediaStream,
  parseDashManifest,
  parseHlsPlaylist,
  parseIsoDuration,
  pickAudioPlaylist,
  streamTitle,
} from '../src/stream.ts';

const FIX = join(import.meta.dirname, 'fixtures');
const text = (name: string) => readFileSync(join(FIX, name), 'utf8');
// Real manifests recorded from Apple's and Akamai's public test streams (test/fixtures/README.md).
const BIPBOP = 'https://devstreaming-cdn.apple.com/videos/streaming/examples/bipbop_16x9/bipbop_16x9_variant.m3u8';
const BIPBOP_GEAR0 = 'https://devstreaming-cdn.apple.com/videos/streaming/examples/bipbop_16x9/gear0/prog_index.m3u8';
const BBB = 'https://dash.akamaized.net/akamai/bbb_30fps/bbb_30fps.mpd';
const MASTER = text('bipbop_16x9_variant.m3u8');
const GEAR0 = text('bipbop_16x9_gear0_prog_index.m3u8');
const MPD = text('bbb_30fps.mpd');

function ref(url: string): VideoRef {
  const r = matchStream(url);
  if (!r) throw new Error(`no match for ${url}`);
  return r;
}

describe('matchStream', () => {
  it('matches HLS and DASH URLs and nothing else', () => {
    expect(matchStream(BIPBOP)).toMatchObject({ platform: 'media', kind: 'video', url: BIPBOP });
    expect(matchStream(`${BBB}?token=abc`)?.url).toBe(`${BBB}?token=abc`);
    expect(matchStream('https://example.org/a.mp3')).toBeNull();
    expect(matchStream('/local/playlist.m3u8')).toBeNull();
  });

  it('builds readable titles, skipping generic file names', () => {
    expect(streamTitle(BIPBOP)).toBe('bipbop 16x9 variant');
    expect(streamTitle(BIPBOP_GEAR0)).toBe('gear0');
    expect(streamTitle('https://cdn.example.org/events/keynote_2026/master.m3u8')).toBe('keynote 2026');
  });
});

describe('HLS parsing', () => {
  it('reads variants and renditions from a real multivariant playlist and picks the audio-only variant', () => {
    const info = parseHlsPlaylist(MASTER, BIPBOP);
    expect(info.kind).toBe('multivariant');
    expect(info.variants).toHaveLength(6);
    expect(info.renditions.filter((r) => r.type === 'AUDIO')).toHaveLength(2);
    expect(info.renditions.filter((r) => r.type === 'SUBTITLES').map((r) => r.language)).toContain('ja');
    // The default audio rendition has no URI (audio is muxed), so the smallest audio-only variant wins.
    expect(pickAudioPlaylist(info)).toBe(BIPBOP_GEAR0);
  });

  it('sums segment durations of a real media playlist', () => {
    const info = parseHlsPlaylist(GEAR0, BIPBOP_GEAR0);
    const expected = [...GEAR0.matchAll(/#EXTINF:([\d.]+)/g)].reduce((s, m) => s + Number(m[1]), 0);
    expect(info).toMatchObject({ kind: 'media', isLive: false });
    expect(info.segments).toBe(180);
    expect(info.durationSec).toBeCloseTo(expected, 3);
  });

  it('refuses a body that is not a playlist', () => {
    expect(() => parseHlsPlaylist('<html></html>', BIPBOP)).toThrow(/#EXTM3U/);
  });
});

describe('DASH parsing', () => {
  it('reads duration, type and adaptation sets from a real MPD', () => {
    expect(parseDashManifest(MPD)).toEqual({
      durationSec: 634.566,
      isLive: false,
      title: undefined,
      adaptationSets: 2,
      hasAudio: true,
    });
    expect(parseIsoDuration('PT1H2M3.5S')).toBe(3723.5);
    expect(parseIsoDuration('P1DT2H')).toBe(93600);
  });
});

describe('mediaStream.getMetadata', () => {
  it('follows the multivariant playlist to the audio playlist for duration', async () => {
    const fetch = replayFetch([
      { url: BIPBOP, response: { headers: { 'content-type': 'application/x-mpegURL' }, body: MASTER } },
      { url: BIPBOP_GEAR0, response: { headers: { 'content-type': 'application/x-mpegURL' }, body: GEAR0 } },
    ]);
    const meta = await mediaStream.getMetadata(ref(BIPBOP), testContext({ fetch }));
    expect(meta).toMatchObject({
      title: 'bipbop 16x9 variant',
      isLive: false,
      chapters: [],
      extra: {
        format: 'hls',
        audioPlaylist: BIPBOP_GEAR0,
        variants: 6,
        subtitleLanguages: ['en', 'fr', 'es', 'ja'],
        segments: 180,
      },
    });
    expect(meta.durationSec).toBeGreaterThan(1700);
  });

  it('reads a DASH manifest', async () => {
    const fetch = replayFetch([{ url: BBB, response: { body: MPD } }]);
    const meta = await mediaStream.getMetadata(ref(BBB), testContext({ fetch }));
    expect(meta).toMatchObject({ title: 'bbb 30fps', durationSec: 634.566, isLive: false, extra: { format: 'dash' } });
  });

  it('reports a missing manifest as not-found', async () => {
    const fetch = replayFetch([{ url: BIPBOP, response: { status: 404, body: '' } }]);
    await expect(mediaStream.getMetadata(ref(BIPBOP), testContext({ fetch }))).rejects.toMatchObject({ code: 'not-found' });
  });
});

const HAVE_FFMPEG = !findTools({ PATH: process.env.PATH }).problem;

describe.skipIf(!HAVE_FFMPEG)('direct video URLs', () => {
  it('refuses a video over VID2CONTEXT_MAX_MEDIA_MB from its HEAD before downloading', async () => {
    // Real HEAD headers recorded from Wikimedia (a 206,115,140-byte file), see providers/media-url/test/fixtures.
    const big = JSON.parse(readFileSync(join(import.meta.dirname, '../../media-url/test/fixtures/crew13.head.json'), 'utf8'));
    const url = 'https://upload.wikimedia.org/wikipedia/commons/talk.mp4';
    const fetch = replayFetch([{ method: 'HEAD', url, response: { status: big.status, headers: big.headers, body: '' } }]);
    const ctx = testContext({
      fetch,
      env: { PATH: process.env.PATH, VID2CONTEXT_MAX_MEDIA_MB: '150', VID2CONTEXT_FFMPEG_DOWNLOAD: '0' },
    });
    const video = { input: url, platform: 'media', kind: 'video' as const, id: 'media:t', nativeId: 't', url };
    await expect(mediaStream.getAudio?.(video, ctx)).rejects.toMatchObject({
      code: 'too-large',
      message: /196\.6 MB, over the 150 MB/,
    });
    expect(fetch.calls.map((c) => c.method)).toEqual(['HEAD']);
  });
});

describe('mediaStream.canProvideAudio', () => {
  it('claims streams and direct video URLs on Node only', () => {
    const video = {
      input: 'x',
      platform: 'media',
      kind: 'video' as const,
      id: 'media:x',
      nativeId: 'x',
      url: 'https://a.org/talk.mp4',
    };
    const audio = { ...video, url: 'https://a.org/talk.mp3' };
    expect(mediaStream.canProvideAudio?.(ref(BIPBOP), testContext({ runtime: 'node' }))).toBe(true);
    expect(mediaStream.canProvideAudio?.(video, testContext({ runtime: 'node' }))).toBe(true);
    expect(mediaStream.canProvideAudio?.(audio, testContext({ runtime: 'node' }))).toBe(false);
    expect(mediaStream.canProvideAudio?.(video, testContext({ runtime: 'workers' }))).toBe(false);
  });
});

describe.skipIf(!process.env.LIVE || !HAVE_FFMPEG)('media-stream (LIVE)', () => {
  const live = () => createContext({ runtime: 'node', env: { ...process.env } });

  it('extracts 16 kHz mono mp3 from the Apple public HLS example', { timeout: 300_000 }, async () => {
    const audio = await mediaStream.getAudio?.(ref(BIPBOP), live());
    expect(audio).toMatchObject({ kind: 'bytes', mimeType: 'audio/mpeg', filename: 'bipbop 16x9 variant.mp3' });
    expect(audio?.durationSec).toBeGreaterThan(1700);
  });

  it('transcribes a real HLS stream with speech through the pipeline (Tears of Steel, CC BY 3.0)', {
    timeout: 600_000,
  }, async () => {
    const url = 'https://demo.unified-streaming.com/k8s/features/stable/video/tears-of-steel/tears-of-steel.ism/.m3u8';
    const stt = (await import('@vid2context/provider-stt-openai-compatible')).default;
    const registry = new Registry([mediaStream, stt].flat(), 'node');
    const ctx = live();
    const res = await getVideoContext(registry, url, { storage: null, chain: { only: ['ovh'] } }, ctx);
    expect(res.transcript.origin).toBe('stt');
    expect(res.attempts.find((a) => a.stage === 'audio')).toMatchObject({ id: 'media-stream', outcome: 'ok' });
    expect(res.transcript.segments.length).toBeGreaterThan(20);
  });
});

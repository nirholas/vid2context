/**
 * Real downloads from YouTube with the managed yt-dlp and the local ffmpeg.
 * Run with `npm run test:live`. Uses "Me at the zoo" (19 s) and a 10-second
 * part of Big Buck Bunny (Blender Foundation, CC BY 3.0) to keep traffic small.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { probe } from '@vid2context/ffmpeg';
import { createNodeContext, createRegistry } from '@vid2context/registry/node';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDownloader } from '../src/node.ts';
import { normalizeRequest } from '../src/options.ts';

describe.skipIf(!process.env.LIVE)('live downloads', () => {
  let dir: string;
  const ctx = createNodeContext();
  let downloader: ReturnType<typeof createDownloader>;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'v2c-dl-live-'));
    downloader = createDownloader({ registry: createRegistry() });
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('is ready: yt-dlp installed and ffmpeg found', async () => {
    const status = await downloader.status(ctx);
    expect(status.problem).toBeUndefined();
    expect(status.ready).toBe(true);
  });

  it('downloads an mp4 with H.264, stereo AAC, cover art and chapters', async () => {
    const file = await downloader.download(normalizeRequest({ url: 'jNQXAC9IVRw', format: 'mp4', quality: '720' }), ctx, { dir });
    expect(file.filename).toBe('Me at the zoo [jNQXAC9IVRw].mp4');
    const p = await probe(file.path, ctx);
    expect(p.streams.find((s) => s.type === 'video' && !s.isAttachedPic)?.codec).toBe('h264');
    expect(p.streams.find((s) => s.type === 'audio')).toMatchObject({ codec: 'aac', channels: 2 });
    expect(p.streams.some((s) => s.isAttachedPic)).toBe(true);
    expect(p.chapters.length).toBe(3);
    expect(p.tags.title).toBe('Me at the zoo');
  });

  it('downloads mp3 audio at a fixed bitrate', async () => {
    const file = await downloader.download(normalizeRequest({ url: 'jNQXAC9IVRw', format: 'mp3', quality: '192' }), ctx, { dir });
    const p = await probe(file.path, ctx);
    expect(p.streams.find((s) => s.type === 'audio')?.codec).toBe('mp3');
    expect(Math.round(p.durationSec ?? 0)).toBe(19);
  });

  it('keeps only the asked part, falling back to a local trim when ffmpeg cannot fetch sections', async () => {
    const file = await downloader.download(
      normalizeRequest({ url: 'aqz-KE-bpKQ', format: 'm4a', from: '1:00', to: '1:10' }),
      ctx,
      { dir },
    );
    expect(file.filename).toContain('(1m00s-1m10s)');
    const p = await probe(file.path, ctx);
    expect(p.durationSec).toBeGreaterThan(9);
    expect(p.durationSec).toBeLessThan(11.5);
  });

  it('probes qualities and sizes', async () => {
    const o = await downloader.probe('https://www.youtube.com/watch?v=aqz-KE-bpKQ', ctx);
    expect(o.video[0]?.label).toBe('2160p60');
    expect(o.video.find((v) => v.quality === '1080')?.codecs.mp4).toBe('h264 + aac');
  });
});

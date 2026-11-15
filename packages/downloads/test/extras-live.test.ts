/**
 * Thumbnails, chapter splits and burned subtitles from YouTube with the
 * managed yt-dlp and the local ffmpeg. Run with `npm run test:live`. Uses
 * "Me at the zoo" (19 s, three chapters, English captions) to keep traffic small.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { probe } from '@vid2context/ffmpeg';
import { createNodeContext, createRegistry } from '@vid2context/registry/node';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDownloader } from '../src/node.ts';
import { normalizeRequest } from '../src/options.ts';

describe.skipIf(!process.env.LIVE)('live download extras', () => {
  let dir: string;
  const ctx = createNodeContext();
  const downloader = createDownloader({ registry: createRegistry() });

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'v2c-extras-live-'));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it.each(['jpg', 'png'] as const)(
    'saves the largest YouTube thumbnail as %s',
    async (format) => {
      const saved = await downloader.thumbnail?.({ input: 'jNQXAC9IVRw', format }, ctx, { dir });
      expect(saved?.origin).toBe('site');
      expect(saved?.filename).toBe(`Me at the zoo [jNQXAC9IVRw].${format}`);
      const p = await probe(saved?.path as string, ctx);
      expect(p.streams[0]?.width).toBeGreaterThanOrEqual(480);
    },
    120_000,
  );

  it('splits the video into its three chapters', async () => {
    const file = await downloader.download(
      normalizeRequest({ url: 'jNQXAC9IVRw', format: 'mp4', quality: '240', splitChapters: true }),
      ctx,
      { dir },
    );
    expect(file.parts).toHaveLength(3);
    expect(file.parts?.[0]?.filename).toMatch(/^Me at the zoo \[jNQXAC9IVRw\]\/01 - /);
    for (const part of file.parts ?? []) expect((await probe(part.path, ctx)).durationSec).toBeGreaterThan(1);
  }, 300_000);

  it('burns the English captions into the picture', async () => {
    const file = await downloader.download(
      normalizeRequest({ url: 'jNQXAC9IVRw', format: 'mp4', quality: '240', burnSubtitles: 'en' }),
      ctx,
      { dir: join(dir, 'burn') },
    );
    // YouTube sometimes answers subtitle requests with 429; that is a warning, not a failure.
    if (file.warnings.some((w) => /could not be downloaded/.test(w))) return;
    expect(file.warnings).toEqual([]);
    expect(Math.round((await probe(file.path, ctx)).durationSec ?? 0)).toBe(19);
  }, 300_000);
});

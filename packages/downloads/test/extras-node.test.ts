/**
 * Burned subtitles, chapter splits and thumbnails on real media with the
 * local ffmpeg: the public-domain Apollo 11 clip and its Commons subtitles,
 * shared with packages/ffmpeg (see that package's test/fixtures/README.md).
 * Skipped when ffmpeg with libass is not installed.
 */
import { spawnSync } from 'node:child_process';
import { copyFile, mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { probe, tryLocateFfmpeg } from '@vid2context/ffmpeg';
import { createNodeContext } from '@vid2context/registry/node';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { THUMBNAIL_FORMATS } from '../src/extras.ts';
import { subtitlesFilter } from '../src/node/extras.ts';
import { createDownloadManager } from '../src/node/manager.ts';
import { createDownloader } from '../src/node.ts';
import { normalizeRequest } from '../src/options.ts';

const media = (name: string) => fileURLToPath(new URL(`../../ffmpeg/test/fixtures/${name}`, import.meta.url));
const ctx = createNodeContext();
const tools = await tryLocateFfmpeg(ctx);
const hasLibass =
  !!tools && /\bsubtitles\b/.test(spawnSync(tools.ffmpeg, ['-hide_banner', '-filters'], { encoding: 'utf8' }).stdout ?? '');

describe('subtitlesFilter', () => {
  it('quotes the path and escapes drive-letter colons', () => {
    expect(subtitlesFilter('/tmp/x/subs.srt')).toBe("subtitles=filename='/tmp/x/subs.srt'");
    expect(subtitlesFilter('C:\\Temp\\subs.srt')).toBe("subtitles=filename='C\\:/Temp/subs.srt'");
    expect(() => subtitlesFilter("/tmp/it's/subs.srt")).toThrow(/quote/);
  });
});

describe.skipIf(!hasLibass)('download extras with real ffmpeg', () => {
  let work: string;
  let chaptered: string;
  const downloader = createDownloader();

  beforeAll(async () => {
    // A tricky directory name: the subtitles filter must survive commas, brackets and colons in paths.
    work = await mkdtemp(join(tmpdir(), 'v2c-extras [a,b]:'));
    await copyFile(media('apollo11-first-steps.mp4'), join(work, 'apollo.mp4'));
    await copyFile(media('apollo11-first-steps.en.srt'), join(work, 'apollo.en.srt'));
    // Three chapters written by ffmpeg itself, so the split reads them from the file like a yt-dlp download.
    chaptered = join(work, 'chaptered.mp4');
    const meta = join(work, 'chapters.txt');
    const { writeFile } = await import('node:fs/promises');
    await writeFile(
      meta,
      ';FFMETADATA1\n[CHAPTER]\nTIMEBASE=1/1000\nSTART=0\nEND=20000\ntitle=Descent\n[CHAPTER]\nTIMEBASE=1/1000\nSTART=20000\nEND=40000\ntitle=Ladder\n[CHAPTER]\nTIMEBASE=1/1000\nSTART=40000\nEND=61500\ntitle=Surface\n',
    );
    const r = spawnSync(tools?.ffmpeg as string, [
      '-v',
      'error',
      '-y',
      '-i',
      media('apollo11-first-steps.mp4'),
      '-i',
      meta,
      '-map_metadata',
      '1',
      '-map_chapters',
      '1',
      '-c',
      'copy',
      chaptered,
    ]);
    expect(r.status).toBe(0);
  });
  afterAll(async () => {
    await rm(work, { recursive: true, force: true });
  });

  it('burns a sidecar .en.srt into a local video and keeps its length', async () => {
    const dir = join(work, 'out-burn');
    const file = await downloader.download(
      normalizeRequest({ url: join(work, 'apollo.mp4'), format: 'mp4', burnSubtitles: 'en' }),
      ctx,
      { dir },
    );
    expect(file.warnings).toEqual([]);
    const p = await probe(file.path, ctx);
    expect(p.streams.find((s) => s.type === 'video')?.codec).toBe('h264');
    expect(Math.abs((p.durationSec ?? 0) - 61.5)).toBeLessThan(1);
    // Re-encoded with text drawn in: not byte-identical to the source.
    expect((await readFile(file.path)).equals(await readFile(media('apollo11-first-steps.mp4')))).toBe(false);
  }, 120_000);

  it('burns the embedded English stream of an mkv', async () => {
    const file = await downloader.download(
      normalizeRequest({ url: media('apollo11-first-steps-subs.mkv'), format: 'mkv', burnSubtitles: 'en' }),
      ctx,
      { dir: join(work, 'out-burn-mkv') },
    );
    expect(file.warnings).toEqual([]);
    const p = await probe(file.path, ctx);
    expect(p.streams.find((s) => s.type === 'video')?.codec).toBe('h264');
  }, 120_000);

  it('burns into an exactly trimmed part, with cue times moved to the part', async () => {
    const file = await downloader.download(
      normalizeRequest({
        url: join(work, 'apollo.mp4'),
        format: 'mp4',
        burnSubtitles: 'en',
        from: '20',
        to: '30',
        exactCuts: true,
      }),
      ctx,
      { dir: join(work, 'out-burn-trim') },
    );
    expect(file.warnings).toEqual([]);
    const p = await probe(file.path, ctx);
    expect(Math.abs((p.durationSec ?? 0) - 10)).toBeLessThan(0.5);
  }, 120_000);

  it('warns, and still saves the video, when no subtitles exist in that language', async () => {
    const file = await downloader.download(
      normalizeRequest({ url: join(work, 'apollo.mp4'), format: 'mp4', burnSubtitles: 'de' }),
      ctx,
      { dir: join(work, 'out-burn-de') },
    );
    expect(file.warnings.join(' ')).toMatch(/No de subtitles were found/);
    expect((await stat(file.path)).size).toBeGreaterThan(0);
  }, 60_000);

  it('splits a local video into one file per chapter, read from the file', async () => {
    const dir = join(work, 'out-split');
    const file = await downloader.download(normalizeRequest({ url: chaptered, format: 'mp4', splitChapters: true }), ctx, {
      dir,
    });
    expect(file.parts?.map((p) => p.filename)).toEqual([
      'chaptered/01 - Descent.mp4',
      'chaptered/02 - Ladder.mp4',
      'chaptered/03 - Surface.mp4',
    ]);
    expect(await readdir(join(dir, 'chaptered'))).toHaveLength(3);
    for (const part of file.parts ?? []) {
      const p = await probe(part.path, ctx);
      // Stream copy cuts on keyframes, so lengths are close to the chapter, not exact.
      expect(Math.abs((p.durationSec ?? 0) - (part.toSec - part.fromSec))).toBeLessThan(3);
    }
    expect(file.warnings).toEqual([]);
  }, 120_000);

  it('saves the full file and warns when there are no chapters to split by', async () => {
    const file = await downloader.download(
      normalizeRequest({ url: join(work, 'apollo.mp4'), format: 'mp4', splitChapters: true }),
      ctx,
      { dir: join(work, 'out-nosplit') },
    );
    expect(file.parts).toBeUndefined();
    expect(file.warnings.join(' ')).toMatch(/no chapters/);
  }, 60_000);

  it.each(THUMBNAIL_FORMATS)(
    'takes a %s thumbnail from a local video frame',
    async (format) => {
      const saved = await downloader.thumbnail?.({ input: join(work, 'apollo.mp4'), format }, ctx, {
        dir: join(work, 'out-thumb'),
      });
      expect(saved?.origin).toBe('frame');
      expect(saved?.filename).toBe(`apollo.${format}`);
      const p = await probe(saved?.path as string, ctx);
      expect(p.streams[0]).toMatchObject({ type: 'video', width: 160, height: 120 });
    },
    60_000,
  );

  it('serves chapter parts and thumbnails through the download manager', async () => {
    const manager = createDownloadManager({ downloader, dir: join(work, 'jobs') });
    try {
      const job = manager.create(normalizeRequest({ url: chaptered, format: 'mp4', splitChapters: true }), ctx);
      for (let i = 0; i < 600 && manager.get(job.id)?.status !== 'done'; i++) {
        if (manager.get(job.id)?.status === 'error') throw new Error(JSON.stringify(manager.get(job.id)?.error));
        await new Promise((r) => setTimeout(r, 100));
      }
      const done = manager.get(job.id);
      expect(done?.file?.parts?.map((p) => p.title)).toEqual(['Descent', 'Ladder', 'Surface']);
      // The server's own job folder never shows up in what callers see.
      expect(JSON.stringify(done)).not.toContain(join(work, 'jobs'));
      const part = await manager.open(job.id, undefined, 1);
      expect(part?.filename).toBe('02 - Ladder.mp4');
      await part?.stream.cancel();
      expect(await manager.open(job.id, undefined, 9)).toBeUndefined();

      const img = await manager.thumbnail?.({ input: join(work, 'apollo.mp4'), format: 'png' }, ctx);
      expect(img?.mimeType).toBe('image/png');
      const bytes = new Uint8Array(await new Response(img?.stream).arrayBuffer());
      expect(bytes.byteLength).toBe(img?.bytes);
      expect(bytes[1]).toBe(0x50);
    } finally {
      await manager.close();
    }
  }, 120_000);
});

import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { getVideoContext, Registry, type VideoRef } from '@vid2context/core';
import { testContext } from '@vid2context/core/testing';
import { findTools } from '@vid2context/ffmpeg';
import { afterAll, describe, expect, it } from 'vitest';
import { rankTracks } from '../src/captions.ts';
import providers, { findSidecars, matchFile, mediaFile, mediaFileCaptions } from '../src/index.ts';

// Real public-domain media (tests/fixtures/media/README.md, packages/ffmpeg/test/fixtures/README.md).
const APOLLO = resolve(join(import.meta.dirname, '../../../tests/fixtures/media/apollo11-small-step.mp3'));
const FF = resolve(join(import.meta.dirname, '../../../packages/ffmpeg/test/fixtures'));
const MP4 = join(FF, 'apollo11-first-steps.mp4');
const MKV = join(FF, 'apollo11-first-steps-subs.mkv');
const M4A = join(FF, 'apollo11-first-steps-chapters.m4a');
const SRT = join(FF, 'apollo11-first-steps.en.srt');

// Tests find the real ffmpeg through PATH; the "missing" env points FFMPEG_PATH at nothing.
const ENV = { PATH: process.env.PATH, VID2CONTEXT_FFMPEG_DOWNLOAD: '0' };
const NO_FFMPEG = { FFMPEG_PATH: '/nonexistent/ffmpeg', FFPROBE_PATH: '/nonexistent/ffprobe', VID2CONTEXT_FFMPEG_DOWNLOAD: '0' };
const found = findTools(ENV);
const HAVE_FFMPEG = Boolean(found.ffmpeg && found.ffprobe && !found.problem);
if (!HAVE_FFMPEG) console.error(`[media-file tests] skipping ffmpeg-dependent tests: ${found.problem}`);

const temps: string[] = [];
function dirWith(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'v2c-media-file-'));
  temps.push(dir);
  for (const [name, src] of Object.entries(files)) copyFileSync(src, join(dir, name));
  return dir;
}
afterAll(() => {
  for (const d of temps) rmSync(d, { recursive: true, force: true });
});

function refFor(path: string): VideoRef {
  const ref = matchFile(path);
  if (!ref) throw new Error(`no match for ${path}`);
  return ref;
}

describe('matchFile', () => {
  it('matches absolute paths and file URLs to the same stable id', () => {
    const a = matchFile(APOLLO);
    const b = matchFile(pathToFileURL(APOLLO).href);
    expect(a).toMatchObject({ platform: 'file', kind: 'video', url: pathToFileURL(APOLLO).href });
    expect(a?.id).toMatch(/^file:[0-9a-f]{32}$/);
    expect(b?.id).toBe(a?.id);
  });

  it('leaves YouTube ids, web URLs and extensionless missing names alone', () => {
    expect(matchFile('jNQXAC9IVRw')).toBeNull();
    expect(matchFile('https://www.youtube.com/watch?v=jNQXAC9IVRw')).toBeNull();
    expect(matchFile('https://example.org/a.mp3')).toBeNull();
    expect(matchFile('notes')).toBeNull();
  });

  it('matches a missing media path so the user gets a not-found error, not unsupported-input', async () => {
    const ref = refFor('/nonexistent/interview.mp3');
    expect(ref.platform).toBe('file');
    await expect(mediaFile.getMetadata(ref, testContext())).rejects.toMatchObject({ code: 'not-found' });
  });

  it('exports the source, captions and stream providers, all Node only', () => {
    expect(providers.map((p) => p.id)).toEqual(['media-file', 'media-file-captions', 'media-stream']);
    for (const p of providers) expect(p.runtimes).toEqual(['node']);
  });
});

describe('without ffmpeg', () => {
  const ctx = () => testContext({ env: NO_FFMPEG });

  it('reads metadata from the filesystem and says ffmpeg is missing', async () => {
    const meta = await mediaFile.getMetadata(refFor(APOLLO), ctx());
    expect(meta).toMatchObject({ title: 'apollo11-small-step', chapters: [], extra: { path: APOLLO, sizeBytes: 145412 } });
    expect(String(meta.extra?.ffmpeg)).toMatch(/not found/);
  });

  it('still sends audio files as raw bytes', async () => {
    const audio = await mediaFile.getAudio?.(refFor(APOLLO), ctx());
    expect(audio).toMatchObject({ kind: 'bytes', mimeType: 'audio/mpeg', filename: 'apollo11-small-step.mp3' });
    expect(audio?.kind === 'bytes' && audio.data.byteLength).toBe(145412);
  });

  it('explains that video files need ffmpeg', async () => {
    const err = await mediaFile.getAudio?.(refFor(MP4), ctx()).catch((e) => e);
    expect(err).toMatchObject({ code: 'unavailable', message: expect.stringMatching(/Video files need ffmpeg/) });
    expect(err.hint).toMatch(/FFMPEG_PATH/);
  });
});

describe('sidecar subtitles', () => {
  it('finds talk.srt, talk.<lang>.srt and forced tracks, and ignores other media files', () => {
    const dir = dirWith({
      'talk.mp4': MP4,
      'talk.srt': SRT,
      'talk.en.srt': SRT,
      'talk.pt-BR.vtt': SRT,
      'talk.en.forced.srt': SRT,
      'talk.final.srt': SRT,
      'talkshow.srt': SRT,
      'talk.fra.srt': SRT,
    });
    const tracks = findSidecars(join(dir, 'talk.mp4'));
    expect(tracks.map((t) => [t.name, t.language ?? null, t.forced])).toEqual([
      ['talk.srt', null, false],
      ['talk.en.forced.srt', 'en', true],
      ['talk.en.srt', 'en', false],
      ['talk.fra.srt', 'fr', false],
      ['talk.pt-BR.vtt', 'pt-BR', false],
    ]);
    const ranked = (lang?: string) => rankTracks(tracks, lang, undefined).map((t) => t.name);
    expect(ranked('pt')).toEqual(['talk.pt-BR.vtt', 'talk.srt']);
    expect(ranked('en')).toEqual(['talk.en.srt', 'talk.srt']);
    expect(ranked(undefined)[0]).toBe('talk.srt');
    expect(
      rankTracks(
        tracks.filter((t) => t.language),
        'de',
        undefined,
      ),
    ).toEqual([]);
  });

  it('returns a sidecar as creator captions with the language from the file name', async () => {
    const dir = dirWith({ 'talk.mp4': MP4, 'talk.en.srt': SRT });
    const t = await mediaFileCaptions.getCaptions(refFor(join(dir, 'talk.mp4')), {}, testContext({ env: NO_FFMPEG }));
    expect(t).toMatchObject({
      language: 'en',
      origin: 'creator-captions',
      producer: 'media-file-captions',
      model: 'sidecar:talk.en.srt',
    });
    expect(t?.segments).toHaveLength(7);
    expect(t?.segments[6]?.text).toBe("That's one small step for [a] man, one giant leap for mankind.");
  });

  it('returns null when there are no subtitles, so speech-to-text runs', async () => {
    const dir = dirWith({ 'talk.mp4': MP4 });
    expect(await mediaFileCaptions.getCaptions(refFor(join(dir, 'talk.mp4')), {}, testContext({ env: ENV }))).toBeNull();
  });

  it('uses the sidecar in the full pipeline without touching speech-to-text', async () => {
    const dir = dirWith({ 'talk.mp4': MP4, 'talk.srt': SRT });
    const registry = new Registry(providers, 'node');
    const res = await getVideoContext(registry, join(dir, 'talk.mp4'), { storage: null }, testContext({ env: ENV }));
    expect(res.transcript).toMatchObject({ origin: 'creator-captions', producer: 'media-file-captions' });
    expect(res.attempts.find((a) => a.stage === 'captions')).toMatchObject({ id: 'media-file-captions', outcome: 'ok' });
    expect(res.attempts.some((a) => a.stage === 'audio' || a.stage === 'stt')).toBe(false);
  });
});

describe.skipIf(!HAVE_FFMPEG)('with ffmpeg', () => {
  const ctx = () => testContext({ env: ENV });

  it('reads title, duration, artist and date from the container', async () => {
    const meta = await mediaFile.getMetadata(refFor(MP4), ctx());
    expect(meta).toMatchObject({
      title: 'Apollo 11 Landing - first steps on the moon',
      channel: { name: 'NASA' },
      publishedAt: '1969',
      chapters: [],
      extra: { path: MP4, hasVideo: true },
    });
    expect(meta.durationSec).toBeCloseTo(61.5, 1);
    expect(meta.extra?.streams).toEqual([
      { index: 0, type: 'video', codec: 'h264', width: 160, height: 120 },
      { index: 1, type: 'audio', codec: 'aac', channels: 1, sampleRate: 22050 },
    ]);
  });

  it('turns container chapters into Chapter[] and takes the language from the audio stream', async () => {
    const meta = await mediaFile.getMetadata(refFor(M4A), ctx());
    expect(meta.language).toBe('en');
    expect(meta.chapters).toEqual([
      { title: 'At the foot of the ladder', startSec: 0, endSec: 3.26 },
      { title: 'Describing the surface', startSec: 3.26, endSec: 36.746 },
      { title: 'Stepping off the LEM', startSec: 36.746, endSec: 47.772 },
      { title: 'One small step', startSec: 47.772, endSec: 61.518 },
    ]);
  });

  it('extracts 16 kHz mono mp3 from a video instead of uploading it', async () => {
    const audio = await mediaFile.getAudio?.(refFor(MP4), ctx());
    expect(audio).toMatchObject({ kind: 'bytes', mimeType: 'audio/mpeg', filename: 'apollo11-first-steps.mp3' });
    if (audio?.kind !== 'bytes') throw new Error('expected bytes');
    expect(audio.durationSec).toBeCloseTo(61.5, 0);
    expect(audio.data.byteLength).toBeLessThan(300_000);
  });

  it('passes a small mp3 through untouched, with its duration', async () => {
    const audio = await mediaFile.getAudio?.(refFor(APOLLO), ctx());
    expect(audio?.kind === 'bytes' && audio.data.byteLength).toBe(145412);
    expect(audio?.durationSec).toBeCloseTo(24.2, 0);
  });

  it('reads embedded subtitle streams when there is no sidecar', async () => {
    const dir = dirWith({ 'movie.mkv': MKV });
    const ref = refFor(join(dir, 'movie.mkv'));
    expect(await mediaFileCaptions.listTracks?.(ref, ctx())).toEqual([
      { language: 'en', name: 'stream 2 (subrip)', origin: 'creator-captions' },
    ]);
    const t = await mediaFileCaptions.getCaptions(ref, { language: 'en' }, ctx());
    expect(t).toMatchObject({ language: 'en', origin: 'creator-captions', model: 'embedded:2' });
    expect(t?.segments).toHaveLength(7);
    expect(t?.segments[0]).toEqual({ startSec: 0.5, endSec: 3.26, text: "I'm at the foot of the ladder." });
    expect(await mediaFileCaptions.getCaptions(ref, { language: 'de' }, ctx())).toBeNull();
  });
});

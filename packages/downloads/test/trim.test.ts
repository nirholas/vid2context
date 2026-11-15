/**
 * Cuts of local files land where asked: the Apollo 11 mkv (H.264 with sparse
 * keyframes, Opus copied) and mp4 from packages/ffmpeg/test/fixtures, trimmed
 * from 20 s to 30 s with the real ffmpeg. An input seek alone starts copied
 * streams at the keyframe before the cut (about 10.4 s here), which made a
 * 10 s cut 19.6 s long.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Registry } from '@vid2context/core';
import { testContext } from '@vid2context/core/testing';
import { probe, tryLocateFfmpeg } from '@vid2context/ffmpeg';
import mediaFile from '@vid2context/provider-media-file';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDownloader } from '../src/node.ts';
import { normalizeRequest } from '../src/options.ts';

const FIX = new URL('../../ffmpeg/test/fixtures/', import.meta.url).pathname;
const env = { PATH: process.env.PATH, HOME: process.env.HOME };
const hasFfmpeg = !!(await tryLocateFfmpeg({ env }).catch(() => null));

describe.skipIf(!hasFfmpeg)('exact cuts of local files', () => {
  const ctx = testContext({ env });
  const downloader = createDownloader({ registry: new Registry(mediaFile, 'node') });
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'v2c-trim-'));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const cut = async (file: string, raw: Record<string, unknown>) => {
    const saved = await downloader.download(normalizeRequest({ url: join(FIX, file), from: '20', to: '30', ...raw }), ctx, {
      dir,
    });
    return (await probe(saved.path, ctx)).durationSec ?? 0;
  };

  it('keeps 10 s of an mkv with exactCuts, though its audio is copied', async () => {
    expect(await cut('apollo11-first-steps-subs.mkv', { format: 'mkv', exactCuts: true })).toBeCloseTo(10, 0);
  });

  it('keeps 10 s of audio taken from a video, copied or converted', async () => {
    expect(await cut('apollo11-first-steps-subs.mkv', { format: 'opus' })).toBeCloseTo(10, 0);
    expect(await cut('apollo11-first-steps.mp4', { format: 'm4a' })).toBeCloseTo(10, 0);
    expect(await cut('apollo11-first-steps.mp4', { format: 'mp3', quality: '64' })).toBeCloseTo(10, 0);
  });

  it('keeps 10 s of an mp4 with exactCuts', async () => {
    expect(await cut('apollo11-first-steps.mp4', { format: 'mp4', exactCuts: true })).toBeCloseTo(10, 0);
  });
});

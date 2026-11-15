/**
 * `vid2context captions` and the toolkit modes of `vid2context download`
 * (--frames, --gif, --webp, --zip) on the public-domain Apollo 11 clip with
 * its Wikimedia Commons subtitles (packages/ffmpeg/test/fixtures), the real
 * transcript pipeline and the real ffmpeg. No network. Skipped without ffmpeg.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tryLocateFfmpeg } from '@vid2context/ffmpeg';
import { afterAll, describe, expect, it } from 'vitest';
import { APOLLO, cli, ROOT } from './helpers.ts';

const MP4 = join(ROOT, 'packages/ffmpeg/test/fixtures/apollo11-first-steps.mp4');
const MKV = join(ROOT, 'packages/ffmpeg/test/fixtures/apollo11-first-steps-subs.mkv');
const env = { PATH: process.env.PATH, HOME: process.env.HOME };
const hasFfmpeg = !!(await tryLocateFfmpeg({ env }).catch(() => null));
const tmp = mkdtempSync(join(tmpdir(), 'v2c-cli-captions-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe('captions usage', () => {
  it('needs an input and validates the format before reading anything', async () => {
    expect((await cli(['captions'], { env })).code).toBe(2);
    const bad = await cli(['captions', MP4, '-f', 'docx'], { env });
    expect(bad.code).not.toBe(0);
    expect(bad.stderr).toContain('Unknown caption format');
    expect(bad.stdout).toBe('');
  });

  it('refuses two download outputs at once', async () => {
    const res = await cli(['download', MP4, '--gif', '--frames', '1'], { env });
    expect(res.code).toBe(2);
    expect(res.stderr).toContain('--frames, --gif or --webp');
  });
});

describe.skipIf(!hasFfmpeg)('captions on local files', () => {
  it('lists tracks', async () => {
    const res = await cli(['captions', MKV, '--list'], { env });
    expect(res.code).toBe(0);
    expect(res.stdout).toContain('en       creator');
    const json = await cli(['captions', MKV, '--list', '--json'], { env });
    expect((JSON.parse(json.stdout) as { tracks: { language: string }[] }).tracks[0]?.language).toBe('en');
  });

  it('saves srt by default and prints only the path on stdout', async () => {
    const res = await cli(['captions', MP4, '-d', tmp], { env });
    expect(res.code).toBe(0);
    const path = join(tmp, 'apollo11-first-steps.en.srt');
    expect(res.stdout).toBe(`${path}\n`);
    expect(res.stderr).toContain('en (creator-captions, pipeline)');
    expect(readFileSync(path, 'utf8')).toContain('one small step');
  });

  it('writes txt with timestamps and the original embedded stream', async () => {
    const txt = await cli(['captions', MKV, '-f', 'txt', '--timestamps', '-d', tmp], { env });
    expect(readFileSync(txt.stdout.trim(), 'utf8')).toMatch(/^\[0:0\d\] /);
    const orig = await cli(['captions', MKV, '-f', 'original', '-d', tmp, '--json'], { env });
    const out = JSON.parse(orig.stdout) as { file: { filename: string; tracks: { via: string }[] } };
    expect(out.file.filename).toBe('apollo11-first-steps-subs.en.srt');
    expect(out.file.tracks[0]?.via).toBe('file');
  });

  it('runs several inputs as a batch, zipped, with failures on stderr', async () => {
    const res = await cli(['captions', MP4, APOLLO, '--mode', 'captions', '--zip', '-d', tmp], { env });
    expect(res.code).not.toBe(0);
    expect(res.stdout.trim().endsWith('.zip')).toBe(true);
    expect(res.stderr).toContain(`failed ${APOLLO}`);
    expect(res.stderr).toContain('1 of 2 saved');
  });
});

describe.skipIf(!hasFfmpeg)('download --frames, --gif, --webp and --zip', () => {
  it('grabs a frame and exports a GIF and a WebP', async () => {
    const frame = await cli(['download', MP4, '--frames', '0:12', '--frame-format', 'jpg', '-d', tmp], { env });
    expect(frame.code).toBe(0);
    expect(frame.stdout.trim().endsWith('apollo11-first-steps 0m12s.jpg')).toBe(true);
    const gif = await cli(['download', MP4, '--gif', '--from', '5', '--to', '6', '--fps', '5', '--width', '96', '-d', tmp], { env });
    expect(gif.code).toBe(0);
    expect(readFileSync(gif.stdout.trim()).subarray(0, 6).toString('latin1')).toBe('GIF89a');
    const webp = await cli(['download', MP4, '--webp', '--from', '5', '--to', '6', '-d', tmp], { env });
    expect(readFileSync(webp.stdout.trim()).subarray(8, 12).toString('latin1')).toBe('WEBP');
    const tooLong = await cli(['download', MP4, '--gif', '--from', '0', '--to', '5:00'], { env });
    expect(tooLong.stderr).toContain('at most 60 s');
  });

  it('packs several downloads into one .zip', async () => {
    const res = await cli(['download', APOLLO, MP4, '--audio', 'opus', '--quality', '64', '--zip', '-d', tmp, '--json'], { env });
    expect(res.code).toBe(0);
    const out = JSON.parse(res.stdout) as { file: { format: string; entries: { name: string }[] }; items: { status: string }[] };
    expect(out.file.format).toBe('zip');
    expect(out.file.entries.map((e) => e.name).sort()).toEqual(['apollo11-first-steps.opus', 'apollo11-small-step.opus']);
    expect(out.items.map((i) => i.status)).toEqual(['done', 'done']);
  });
});

/**
 * `vid2context download` on the public-domain Apollo 11 clip with the real
 * ffmpeg (no network). Skipped when ffmpeg is not installed.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tryLocateFfmpeg } from '@vid2context/ffmpeg';
import { afterAll, describe, expect, it } from 'vitest';
import { APOLLO, cli } from './helpers.ts';

const env = { PATH: process.env.PATH, HOME: process.env.HOME };
const hasFfmpeg = !!(await tryLocateFfmpeg({ env }).catch(() => null));
const tmp = mkdtempSync(join(tmpdir(), 'v2c-cli-dl-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe('download usage', () => {
  it('needs an input and refuses --video with --audio', async () => {
    expect((await cli(['download'], { env })).code).toBe(2);
    const both = await cli(['download', APOLLO, '--video', '--audio'], { env });
    expect(both.code).toBe(2);
    expect(both.stderr).toContain('not both');
  });

  it('refuses bad values before downloading anything', async () => {
    const res = await cli(['download', APOLLO, '--audio', 'mp3', '--quality', '1080'], { env });
    expect(res.stderr).toContain('Unknown audio quality');
    expect(res.stdout).toBe('');
  });

  it('honours VID2CONTEXT_DOWNLOADS=0', async () => {
    const res = await cli(['download', APOLLO, '--audio'], { env: { ...env, VID2CONTEXT_DOWNLOADS: '0' } });
    expect(res.code).not.toBe(0);
    expect(res.stderr).toContain('VID2CONTEXT_DOWNLOADS=0');
  });
});

describe.skipIf(!hasFfmpeg)('download a local file', () => {
  it('prints only the saved path on stdout and notes on stderr', async () => {
    const res = await cli(['download', APOLLO, '--audio', 'wav', '--from', '1', '--to', '3', '-d', tmp], { env });
    expect(res.code).toBe(0);
    const path = join(tmp, 'apollo11-small-step (0m01s-0m03s).wav');
    expect(res.stdout).toBe(`${path}\n`);
    expect(res.stderr).toContain('saved apollo11-small-step (0m01s-0m03s).wav');
    expect(readFileSync(path).subarray(0, 4).toString('latin1')).toBe('RIFF');
  });

  it('takes an optional audio format and keeps existing files unless --force', async () => {
    const first = await cli(['download', APOLLO, '--audio', '-d', tmp, '--json'], { env });
    expect(first.code).toBe(0);
    const out = JSON.parse(first.stdout) as { files: { filename: string; format: string }[] };
    expect(out.files[0]).toMatchObject({ filename: 'apollo11-small-step.mp3', format: 'mp3' });
    const second = await cli(['download', APOLLO, '--audio', '-d', tmp], { env });
    expect(second.stdout.trim().endsWith('apollo11-small-step (2).mp3')).toBe(true);
    const forced = await cli(['download', APOLLO, '--audio', '-d', tmp, '--force'], { env });
    expect(forced.stdout.trim().endsWith('apollo11-small-step.mp3')).toBe(true);
  });

  it('shows options with --info', async () => {
    const res = await cli(['download', APOLLO, '--info'], { env });
    expect(res.code).toBe(0);
    expect(res.stdout).toContain('Video: none (audio only)');
    expect(res.stdout).toContain('mp3  320');
  });
});

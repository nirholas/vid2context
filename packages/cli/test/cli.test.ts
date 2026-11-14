import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { formatters } from '@vid2context/core';
import { resetBreaker } from '@vid2context/provider-youtube';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { APOLLO, cli } from './helpers.ts';

const tmp = mkdtempSync(join(tmpdir(), 'v2c-cli-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
beforeEach(() => resetBreaker());

describe('get', () => {
  it('is the default command and prints a timestamped YouTube transcript', async () => {
    const res = await cli(['https://youtu.be/jNQXAC9IVRw', '--timestamps']);
    expect(res.code).toBe(0);
    expect(res.stdout.split('\n')[0]).toBe('[0:01] All right, so here we are, in front of the elephants');
    expect(res.stderr).toBe('');
    expect((await cli(['get', 'jNQXAC9IVRw', '-t'])).stdout).toBe(res.stdout);
  });

  it.each(Object.keys(formatters))('renders the %s format', async (format) => {
    const res = await cli(['get', 'jNQXAC9IVRw', '--format', format]);
    expect(res.code).toBe(0);
    expect(res.stdout.length).toBeGreaterThan(50);
    if (format === 'json') expect(JSON.parse(res.stdout).metadata.title).toBe('Me at the zoo');
    else if (format === 'srt') expect(res.stdout.startsWith('1\n00:00:01,')).toBe(true);
    else if (format === 'vtt') expect(res.stdout.startsWith('WEBVTT')).toBe(true);
    else expect(res.stdout).toContain('elephants');
  });

  it('--json is the json format and contradicts another --format', async () => {
    const res = await cli(['jNQXAC9IVRw', '--json']);
    expect(JSON.parse(res.stdout).transcript.origin).toBe('creator-captions');
    const bad = await cli(['jNQXAC9IVRw', '--json', '--format', 'srt']);
    expect(bad.code).toBe(2);
    expect(bad.stdout).toBe('');
  });

  it('transcribes a local file through the keyless speech-to-text rung', async () => {
    const res = await cli([APOLLO, '--format', 'json']);
    expect(res.code).toBe(0);
    const ctx = JSON.parse(res.stdout);
    expect(ctx.transcript).toMatchObject({ origin: 'stt', producer: 'stt/ovh/whisper-large-v3-turbo', language: 'en' });
  });

  it('passes --skip into the rung chain', async () => {
    const res = await cli([APOLLO, '--skip', 'ovh', '--verbose']);
    expect(res.code).toBe(6);
    expect(res.stderr).toContain('error (no-transcript)');
    expect(res.fetch.calls.some((c) => c.url.includes('audio/transcriptions'))).toBe(false);
  });

  it('writes --out instead of stdout and refuses to overwrite without --force', async () => {
    const out = join(tmp, 'zoo.txt');
    const first = await cli(['jNQXAC9IVRw', '--out', out]);
    expect(first.code).toBe(0);
    expect(first.stdout).toBe('');
    expect(first.stderr).toContain(`wrote ${out}`);
    expect(readFileSync(out, 'utf8')).toContain('elephants');

    const again = await cli(['jNQXAC9IVRw', '-o', out]);
    expect(again.code).toBe(2);
    expect(again.stderr).toContain('already exists');
    expect(again.fetch.calls).toHaveLength(0);

    writeFileSync(out, 'old');
    expect((await cli(['jNQXAC9IVRw', '-o', out, '--force', '--quiet'])).stderr).toBe('');
    expect(readFileSync(out, 'utf8')).toContain('elephants');
  });

  it('prints message and hint on failure, and the attempts only with --verbose', async () => {
    const res = await cli(['xxxxxxxxxxx']);
    expect(res.code).toBe(4);
    expect(res.stdout).toBe('');
    expect(res.stderr).toContain('error (not-found)');
    expect(res.stderr).toContain('hint: ');
    expect(res.stderr).not.toContain('Attempts:');
    const verbose = await cli(['xxxxxxxxxxx', '--verbose']);
    expect(verbose.stderr).toMatch(/metadata error +youtube/);
  });

  it('prints errors as JSON with the attempts under --json', async () => {
    const res = await cli(['xxxxxxxxxxx', '--json']);
    expect(res.stdout).toBe('');
    const { error } = JSON.parse(res.stderr);
    expect(error).toMatchObject({ code: 'not-found', exitCode: 4 });
    expect(error.attempts.map((a: { stage: string }) => a.stage)).toContain('metadata');
  });
});

describe('usage errors', () => {
  it('exits 2 with a closest-flag hint for unknown flags', async () => {
    const res = await cli(['jNQXAC9IVRw', '--fromat', 'json']);
    expect(res.code).toBe(2);
    expect(res.stderr).toContain('Unknown flag --fromat');
    expect(res.stderr).toContain('Did you mean --format?');
  });

  it('rejects flags that belong to another command, mistyped commands and bad values', async () => {
    const limit = await cli(['get', 'jNQXAC9IVRw', '--limit', '3']);
    expect(limit.code).toBe(2);
    expect(limit.stderr).toContain('It is a flag of: list, search, library');
    expect((await cli(['doctr'])).stderr).toContain('Did you mean `vid2context doctor`?');
    expect((await cli(['jNQXAC9IVRw', '--format', 'pdf'])).code).toBe(2);
    const mode = await cli(['jNQXAC9IVRw', '--mode', 'captins']);
    expect(mode.stderr).toContain('Did you mean captions?');
    expect((await cli(['jNQXAC9IVRw', 'second'])).code).toBe(2);
    expect((await cli([])).code).toBe(2);
  });
});

describe('help and version', () => {
  it('prints main help, every command help and the version on stdout', async () => {
    const main = await cli(['--help']);
    expect(main.code).toBe(0);
    for (const f of Object.keys(formatters)) expect(main.stdout).toContain(`  ${f} `);
    expect(main.stdout).toContain('Exit codes:');
    for (const cmd of ['get', 'list', 'library', 'collection', 'doctor', 'completion']) {
      const res = await cli([cmd, '--help']);
      expect(res.code).toBe(0);
      expect(res.stdout.startsWith(`vid2context ${cmd}:`)).toBe(true);
    }
    expect((await cli(['help', 'search'])).stdout).toContain('lives only for this process');
    expect((await cli(['-v'])).stdout).toBe('0.1.0\n');
  });
});

describe('list', () => {
  it('expands a recorded YouTube playlist, one URL per line', async () => {
    const res = await cli(['list', 'https://www.youtube.com/playlist?list=PLHeawKfarQSPKIjpe86at3Ttc2sz7uD_b', '--limit', '3']);
    expect(res.code).toBe(0);
    expect(res.stdout).toBe(
      [
        'https://www.youtube.com/watch?v=PzJL3aBRas8',
        'https://www.youtube.com/watch?v=1Xx1fmHIsiA',
        'https://www.youtube.com/watch?v=AS6LYBzFtEU',
        '',
      ].join('\n'),
    );
    expect(res.stderr).toBe('3 items\n');
  });

  it('prints refs as JSON and a single video as itself', async () => {
    const res = await cli([
      'list',
      'https://www.youtube.com/playlist?list=PLHeawKfarQSPKIjpe86at3Ttc2sz7uD_b',
      '--limit',
      '2',
      '--json',
    ]);
    expect(JSON.parse(res.stdout).map((r: { id: string }) => r.id)).toEqual(['youtube:PzJL3aBRas8', 'youtube:1Xx1fmHIsiA']);
    const one = await cli(['list', 'jNQXAC9IVRw', '-q']);
    expect(one.stdout).toBe('https://www.youtube.com/watch?v=jNQXAC9IVRw\n');
    expect(one.stderr).toBe('');
  });
});

describe('formats', () => {
  it('lists the formatters map at runtime', async () => {
    const res = await cli(['formats', '--json']);
    const rows = JSON.parse(res.stdout) as { id: string; multiVideo: boolean }[];
    expect(rows.map((r) => r.id)).toEqual(Object.keys(formatters));
    expect(rows.find((r) => r.id === 'pack')?.multiVideo).toBe(true);
    const text = await cli(['formats']);
    expect(text.stdout.split('\n')[0]).toMatch(/^ID +EXT +VIDEOS +DESCRIPTION$/);
  });
});

describe('pack and bundle', () => {
  it('packs several videos into one document', async () => {
    const res = await cli(['pack', 'jNQXAC9IVRw', 'cCPsdFdlshc', '--max-tokens', '20000']);
    expect(res.code).toBe(0);
    expect(res.stdout).toContain('Me at the zoo');
    expect(res.stdout).toContain('G-Wagon');
  });

  it('keeps going when one input fails and exits with its code', async () => {
    const res = await cli(['pack', 'jNQXAC9IVRw', 'xxxxxxxxxxx']);
    expect(res.code).toBe(4);
    expect(res.stdout).toContain('Me at the zoo');
    expect(res.stderr).toContain('skipped https://www.youtube.com/watch?v=xxxxxxxxxxx');
  });

  it('writes a zip bundle to --out and requires it', async () => {
    expect((await cli(['bundle', 'jNQXAC9IVRw'])).code).toBe(2);
    const out = join(tmp, 'zoo.zip');
    const res = await cli(['bundle', 'jNQXAC9IVRw', '-o', out, '--json']);
    expect(res.code).toBe(0);
    expect(existsSync(out)).toBe(true);
    const zip = readFileSync(out);
    expect(zip.subarray(0, 4).toString('hex')).toBe('504b0304');
    expect(zip.includes(Buffer.from('context.md'))).toBe(true);
    const manifest = JSON.parse(res.stdout);
    expect(manifest.videos[0]).toMatchObject({ id: 'youtube:jNQXAC9IVRw', title: 'Me at the zoo' });
  });
});

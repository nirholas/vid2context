import { readFileSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createContext, Vid2ContextError } from '@vid2context/core';
import { replayFetch, testContext } from '@vid2context/core/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { managedPath, readVersion, selfUpdate, versionAgeDays } from '../src/binary.ts';
import { errorFromStderr, suggestsUpdate } from '../src/errors.ts';
import { ytdlp } from '../src/run.ts';

// Recorded stderr (see test/fixtures/README.md).
const fixture = (name: string) => readFileSync(join(import.meta.dirname, 'fixtures', name), 'utf8');
const location = /location: (\S+)/.exec(fixture('releases-latest-head.txt'))?.[1] ?? '';
const latestRedirect = {
  method: 'HEAD',
  url: 'https://github.com/yt-dlp/yt-dlp/releases/latest',
  response: { status: 302, headers: { location }, body: '' },
};

const homes: string[] = [];
async function home(meta?: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'v2c-ytdlp-update-'));
  homes.push(dir);
  await mkdir(join(dir, 'bin'), { recursive: true });
  if (meta) await writeFile(join(dir, 'bin', 'yt-dlp.json'), JSON.stringify(meta));
  return dir;
}
afterEach(async () => {
  await Promise.all(homes.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

const META = {
  version: '2026.10.26',
  asset: 'yt-dlp_linux',
  sha256: '767ba9dce7052aa196f8b12652f433d76de128ba168966fa84b6394d5e6c6795',
  installedAt: '2026-11-14T17:17:45.912Z',
  checkedAt: '2026-11-14T17:17:45.912Z',
};

describe('suggestsUpdate on recorded yt-dlp failures', () => {
  it('flags extractor breakage that yt-dlp says a newer release may fix', () => {
    for (const name of ['stderr-outdated-youtube-no-formats.txt', 'stderr-outdated-vimeo-406.txt']) {
      const stderr = fixture(name);
      const err = errorFromStderr(stderr, 'yt-dlp metadata', 1);
      expect(err.code).toBe('upstream');
      expect(suggestsUpdate(stderr, err)).toBe(true);
    }
  });

  it('leaves alone failures an update cannot fix', () => {
    for (const name of [
      'stderr-unsupported-url.txt',
      'stderr-video-unavailable.txt',
      'stderr-subtitles-429.txt',
      'stderr-vimeo-login.txt',
    ]) {
      const stderr = fixture(name);
      expect(suggestsUpdate(stderr, errorFromStderr(stderr, 'yt-dlp metadata', 1))).toBe(false);
    }
  });
});

describe('selfUpdate', () => {
  it('records the check and reports when the managed copy is already the latest release', async () => {
    const dir = await home(META);
    const ctx = testContext({ env: { VID2CONTEXT_HOME: dir }, fetch: replayFetch([latestRedirect]) });
    const res = await selfUpdate(ctx, managedPath(ctx.env));
    expect(res).toMatchObject({ outcome: 'latest', from: '2026.10.26', to: '2026.10.26' });
    expect(res.hint).toContain('already the latest release');
    const meta = JSON.parse(await readFile(join(dir, 'bin', 'yt-dlp.json'), 'utf8')) as { selfUpdateAt?: string };
    expect(Date.now() - Date.parse(meta.selfUpdateAt ?? '')).toBeLessThan(60_000);
  });

  it('tries at most once per YTDLP_SELF_UPDATE_MIN_SEC, without touching the network', async () => {
    const dir = await home({ ...META, selfUpdateAt: new Date().toISOString() });
    // No recorded responses: any fetch would fail the update instead of returning too-soon.
    const ctx = testContext({ env: { VID2CONTEXT_HOME: dir }, fetch: replayFetch([]) });
    const res = await selfUpdate(ctx, managedPath(ctx.env));
    expect(res.outcome).toBe('too-soon');
    expect(res.hint).toContain('YTDLP_SELF_UPDATE_MIN_SEC');
    const again = testContext({
      env: { VID2CONTEXT_HOME: dir, YTDLP_SELF_UPDATE_MIN_SEC: '0' },
      fetch: replayFetch([latestRedirect]),
    });
    expect((await selfUpdate(again, managedPath(again.env))).outcome).toBe('latest');
  });

  it('never updates a binary the user supplied, and honours YTDLP_AUTO_UPDATE=0', async () => {
    const dir = await home(META);
    const ctx = testContext({ env: { VID2CONTEXT_HOME: dir }, fetch: replayFetch([]) });
    const res = await selfUpdate(ctx, '/usr/local/bin/yt-dlp');
    expect(res.outcome).toBe('not-managed');
    expect(res.hint).toContain('yt-dlp -U');
    const off = testContext({ env: { VID2CONTEXT_HOME: dir, YTDLP_AUTO_UPDATE: '0' }, fetch: replayFetch([]) });
    expect((await selfUpdate(off, managedPath(off.env))).outcome).toBe('disabled');
  });

  it('reads the age of date versions', () => {
    const now = Date.UTC(2026, 10, 15);
    expect(versionAgeDays('2026.10.26', now)).toBe(20);
    expect(versionAgeDays('2026.10.26.233422', now)).toBe(20);
    expect(versionAgeDays('unknown', now)).toBeUndefined();
  });
});

// Live: an outdated managed yt-dlp (2023.03.04, which fails on YouTube today with
// "No video formats found!; please report this issue ... yt-dlp -U") updates itself
// on the first failure and the same call then succeeds or fails for another reason.
describe.skipIf(!process.env.LIVE)('self-update against GitHub and YouTube (live)', () => {
  it('replaces an outdated managed binary and retries the call', { timeout: 600_000 }, async () => {
    const old = process.env.YTDLP_OLD_BINARY;
    if (!old) throw new Error('Set YTDLP_OLD_BINARY to a yt-dlp 2023.03.04 yt-dlp_linux binary for this test.');
    const dir = await home();
    const env: Record<string, string> = { ...(process.env as Record<string, string>), VID2CONTEXT_HOME: dir };
    delete env.YTDLP_PATH;
    const ctx = createContext({ runtime: 'node', env, fetch: globalThis.fetch.bind(globalThis) });
    const bin = managedPath(env);
    await copyFile(old, bin);
    const before = await readVersion(bin, ctx);
    await writeFile(join(dir, 'bin', 'yt-dlp.json'), JSON.stringify({ ...META, version: before }));
    const args = ['-J', '--no-download', '--no-playlist', '--no-warnings', '--', 'https://www.youtube.com/watch?v=jNQXAC9IVRw'];
    try {
      const out = await ytdlp(ctx, bin, args, 'metadata');
      expect(JSON.parse(out).id).toBe('jNQXAC9IVRw');
    } catch (err) {
      // Updated, but this IP may still be blocked by YouTube: the hint must say it was updated.
      expect(err).toBeInstanceOf(Vid2ContextError);
      expect((err as Vid2ContextError).hint).toContain('updated from');
    }
    expect(await readVersion(bin, ctx)).not.toBe(before);
  });
});

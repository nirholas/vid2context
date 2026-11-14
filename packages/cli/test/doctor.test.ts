import { chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { replayFetch, testContext } from '@vid2context/core/testing';
import { resetBreaker } from '@vid2context/provider-youtube';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  checkDataDir,
  checkGpu,
  checkKeyless,
  checkKeys,
  checkLocalServers,
  checkNode,
  checkTool,
  checkYouTube,
  parseFfVersion,
  TOOLS,
} from '../src/doctor/checks.ts';
import { dataDir, findBinary, keyNames, probeKeyless, probeLocalServers, probeYouTube, renderChecks } from '../src/doctor/run.ts';
import { fixture, read, registry, routes } from './helpers.ts';

const tmp = mkdtempSync(join(tmpdir(), 'v2c-doctor-'));
afterAll(() => {
  chmodSync(tmp, 0o700);
  rmSync(tmp, { recursive: true, force: true });
});
beforeEach(() => resetBreaker());

describe('pure checks on captured outputs', () => {
  it('parses real ffmpeg and ffprobe -version output', () => {
    expect(parseFfVersion(fixture('ffmpeg-version.txt'))).toBe('7.0.2-static');
    expect(parseFfVersion(fixture('ffprobe-version.txt'))).toBe('7.0.2-static');
    const ok = checkTool(TOOLS.ffmpeg, { path: '/home/u/.local/bin/ffmpeg', output: fixture('ffmpeg-version.txt') });
    expect(ok).toMatchObject({ status: 'ok', detail: '7.0.2-static at /home/u/.local/bin/ffmpeg' });
  });

  it('reads the real yt-dlp --version output', () => {
    const res = checkTool(TOOLS.ytdlp, { path: '/x/yt-dlp', output: fixture('ytdlp-version.txt') });
    expect(res.detail).toBe('2026.10.26 at /x/yt-dlp');
  });

  it('warns for a missing tool, fails for a broken configured path or version command', () => {
    expect(checkTool(TOOLS.ytdlp, {})).toMatchObject({ status: 'warn', fix: expect.stringContaining('YTDLP_PATH') });
    expect(checkTool(TOOLS.ffmpeg, { problem: 'FFMPEG_PATH is set to /nope' }).status).toBe('fail');
    expect(checkTool(TOOLS.deno, { path: '/usr/bin/deno' }).status).toBe('fail');
  });

  it('checks the Node version', () => {
    expect(checkNode('v24.22.2').status).toBe('ok');
    expect(checkNode('v22.0.0').status).toBe('ok');
    expect(checkNode('v20.11.1')).toMatchObject({ status: 'fail', fix: expect.stringContaining('Node 22') });
  });

  it('reports a missing GPU as an optional warning', () => {
    expect(checkGpu(null)).toMatchObject({ status: 'warn', detail: expect.stringContaining('nvidia-smi not found') });
    expect(checkGpu('').detail).toBe('nvidia-smi found no GPU');
  });

  it('lists key names, never values', () => {
    expect(checkKeys(['GROQ_API_KEY'], ['GEMINI_API_KEY', 'GROQ_API_KEY']).detail).toBe('1 of 2 set: GROQ_API_KEY');
    expect(checkKeys([], ['GROQ_API_KEY']).detail).toContain('none of 1 set');
    const env = { GROQ_API_KEY: 'gsk_abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGH' };
    const names = keyNames(registry(), env);
    expect(names.set).toEqual(['GROQ_API_KEY']);
    expect(names.known).toContain('OPENAI_API_KEY');
  });

  it('judges the keyless probe', () => {
    expect(checkKeyless({ status: 200, body: fixture('ovh-models.json') }, true)).toMatchObject({
      status: 'ok',
      detail: 'OVH AI Endpoints reachable (21 models listed)',
    });
    expect(checkKeyless({ status: 429, body: '' }, true).status).toBe('warn');
    expect(checkKeyless({ error: 'getaddrinfo ENOTFOUND' }, true).status).toBe('warn');
    expect(checkKeyless({}, false).detail).toContain('VID2CONTEXT_KEYLESS=0');
  });
});

describe('probes through recorded responses', () => {
  it('reaches the keyless models list', async () => {
    const obs = await probeKeyless(testContext({ fetch: replayFetch(routes()) }));
    expect(obs.status).toBe(200);
    expect(checkKeyless(obs, true).status).toBe('ok');
  });

  it('fetches captions for jNQXAC9IVRw', async () => {
    const obs = await probeYouTube(registry(), testContext({ fetch: replayFetch(routes()) }));
    expect(checkYouTube(obs)).toMatchObject({ status: 'ok', detail: 'fetched 6 creator-captions segments for jNQXAC9IVRw' });
  });

  it('reports no local servers when every localhost probe fails, with a setup hint', async () => {
    // replayFetch with no routes rejects every request, as a machine with nothing listening does.
    const obs = await probeLocalServers(testContext({ fetch: replayFetch([]) }));
    expect(obs.error).toBeUndefined();
    const check = checkLocalServers(obs);
    expect(check).toMatchObject({ status: 'warn', detail: 'none found on the usual local ports (optional)' });
    expect(check.fix).toMatch(/^No local model server found\. Install Ollama .*, then run: ollama pull \S+/);
    expect(checkLocalServers({ servers: [], suggestions: [], error: 'boom' }).fix).toContain('stt-whisper-cpp/src/setup.ts');
  });

  it('detects an IP block from the real 429 page and prints the hint', async () => {
    const blocked = replayFetch(
      routes([
        {
          url: /timedtext\?v=jNQXAC9IVRw/,
          response: { status: 429, body: read('providers/youtube/test/fixtures/timedtext-429-blocked.html') },
        },
      ]),
    );
    const check = checkYouTube(await probeYouTube(registry(), testContext({ fetch: blocked })));
    expect(check.status).toBe('fail');
    expect(check.detail).toContain("YouTube is blocking this machine's IP (blocked)");
    expect(check.fix).toContain('IP address');
  });
});

describe('local checks', () => {
  it('uses VID2CONTEXT_HOME or ./.vid2context and probes writability', () => {
    expect(dataDir({ VID2CONTEXT_HOME: 'data' }, '/srv')).toBe('/srv/data');
    expect(dataDir({}, '/srv')).toBe('/srv/.vid2context');
    expect(checkDataDir(tmp).status).toBe('ok');
    expect(checkDataDir('/x', 'EACCES').status).toBe('fail');
  });

  it('flags a configured binary path that is not executable', () => {
    expect(findBinary('ffmpeg', { FFMPEG_PATH: join(tmp, 'nope') }, tmp, 'FFMPEG_PATH').problem).toContain('not an executable');
    expect(findBinary('definitely-not-a-binary-v2c', { PATH: tmp }, tmp)).toEqual({});
  });

  it('renders each check with its fix line and a summary', () => {
    const text = renderChecks([checkNode('v24.0.0'), checkGpu(null), checkNode('v18.0.0')]);
    expect(text).toContain('fix: Optional.');
    expect(text.trimEnd().split('\n').at(-1)).toBe('3 checks: 1 ok, 1 warn, 1 fail');
  });
});

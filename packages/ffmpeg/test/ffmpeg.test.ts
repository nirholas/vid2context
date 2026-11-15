import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createContext, Vid2ContextError } from '@vid2context/core';
import { testContext } from '@vid2context/core/testing';
import { afterAll, describe, expect, it } from 'vitest';
import {
  btbnPlatform,
  downloadFfmpeg,
  extractAudio,
  extractFrames,
  extractSubtitles,
  findTools,
  locateFfmpeg,
  NetworkCrashError,
  pickBtbnAsset,
  planCuts,
  probe,
  runProcess,
  splitOnSilence,
  toBcp47,
  toInput,
  withFileLock,
  withToolsFor,
} from '../src/index.ts';

const FIX = join(import.meta.dirname, 'fixtures');
const MP4 = join(FIX, 'apollo11-first-steps.mp4');
const MKV = join(FIX, 'apollo11-first-steps-subs.mkv');
const M4A = join(FIX, 'apollo11-first-steps-chapters.m4a');
const APOLLO_MP3 = resolve(import.meta.dirname, '../../../tests/fixtures/media/apollo11-small-step.mp3');

// Tests are not providers: reading PATH from the test process is how they find the real ffmpeg.
const ENV = { PATH: process.env.PATH, VID2CONTEXT_FFMPEG_DOWNLOAD: '0' };
const found = findTools(ENV);
const HAVE_FFMPEG = Boolean(found.ffmpeg && found.ffprobe && !found.problem);
if (!HAVE_FFMPEG) console.error(`[ffmpeg tests] skipping ffmpeg-dependent tests: ${found.problem}`);
const ctx = () => testContext({ env: ENV });

/** ffprobe's own duration for a file, for comparison. */
function ffprobeDuration(file: string): number {
  const out = execFileSync(found.ffprobe as string, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file]);
  return Number(out.toString().trim());
}
function ffprobeStream(file: string): { codec_name: string; sample_rate: string; channels: number } {
  const out = execFileSync(found.ffprobe as string, ['-v', 'error', '-show_streams', '-of', 'json', file]);
  return JSON.parse(out.toString()).streams[0];
}

const temps: string[] = [];
function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'v2c-ffmpeg-test-'));
  temps.push(d);
  return d;
}
afterAll(() => {
  for (const d of temps) rmSync(d, { recursive: true, force: true });
});

describe('input safety', () => {
  it('refuses inputs that look like options or ffmpeg protocols', () => {
    expect(() => toInput('-i')).toThrow(Vid2ContextError);
    expect(() => toInput('-filter_complex')).toThrow(/starts with "-"/);
    expect(() => toInput('concat:a.mp3|b.mp3')).toThrow(/scheme/);
    expect(() => toInput('pipe:0')).toThrow(/scheme/);
    expect(() => toInput('')).toThrow(Vid2ContextError);
  });

  it('passes http(s) URLs through and makes paths absolute', () => {
    expect(toInput('https://example.org/a.m3u8')).toBe('https://example.org/a.m3u8');
    expect(toInput('./talk.mp4')).toBe(resolve('talk.mp4'));
    expect(toInput('dir/-odd.mp4')).toBe(resolve('dir/-odd.mp4'));
  });
});

describe('locate', () => {
  it('treats a missing FFMPEG_PATH as an error with a fix-it hint and never downloads', async () => {
    const env = { FFMPEG_PATH: '/nonexistent/ffmpeg', PATH: process.env.PATH };
    expect(findTools(env).problem).toMatch(/FFMPEG_PATH/);
    const err = await locateFfmpeg({ env }, { download: true }).catch((e) => e);
    expect(err).toBeInstanceOf(Vid2ContextError);
    expect(err).toMatchObject({ code: 'unavailable', hint: expect.stringMatching(/FFMPEG_PATH/) });
  });

  it.skipIf(!HAVE_FFMPEG)('finds ffmpeg and ffprobe and reports the version from ffmpeg -version', async () => {
    const tools = await locateFfmpeg({ env: ENV });
    const first = execFileSync(tools.ffmpeg, ['-version']).toString().split('\n')[0] ?? '';
    expect(first).toContain(`ffmpeg version ${tools.version}`);
    expect(['path', 'local-bin', 'managed', 'env']).toContain(tools.source);
  });
});

describe('managed download source', () => {
  // Real checksums.sha256 from the BtbN/FFmpeg-Builds "latest" release (test/fixtures/README.md).
  const sums = readFileSync(join(FIX, 'btbn-checksums.sha256'), 'utf8');

  it('picks the newest release-branch GPL build for each Linux arch, never a nightly', () => {
    const x64 = pickBtbnAsset(sums, 'linux64');
    expect(x64).toMatchObject({ name: 'ffmpeg-n9.0-latest-linux64-gpl-9.0.tar.xz', version: '9.0' });
    expect(x64?.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(x64?.url).toBe(
      'https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-n9.0-latest-linux64-gpl-9.0.tar.xz',
    );
    expect(pickBtbnAsset(sums, 'linuxarm64')?.name).toBe('ffmpeg-n9.0-latest-linuxarm64-gpl-9.0.tar.xz');
    expect(sums).toContain(`${x64?.sha256}  ${x64?.name}`);
  });

  it('refuses platforms without a checksummed source, with an install hint', async () => {
    expect(btbnPlatform('linux', 'x64')).toBe('linux64');
    expect(btbnPlatform('darwin', 'arm64')).toBeNull();
    expect(btbnPlatform('linux', 'ia32')).toBeNull();
    const err = await downloadFfmpeg({ env: {} }, { platform: 'darwin', arch: 'arm64' }).catch((e) => e);
    expect(err).toMatchObject({ code: 'unavailable', hint: expect.stringMatching(/brew install ffmpeg/) });
  });
});

describe('file lock', () => {
  it('serialises holders and takes over a lock whose owner is gone', async () => {
    const dir = tempDir();
    const lock = join(dir, 'locks', 'test.lock');
    const order: string[] = [];
    const hold = (name: string) =>
      withFileLock(
        lock,
        async () => {
          order.push(`${name}:in`);
          await new Promise((r) => setTimeout(r, 50));
          order.push(`${name}:out`);
        },
        { pollMs: 10 },
      );
    await Promise.all([hold('a'), hold('b')]);
    expect(order).toEqual(order[0] === 'a:in' ? ['a:in', 'a:out', 'b:in', 'b:out'] : ['b:in', 'b:out', 'a:in', 'a:out']);

    // A pid that cannot exist: the lock is stale and gets taken over at once.
    writeFileSync(lock, '2147483646\n2026-11-14T00:00:00.000Z\n');
    expect(await withFileLock(lock, async () => 'taken', { timeoutMs: 1000, pollMs: 10 })).toBe('taken');
  });
});

describe('toBcp47', () => {
  it('maps container language tags to BCP-47', () => {
    expect(toBcp47('eng')).toBe('en');
    expect(toBcp47('fre')).toBe('fr');
    expect(toBcp47('pt-br')).toBe('pt-BR');
    expect(toBcp47('und')).toBeUndefined();
    expect(toBcp47('')).toBeUndefined();
  });
});

describe('planCuts', () => {
  it('cuts at the silence nearest the target and keeps every chunk under the limit', () => {
    const plan = planCuts(
      100,
      [
        { startSec: 28, endSec: 29 },
        { startSec: 61, endSec: 62 },
      ],
      { maxChunkSec: 40, targetSec: 30, overlapSec: 2 },
    );
    // 61.5 to 100 is longer than one chunk may be, so a third cut falls at the target (no silence there).
    expect(plan.map((c) => c.endSec)).toEqual([28.5, 61.5, 91.5, 100]);
    expect(plan.map((c) => c.overlapSec)).toEqual([0, 2, 2, 2]);
    for (const c of plan) expect(c.endSec - c.startSec).toBeLessThanOrEqual(40);
  });

  it('refuses a byte limit too small for the overlap', () => {
    expect(() => planCuts(100, [], { maxChunkSec: 2, overlapSec: 2 })).toThrow(/overlap/);
  });
});

describe.skipIf(!HAVE_FFMPEG)('with ffmpeg', () => {
  it('probes duration within 0.1 s of ffprobe, plus streams and tags', async () => {
    const p = await probe(MP4, ctx());
    expect(Math.abs((p.durationSec ?? 0) - ffprobeDuration(MP4))).toBeLessThan(0.1);
    expect(p.container).toContain('mp4');
    expect(p.tags).toMatchObject({ title: 'Apollo 11 Landing - first steps on the moon', artist: 'NASA', date: '1969' });
    expect(p.streams.find((s) => s.type === 'video')).toMatchObject({ codec: 'h264', width: 160, height: 120 });
    expect(p.streams.find((s) => s.type === 'audio')).toMatchObject({ codec: 'aac', channels: 1, sampleRate: 22050 });
  });

  it('reads container chapters and stream languages', async () => {
    const p = await probe(M4A, ctx());
    expect(p.chapters.map((c) => c.title)).toEqual([
      'At the foot of the ladder',
      'Describing the surface',
      'Stepping off the LEM',
      'One small step',
    ]);
    expect(p.chapters.map((c) => c.startSec)).toEqual([0, 3.26, 36.746, 47.772]);
    expect(p.streams[0]).toMatchObject({ type: 'audio', language: 'en', languageTag: 'eng' });
    const mkv = await probe(MKV, ctx());
    expect(mkv.streams.find((s) => s.type === 'subtitle')).toMatchObject({ codec: 'subrip', language: 'en' });
  });

  it('maps unreadable media to unavailable', async () => {
    const dir = tempDir();
    const bogus = join(dir, 'checksums.mp4');
    writeFileSync(bogus, readFileSync(join(FIX, 'btbn-checksums.sha256')));
    await expect(probe(bogus, ctx())).rejects.toMatchObject({ code: 'unavailable' });
  });

  it('extracts 16 kHz mono mp3 and flac from a video', async () => {
    const mp3 = await extractAudio(MP4, {}, ctx());
    expect(mp3).toMatchObject({ kind: 'bytes', mimeType: 'audio/mpeg', filename: 'apollo11-first-steps.mp3' });
    expect(Math.abs(mp3.durationSec - ffprobeDuration(MP4))).toBeLessThan(0.2);
    // 32 kbps: about 4 KB per second.
    expect(mp3.data.byteLength).toBeGreaterThan(61 * 3500);
    expect(mp3.data.byteLength).toBeLessThan(61 * 4500);
    const dir = tempDir();
    writeFileSync(join(dir, 'a.mp3'), mp3.data);
    expect(ffprobeStream(join(dir, 'a.mp3'))).toMatchObject({ codec_name: 'mp3', sample_rate: '16000', channels: 1 });

    const flac = await extractAudio(MP4, { format: 'flac', startSec: 47, durationSec: 9 }, ctx());
    writeFileSync(join(dir, 'a.flac'), flac.data);
    expect(ffprobeStream(join(dir, 'a.flac'))).toMatchObject({ codec_name: 'flac', sample_rate: '16000', channels: 1 });
    expect(Math.abs(flac.durationSec - 9)).toBeLessThan(0.1);
  });

  it('says so when a video has no audio track', async () => {
    const dir = tempDir();
    const silent = join(dir, 'video-only.mp4');
    execFileSync(found.ffmpeg as string, ['-v', 'error', '-i', MP4, '-an', '-c', 'copy', silent]);
    await expect(extractAudio(silent, {}, ctx())).rejects.toMatchObject({ code: 'unavailable', message: /no audio track/ });
  });

  it('splits real speech into chunks under maxBytes whose durations add up to the source', async () => {
    const data = new Uint8Array(readFileSync(APOLLO_MP3));
    const audio = { kind: 'bytes' as const, data, mimeType: 'audio/mpeg', filename: 'apollo11-small-step.mp3' };
    expect(splitOnSilence.id).toBe('ffmpeg-silence');
    expect(splitOnSilence.canSplit(audio)).toBe(true);
    expect(splitOnSilence.canSplit({ kind: 'url', url: 'https://example.org/a.mp3' })).toBe(false);
    const maxBytes = 40_000;
    const chunks = [];
    for await (const c of splitOnSilence.split(audio, { maxBytes, targetSec: 6, overlapSec: 1 }, ctx())) chunks.push(c);
    const source = ffprobeDuration(APOLLO_MP3);
    expect(chunks.length).toBeGreaterThanOrEqual(3);
    expect(chunks[0]).toMatchObject({ index: 0, startSec: 0, overlapSec: 0 });
    const dir = tempDir();
    for (const [i, c] of chunks.entries()) {
      expect(c.index).toBe(i);
      expect(c.audio.data.byteLength).toBeLessThanOrEqual(maxBytes);
      expect(c.audio.filename).toBe(`apollo11-small-step.part${String(i + 1).padStart(3, '0')}.mp3`);
      if (i > 0) {
        const prev = chunks[i - 1] as (typeof chunks)[number];
        expect(c.overlapSec).toBe(1);
        expect(c.startSec + c.overlapSec).toBeCloseTo(prev.startSec + prev.durationSec, 6);
      }
      // The encoded chunk really is as long as reported (mp3 encoder padding is about 50 ms).
      const file = join(dir, c.audio.filename);
      writeFileSync(file, c.audio.data);
      expect(Math.abs(ffprobeDuration(file) - c.durationSec)).toBeLessThan(0.15);
    }
    const covered = chunks.reduce((sum, c) => sum + c.durationSec - c.overlapSec, 0);
    expect(Math.abs(covered - source)).toBeLessThan(0.05);
  });

  it('extracts an embedded subtitle stream as valid WebVTT', async () => {
    const vtt = await extractSubtitles(MKV, undefined, ctx());
    expect(vtt.startsWith('WEBVTT')).toBe(true);
    // ffmpeg writes MM:SS.mmm when the hour is zero, which WebVTT allows.
    const cues = vtt.match(/^(\d{2}:)?\d{2}:\d{2}\.\d{3} --> (\d{2}:)?\d{2}:\d{2}\.\d{3}/gm) ?? [];
    expect(cues).toHaveLength(7);
    expect(cues[0]).toBe('00:00.500 --> 00:03.260');
    expect(vtt).toContain('one giant leap for mankind.');
    expect(await extractSubtitles(MKV, 2, ctx())).toBe(vtt);
    await expect(extractSubtitles(MKV, 0, ctx())).rejects.toMatchObject({ code: 'bad-request' });
    await expect(extractSubtitles(MP4, undefined, ctx())).rejects.toMatchObject({ code: 'unavailable' });
  });

  it('extracts JPEG frames with increasing timestamps, every N seconds or on scene changes', async () => {
    const frames = await extractFrames(MP4, { everySec: 10, maxFrames: 5, width: 160 }, ctx());
    expect(frames.map((f) => f.atSec)).toEqual([0, 10, 20, 30, 40]);
    for (const f of frames) {
      expect(f.mimeType).toBe('image/jpeg');
      expect([f.data[0], f.data[1]]).toEqual([0xff, 0xd8]);
    }
    const scenes = await extractFrames(MP4, { sceneThreshold: 0.2, maxFrames: 8, width: 120 }, ctx());
    expect(scenes.length).toBeGreaterThanOrEqual(1);
    expect(scenes[0]?.atSec).toBe(0);
    for (let i = 1; i < scenes.length; i++) expect(scenes[i]?.atSec).toBeGreaterThan(scenes[i - 1]?.atSec ?? 0);
  });

  it('kills the child process on abort and on timeout, leaving nothing running', async () => {
    const alive = (pid: number) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    // -re reads the 61 s video in real time, so the process is still running when we stop it.
    const args = ['-hide_banner', '-nostdin', '-loglevel', 'error', '-re', '-i', MP4, '-f', 'null', '-'];
    const ac = new AbortController();
    let pid = 0;
    const run = runProcess(found.ffmpeg as string, args, {
      label: 'test',
      signal: ac.signal,
      onSpawn: (p) => {
        pid = p;
      },
    });
    setTimeout(() => ac.abort(), 300);
    await expect(run).rejects.toMatchObject({ name: 'AbortError' });
    await new Promise((r) => setTimeout(r, 200));
    expect(pid).toBeGreaterThan(0);
    expect(alive(pid)).toBe(false);

    let pid2 = 0;
    const timed = runProcess(found.ffmpeg as string, args, {
      label: 'test',
      timeoutMs: 300,
      onSpawn: (p) => {
        pid2 = p;
      },
    });
    await expect(timed).rejects.toMatchObject({ code: 'timeout' });
    await new Promise((r) => setTimeout(r, 200));
    expect(alive(pid2)).toBe(false);

    const pre = new AbortController();
    pre.abort();
    await expect(extractAudio(MP4, {}, testContext({ env: ENV, signal: pre.signal }))).rejects.toMatchObject({
      name: 'AbortError',
    });
  });
});

/** Serve the Apollo mp3 over loopback HTTP (never the network) on a port in 20000-29999. */
async function serveApollo(): Promise<{ url: string; server: Server }> {
  const body = readFileSync(APOLLO_MP3);
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'audio/mpeg', 'content-length': body.byteLength });
    res.end(body);
  });
  for (;;) {
    const port = 20000 + Math.floor(Math.random() * 10000);
    const ok = await new Promise<boolean>((done) => {
      server.once('error', () => done(false));
      server.listen(port, '127.0.0.1', () => done(true));
    });
    if (ok) return { url: `http://127.0.0.1:${port}/apollo11-small-step.mp3`, server };
  }
}

/** True when this ffmpeg build segfaults on any URL input (static glibc builds without nscd). Async: the server shares this process. */
function crashesOnUrls(ffmpeg: string, url: string): Promise<boolean> {
  return new Promise((done) => {
    const child = spawn(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-i', url, '-t', '1', '-f', 'null', '-'], {
      stdio: 'ignore',
      timeout: 30_000,
    });
    child.on('close', (_code, sig) => done(sig === 'SIGSEGV'));
  });
}

describe.skipIf(!HAVE_FFMPEG)('URL inputs', () => {
  it('reads an http URL, or reports a build that crashes on URLs and never swaps a pinned FFMPEG_PATH', async () => {
    const { url, server } = await serveApollo();
    try {
      const broken = await crashesOnUrls(found.ffmpeg as string, url);
      const pinned = { FFMPEG_PATH: found.ffmpeg as string, FFPROBE_PATH: found.ffprobe as string, VID2CONTEXT_HOME: tempDir() };
      const unpinned = { ...ENV, VID2CONTEXT_HOME: tempDir() };
      for (const env of [pinned, unpinned]) {
        const run = extractAudio(url, { format: 'mp3' }, testContext({ env }));
        if (broken) {
          // No managed copy in the empty home and downloads are off: the crash is reported with its fix.
          await expect(run).rejects.toBeInstanceOf(NetworkCrashError);
          await expect(run).rejects.toMatchObject({ hint: expect.stringContaining('FFMPEG_PATH') });
        } else {
          const audio = await run;
          expect(Math.abs(audio.durationSec - ffprobeDuration(APOLLO_MP3))).toBeLessThan(0.2);
        }
      }
      // Local paths always use the located build as is.
      const used = await withToolsFor(APOLLO_MP3, testContext({ env: unpinned }), {}, async (t) => t.source);
      expect(used).toBe(found.source);
    } finally {
      server.close();
    }
  });
});

describe.skipIf(!process.env.LIVE)('managed download (LIVE)', () => {
  it('downloads, verifies and installs a working ffmpeg into VID2CONTEXT_HOME', { timeout: 15 * 60_000 }, async () => {
    if (!btbnPlatform()) return;
    const home = tempDir();
    const live = createContext({ runtime: 'node', env: { VID2CONTEXT_HOME: home, PATH: '' } });
    const [a, b] = await Promise.all([downloadFfmpeg(live), downloadFfmpeg(live)]);
    expect(a.ffmpeg).toBe(join(home, 'bin', 'ffmpeg'));
    expect(b.ffmpeg).toBe(a.ffmpeg);
    expect(execFileSync(a.ffmpeg, ['-version']).toString()).toMatch(/^ffmpeg version n?\d/);
    expect(JSON.parse(readFileSync(join(home, 'bin', 'ffmpeg.json'), 'utf8'))).toMatchObject({
      license: expect.stringContaining('GPL'),
    });
    const p = await probe(MP4, { env: { FFMPEG_PATH: a.ffmpeg, FFPROBE_PATH: a.ffprobe } });
    expect(p.durationSec).toBeGreaterThan(61);
  });
  it('switches URL inputs to the managed build when the system ffmpeg crashes on them', { timeout: 15 * 60_000 }, async () => {
    if (!btbnPlatform()) return;
    const { url, server } = await serveApollo();
    try {
      const home = tempDir();
      const env = { PATH: process.env.PATH, VID2CONTEXT_HOME: home };
      const broken = await crashesOnUrls(found.ffmpeg as string, url);
      const audio = await extractAudio(url, { format: 'mp3' }, testContext({ env }));
      expect(Math.abs(audio.durationSec - ffprobeDuration(APOLLO_MP3))).toBeLessThan(0.2);
      const p = await probe(url, testContext({ env }));
      expect(p.streams.some((s) => s.type === 'audio')).toBe(true);
      // The managed build is only fetched when the system one could not read the URL.
      expect(existsSync(join(home, 'bin', 'ffmpeg'))).toBe(broken);
    } finally {
      server.close();
    }
  });
});

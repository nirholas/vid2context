/**
 * Stall protection on real child processes: a Node child that prints nothing
 * (a hung download), one that keeps writing (an oversized file), the real
 * ffmpeg converting the Apollo 11 clip under a byte cap, the disk preflight
 * against this machine's real free space, and size estimates from recorded
 * yt-dlp info.
 */
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Vid2ContextError } from '@vid2context/core';
import { testContext } from '@vid2context/core/testing';
import { locateFfmpeg, tryLocateFfmpeg } from '@vid2context/ffmpeg';
import { run } from '@vid2context/provider-ytdlp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { estimateBytes } from '../src/estimate.ts';
import { type MediaInfo, mediaOptions } from '../src/formats.ts';
import { toolkitLimits } from '../src/limits.ts';
import { freeBytes, preflightDisk } from '../src/node/disk.ts';
import { runFfmpeg } from '../src/node/local.ts';
import { folderBytes, Watchdog } from '../src/node/watchdog.ts';
import { normalizeRequest } from '../src/options.ts';
import { downloadPolicy } from '../src/policy.ts';
import { ProgressTracker } from '../src/progress.ts';

const APOLLO = new URL('../../../tests/fixtures/media/apollo11-small-step.mp3', import.meta.url).pathname;
const env = { PATH: process.env.PATH, HOME: process.env.HOME };
const hasFfmpeg = !!(await tryLocateFfmpeg({ env }).catch(() => null));
const bbb = JSON.parse(readFileSync(new URL('./fixtures/info-youtube-aqz-KE-bpKQ.json', import.meta.url), 'utf8')) as MediaInfo;

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'v2c-stall-'));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('processing progress', () => {
  it('reports the step from the bytes written, never 100 before the end', () => {
    const t = new ProgressTracker();
    t.apply({ type: 'download', status: 'finished', downloadedBytes: 1000, totalBytes: 1000, formatId: '140' });
    t.apply({ type: 'postprocess', status: 'started', step: 'ExtractAudio' });
    expect(t.progress).toMatchObject({ phase: 'processing', step: 'ExtractAudio', downloadedBytes: 1000 });
    expect(t.progress.percent).toBeUndefined();
    expect(t.processing(250, 500)).toBe(true);
    expect(t.progress.percent).toBe(50);
    t.processing(900, 500);
    expect(t.progress.percent).toBe(99);
  });
});

describe('download policy on public servers', () => {
  it('defaults to 1024 MB and 120 minutes there, and no limit locally', () => {
    expect(downloadPolicy({ VID2CONTEXT_PUBLIC: '1', VID2CONTEXT_DOWNLOADS: '1' })).toMatchObject({
      enabled: true,
      maxBytes: 1024 * 1024 * 1024,
      maxDurationSec: 120 * 60,
    });
    expect(downloadPolicy({})).toMatchObject({ enabled: true, maxBytes: 0, maxDurationSec: 0 });
  });
});

describe('limits', () => {
  it('has safe defaults, tighter on public servers, and reads overrides', () => {
    const local = toolkitLimits({});
    expect(local).toMatchObject({ stallSec: 120, stallRetries: 2, minFreeMb: 256, maxBatchItems: 500 });
    const pub = toolkitLimits({ VID2CONTEXT_PUBLIC: '1' });
    expect(pub).toMatchObject({ stallSec: 60, minFreeMb: 1024, maxBatchItems: 25, maxClipSec: 15, maxFrames: 20 });
    expect(toolkitLimits({ VID2CONTEXT_PUBLIC: '1', VID2CONTEXT_MAX_PLAYLIST_ITEMS: '80' }).maxBatchItems).toBe(80);
    expect(toolkitLimits({ VID2CONTEXT_DOWNLOAD_STALL_SEC: '3' }).stallSec).toBe(10);
    expect(toolkitLimits({ VID2CONTEXT_DOWNLOAD_STALL_SEC: 'x' }).stallSec).toBe(120);
  });
});

describe('watchdog on real processes', () => {
  const node = process.execPath;

  it('kills a child that stops reporting progress', async () => {
    const dog = new Watchdog({ label: 'test child', stallMs: 300, pollMs: 50 });
    const started = Date.now();
    const ctx = testContext({ env, signal: dog.signal });
    const err = await run(node, ['-e', 'setInterval(() => {}, 1000)'], ctx, { label: 'hung', timeoutMs: 20_000 }).catch(
      (e: unknown) => e,
    );
    dog.stop();
    expect(dog.tripped).toBe('stall');
    expect(err).toBeInstanceOf(Vid2ContextError);
    expect((err as Vid2ContextError).code).toBe('timeout');
    expect((err as Vid2ContextError).message).toContain('no progress');
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it('keeps a child alive while it reports progress', async () => {
    const dog = new Watchdog({ label: 'test child', stallMs: 400, pollMs: 50 });
    const ctx = testContext({ env, signal: dog.signal });
    const res = await run(
      node,
      ['-e', 'let n = 0; const t = setInterval(() => { console.log("tick", n); if (++n === 8) clearInterval(t); }, 100)'],
      ctx,
      { label: 'ticker', timeoutMs: 20_000, onStdoutLine: () => dog.touch() },
    );
    dog.stop();
    expect(res.code).toBe(0);
    expect(dog.tripped).toBeUndefined();
  });

  it('stops a child that writes past the size cap, by polling its folder', async () => {
    const out = join(dir, 'grow');
    const dog = new Watchdog({ label: 'writer', stallMs: 0, maxBytesOnDisk: 200_000, dir: out, pollMs: 50 });
    const script = `const fs = require('fs'); fs.mkdirSync(${JSON.stringify(out)}, { recursive: true }); const f = fs.openSync(${JSON.stringify(join(out, 'big.bin'))}, 'w'); setInterval(() => fs.writeSync(f, Buffer.alloc(65536)), 20);`;
    const err = await run(node, ['-e', script], testContext({ env, signal: dog.signal }), {
      label: 'writer',
      timeoutMs: 20_000,
    }).catch((e: unknown) => e);
    dog.stop();
    expect(dog.tripped).toBe('too-large');
    expect((err as Vid2ContextError).code).toBe('too-large');
    expect(await folderBytes(out)).toBeGreaterThan(200_000);
  });

  it('counts a growing work folder as progress, so a quiet but busy step is not killed', async () => {
    const out = join(dir, 'quiet');
    const sizes: number[] = [];
    const dog = new Watchdog({ label: 'quiet', stallMs: 400, dir: out, pollMs: 50, onPoll: (b) => sizes.push(b) });
    // Prints nothing for 1.5 s (more than three stall periods) while its output grows, like yt-dlp's ffmpeg post-processing.
    const script = `const fs = require('fs'); fs.mkdirSync(${JSON.stringify(out)}, { recursive: true }); const f = fs.openSync(${JSON.stringify(join(out, 'out.mp3'))}, 'w'); let n = 0; const t = setInterval(() => { fs.writeSync(f, Buffer.alloc(4096)); if (++n === 15) { clearInterval(t); } }, 100);`;
    const res = await run(node, ['-e', script], testContext({ env, signal: dog.signal }), { label: 'quiet', timeoutMs: 20_000 });
    dog.stop();
    expect(res.code).toBe(0);
    expect(dog.tripped).toBeUndefined();
    expect(Math.max(...sizes)).toBeGreaterThan(10 * 4096);
  });

  it('stops at the shared deadline with a hint naming the download timeout', async () => {
    const dog = new Watchdog({ label: 'slow', stallMs: 0, deadlineAt: Date.now() + 200, pollMs: 50 });
    const err = await run(node, ['-e', 'setInterval(() => {}, 1000)'], testContext({ env, signal: dog.signal }), {
      label: 'slow',
      timeoutMs: 20_000,
    }).catch((e: unknown) => e);
    dog.stop();
    expect(dog.tripped).toBe('deadline');
    expect((err as Vid2ContextError).hint).toContain('VID2CONTEXT_DOWNLOAD_TIMEOUT_SEC');
    expect(dog.remainingMs(5000)).toBe(1);
  });

  it('follows the caller signal (cancel) without blaming itself', async () => {
    const parent = new AbortController();
    const dog = new Watchdog({ label: 'canceled', stallMs: 10_000, parent: parent.signal });
    setTimeout(() => parent.abort(new Vid2ContextError('bad-request', 'The download was canceled.')), 100);
    const err = await run(node, ['-e', 'setInterval(() => {}, 1000)'], testContext({ env, signal: dog.signal }), {
      label: 'canceled',
      timeoutMs: 20_000,
    }).catch((e: unknown) => e);
    dog.stop();
    expect(dog.tripped).toBe('canceled');
    expect(dog.error()).toBeUndefined();
    expect((err as Error).message).toBe('The download was canceled.');
  });
});

describe.skipIf(!hasFfmpeg)('ffmpeg under the watchdog', () => {
  it('stops a conversion that writes more than the cap, reading ffmpeg progress', async () => {
    const tools = await locateFfmpeg({ env });
    const err = await runFfmpeg({
      tools,
      input: APOLLO,
      output: join(dir, 'capped.wav'),
      args: ['-vn', '-c:a', 'pcm_s16le'],
      format: 'wav',
      ctx: testContext({ env }),
      timeoutMs: 60_000,
      watchdog: { stallMs: 30_000, maxBytes: 50_000 },
    }).catch((e: unknown) => e);
    expect((err as Vid2ContextError).code).toBe('too-large');
  });

  it('finishes normally under generous limits', async () => {
    const tools = await locateFfmpeg({ env });
    await runFfmpeg({
      tools,
      input: APOLLO,
      output: join(dir, 'ok.wav'),
      args: ['-vn', '-c:a', 'pcm_s16le'],
      format: 'wav',
      section: { fromSec: 0, toSec: 2 },
      ctx: testContext({ env }),
      timeoutMs: 60_000,
      watchdog: { stallMs: 30_000, deadlineAt: Date.now() + 60_000, maxBytes: 10_000_000 },
    });
    expect(await folderBytes(dir)).toBeGreaterThan(0);
  });
});

describe('disk preflight', () => {
  it('reads free space and refuses a download that would not fit', async () => {
    const free = await freeBytes(dir);
    expect(free).toBeGreaterThan(0);
    await preflightDisk([{ dir, bytes: 1024, label: 'the temp folder' }], 0);
    const err = await preflightDisk([{ dir, bytes: (free as number) * 2, label: 'the download folder' }], 0).catch(
      (e: unknown) => e,
    );
    expect((err as Vid2ContextError).code).toBe('too-large');
    expect((err as Vid2ContextError).message).toContain('the download folder');
    // A folder that does not exist yet is created, then measured.
    await preflightDisk([{ dir: join(dir, 'new', 'deeper'), bytes: 1, label: 'x' }], 0);
  });
});

describe('size estimates', () => {
  const options = mediaOptions(bbb);
  it('matches the quality list and scales to the kept part', () => {
    const mp4 = normalizeRequest({ url: 'x', format: 'mp4', quality: '720' });
    const whole = estimateBytes(mp4, options);
    expect(whole).toBe(options.video.find((v) => v.quality === '720')?.sizes.mp4);
    const part = estimateBytes(mp4, options, { fromSec: 60, toSec: 70 }) as number;
    expect(part).toBeCloseTo(((whole as number) * 10) / (options.durationSec as number), -1);
    const m4a = estimateBytes(normalizeRequest({ url: 'x', format: 'm4a' }), options);
    expect(m4a).toBe(options.audio.find((a) => a.format === 'm4a')?.sizeBytes);
    expect(estimateBytes(mp4, { video: [], audio: [], durationSec: 10 })).toBeUndefined();
  });
});

/**
 * The Node downloader, job queue, HTTP routes and MCP tools, end to end on a
 * real local file (the public-domain Apollo 11 clip) converted by the real
 * ffmpeg. No network. Skipped when ffmpeg is not installed.
 */
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { type Ctx, Registry, Vid2ContextError } from '@vid2context/core';
import { testContext } from '@vid2context/core/testing';
import { tryLocateFfmpeg } from '@vid2context/ffmpeg';
import mediaFile from '@vid2context/provider-media-file';
import { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { contentDisposition, downloadsRoutes, parseRange } from '../src/http.ts';
import { registerDownloadTools } from '../src/mcp.ts';
import { createDownloader, createDownloadManager, outputName, resolveSection, stamp } from '../src/node.ts';
import { normalizeRequest } from '../src/options.ts';
import type { DownloadJob } from '../src/types.ts';

const APOLLO = new URL('../../../tests/fixtures/media/apollo11-small-step.mp3', import.meta.url).pathname;
const env = { PATH: process.env.PATH, HOME: process.env.HOME };
const hasFfmpeg = !!(await tryLocateFfmpeg({ env }).catch(() => null));

describe('file names', () => {
  it('names files from the title, the id and the kept part, safely', () => {
    expect(outputName({ title: 'Me at the zoo', id: 'jNQXAC9IVRw', ext: 'mp4' })).toBe('Me at the zoo [jNQXAC9IVRw].mp4');
    expect(outputName({ title: 'A/B: "test"?', ext: 'mp3', section: { fromSec: 60, toSec: 70 } })).toBe(
      'A_B_ _test__ (1m00s-1m10s).mp3',
    );
    expect(outputName({ title: 'Talk', ext: 'm4a', section: { fromSec: 3725, chapter: 'Q&A' } })).toBe('Talk - Q&A.m4a');
    expect(outputName({ title: 'x'.repeat(400), id: 'abc', ext: 'webm' }).length).toBeLessThanOrEqual(180);
    expect(stamp(3723)).toBe('1h02m03s');
  });

  it('turns a chapter or a range into a checked section', () => {
    const info = {
      duration: 19,
      chapters: [
        { title: 'Intro', start_time: 0, end_time: 12 },
        { title: 'The cool thing', start_time: 12, end_time: 14 },
        { title: 'End', start_time: 14, end_time: 19 },
      ],
    };
    const req = (raw: object) => normalizeRequest({ url: 'https://example.com/v', ...raw });
    expect(resolveSection(req({}), info)).toBeUndefined();
    expect(resolveSection(req({ chapter: 'cool' }), info)).toEqual({ fromSec: 12, toSec: 14, chapter: 'The cool thing' });
    expect(resolveSection(req({ from: '5', to: '60' }), info)).toEqual({ fromSec: 5 });
    expect(() => resolveSection(req({ from: '30' }), info)).toThrow(/past the end/);
    expect(() => resolveSection(req({ chapter: 'giraffes' }), info)).toThrow(/No chapter matches/);
  });
});

describe('http helpers', () => {
  it('writes an ASCII fallback and a UTF-8 file name', () => {
    expect(contentDisposition('Café "live".mp3')).toBe(
      `attachment; filename="Caf_ _live_.mp3"; filename*=UTF-8''Caf%C3%A9%20%22live%22.mp3`,
    );
    expect(contentDisposition('a.mp4', true)).toMatch(/^inline;/);
  });

  it('parses single byte ranges', () => {
    expect(parseRange(undefined, 100)).toBeNull();
    expect(parseRange('bytes=0-9', 100)).toEqual({ start: 0, end: 9 });
    expect(parseRange('bytes=90-', 100)).toEqual({ start: 90, end: 99 });
    expect(parseRange('bytes=-10', 100)).toEqual({ start: 90, end: 99 });
    expect(parseRange('bytes=50-500', 100)).toEqual({ start: 50, end: 99 });
    expect(parseRange('bytes=100-', 100)).toBe('invalid');
    expect(parseRange('bytes=5-1', 100)).toBe('invalid');
    expect(parseRange('items=0-1', 100)).toBe('invalid');
  });
});

describe.skipIf(!hasFfmpeg)('local files through ffmpeg', () => {
  let dir: string;
  const ctx = testContext({ env });
  const downloader = createDownloader({ registry: new Registry(mediaFile, 'node') });

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'v2c-dl-test-'));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('probes a local file', async () => {
    const o = await downloader.probe(APOLLO, ctx);
    expect(o.durationSec).toBeGreaterThan(20);
    expect(o.video).toEqual([]);
    expect(o.audio.find((a) => a.format === 'mp3' && a.quality === 'best')?.sizeBytes).toBeGreaterThan(0);
  });

  it('converts audio and trims it, reporting progress, without replacing earlier files', async () => {
    const phases: string[] = [];
    const req = normalizeRequest({ url: APOLLO, format: 'm4a', from: '2', to: '6' });
    const a = await downloader.download(req, ctx, { dir, onProgress: (p) => phases.push(p.phase) });
    expect(a.filename).toBe('apollo11-small-step (0m02s-0m06s).m4a');
    expect(a.mimeType).toBe('audio/mp4');
    expect(a.durationSec).toBe(4);
    expect(a.bytes).toBe((await stat(a.path)).size);
    expect(phases[0]).toBe('preparing');
    expect(phases.at(-1)).toBe('finished');
    const b = await downloader.download(req, ctx, { dir });
    expect(b.filename).toBe('apollo11-small-step (0m02s-0m06s) (2).m4a');
  });

  it('refuses a video download of an audio-only file', async () => {
    await expect(downloader.download(normalizeRequest({ url: APOLLO, format: 'mp4' }), ctx, { dir })).rejects.toThrow(
      /no video track/,
    );
  });

  it('resolves output folders from env, ~ and relative names', () => {
    const c = testContext({ env: { ...env, VID2CONTEXT_DOWNLOAD_DIR: '/srv/media' } });
    expect(downloader.outputDir(c)).toBe('/srv/media');
    expect(downloader.outputDir(c, 'talks')).toBe('/srv/media/talks');
    expect(downloader.outputDir(c, '/abs/x')).toBe('/abs/x');
    expect(downloader.outputDir(c, '~/Music')).toBe(join(process.env.HOME as string, 'Music'));
  });
});

describe.skipIf(!hasFfmpeg)('HTTP routes with the job queue', () => {
  const downloader = createDownloader();
  let manager: ReturnType<typeof createDownloadManager>;
  let jobsDir: string;
  let app: Hono;
  let currentEnv: Record<string, string | undefined> = env;

  beforeAll(async () => {
    jobsDir = await mkdtemp(join(tmpdir(), 'v2c-dl-jobs-'));
    manager = createDownloadManager({ downloader, dir: jobsDir });
    app = new Hono();
    app.onError((err, c) => {
      const e = err instanceof Vid2ContextError ? err : undefined;
      const status =
        e?.code === 'bad-request'
          ? 400
          : e?.code === 'not-found'
            ? 404
            : e?.code === 'unavailable'
              ? 403
              : e?.code === 'no-provider'
                ? 503
                : 500;
      return c.json({ error: { code: e?.code ?? 'internal', message: err.message, hint: e?.hint } }, status);
    });
    app.route('/api/v1', downloadsRoutes({ makeCtx: (req) => testContext({ env: currentEnv, signal: req.signal }), manager }));
  });
  afterAll(async () => {
    await manager.close();
    await rm(jobsDir, { recursive: true, force: true });
  });

  const call = (path: string, init?: RequestInit) => app.request(`http://local/api/v1${path}`, init);
  const post = (body: unknown) =>
    call('/downloads', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

  it('reports status, formats and the rights notice', async () => {
    const res = await call('/downloads/status');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { enabled: boolean; notice: string; formats: { audio: { id: string }[] } };
    expect(body.enabled).toBe(true);
    expect(body.notice).toContain('rights');
    expect(body.formats.audio.map((f) => f.id)).toEqual(['mp3', 'm4a', 'opus', 'flac', 'wav']);
  });

  it('refuses on a public server unless opted in, and refuses local paths there even then', async () => {
    currentEnv = { ...env, VID2CONTEXT_PUBLIC: '1' };
    try {
      const status = (await (await call('/downloads/status')).json()) as { enabled: boolean; reason: string };
      expect(status.enabled).toBe(false);
      expect(status.reason).toContain('VID2CONTEXT_DOWNLOADS=1');
      expect((await post({ url: APOLLO })).status).toBe(403);
      currentEnv = { ...env, VID2CONTEXT_PUBLIC: '1', VID2CONTEXT_DOWNLOADS: '1' };
      const local = await post({ url: APOLLO, format: 'mp3' });
      expect(local.status).toBe(500);
      expect(((await local.json()) as { error: { code: string } }).error.code).toBe('unsupported-input');
    } finally {
      currentEnv = env;
    }
  });

  it('validates the body', async () => {
    const res = await post({ url: APOLLO, format: 'avi' });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { hint: string } }).error.hint).toContain('mp3');
    expect((await call('/downloads', { method: 'POST', body: 'not json' })).status).toBe(400);
    expect((await call('/downloads/00000000-0000-0000-0000-000000000000')).status).toBe(404);
  });

  it('runs a job, serves the file whole and in ranges, then deletes it', async () => {
    const created = await post({ url: APOLLO, format: 'wav', from: '0', to: '1' });
    expect(created.status).toBe(202);
    let job = (await created.json()) as DownloadJob;
    expect(created.headers.get('location')).toBe(`/api/v1/downloads/${job.id}`);
    for (let i = 0; i < 100 && (job.status === 'queued' || job.status === 'running'); i++) {
      await new Promise((r) => setTimeout(r, 100));
      job = (await (await call(`/downloads/${job.id}`)).json()) as DownloadJob;
    }
    expect(job.status).toBe('done');
    expect(job.file?.filename).toBe('apollo11-small-step (0m00s-0m01s).wav');
    expect(job.expiresAt).toBeTruthy();
    expect(JSON.stringify(job)).not.toContain(jobsDir);

    const whole = await call(`/downloads/${job.id}/file`);
    expect(whole.status).toBe(200);
    expect(whole.headers.get('content-type')).toBe('audio/wav');
    expect(whole.headers.get('content-disposition')).toContain('attachment;');
    const bytes = new Uint8Array(await whole.arrayBuffer());
    expect(bytes.length).toBe(job.file?.bytes);
    expect(new TextDecoder().decode(bytes.slice(0, 4))).toBe('RIFF');

    const part = await call(`/downloads/${job.id}/file?inline=1`, { headers: { range: 'bytes=0-3' } });
    expect(part.status).toBe(206);
    expect(part.headers.get('content-range')).toBe(`bytes 0-3/${bytes.length}`);
    expect(part.headers.get('content-disposition')).toMatch(/^inline;/);
    expect(new TextDecoder().decode(new Uint8Array(await part.arrayBuffer()))).toBe('RIFF');
    expect((await call(`/downloads/${job.id}/file`, { headers: { range: 'bytes=999999999-' } })).status).toBe(416);

    const list = (await (await call('/downloads')).json()) as { jobs: DownloadJob[] };
    expect(list.jobs.map((j) => j.id)).toContain(job.id);
    expect((await call(`/downloads/${job.id}`, { method: 'DELETE' })).status).toBe(200);
    expect((await call(`/downloads/${job.id}`)).status).toBe(404);
  });

  it('reports a failed job with its code and hint', async () => {
    let job = (await (await post({ url: APOLLO, format: 'mp4' })).json()) as DownloadJob;
    for (let i = 0; i < 100 && (job.status === 'queued' || job.status === 'running'); i++) {
      await new Promise((r) => setTimeout(r, 50));
      job = (await (await call(`/downloads/${job.id}`)).json()) as DownloadJob;
    }
    expect(job.status).toBe('error');
    expect(job.error?.code).toBe('unsupported-input');
    expect(job.error?.hint).toContain('audio');
    expect((await call(`/downloads/${job.id}/file`)).status).toBe(400);
  });

  it('answers no-provider on runtimes without a manager', async () => {
    const bare = new Hono();
    bare.onError((err, c) => c.json({ code: (err as Vid2ContextError).code }, 503));
    bare.route('/', downloadsRoutes({ makeCtx: () => testContext({ env, runtime: 'workers' }) }));
    const status = (await (await bare.request('http://w/downloads/status')).json()) as { enabled: boolean; reason: string };
    expect(status.enabled).toBe(false);
    expect(status.reason).toContain('workers');
    expect(await (await bare.request('http://w/downloads')).json()).toEqual({ code: 'no-provider' });
  });
});

describe.skipIf(!hasFfmpeg)('MCP tools', () => {
  async function connect(ctx: Ctx, withDownloader: boolean) {
    const server = new McpServer({ name: 't', version: '0' });
    const registry = new Registry(mediaFile, 'node');
    registerDownloadTools(server, { registry, ctx, ...(withDownloader ? { downloader: createDownloader({ registry }) } : {}) });
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'c', version: '0' });
    await Promise.all([server.connect(a), client.connect(b)]);
    return client;
  }

  it('lists nothing on a server that must not write files', async () => {
    const client = await connect(testContext({ env }), false);
    await expect(client.listTools()).rejects.toThrow();
  });

  it('describes options and saves a file where asked', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'v2c-dl-mcp-'));
    try {
      const client = await connect(testContext({ env }), true);
      const tools = (await client.listTools()).tools.map((t) => t.name).sort();
      expect(tools).toEqual([
        'download_batch',
        'download_captions',
        'download_media',
        'export_clip',
        'get_caption_options',
        'get_media_options',
        'grab_frames',
      ]);
      const opts = await client.callTool({ name: 'get_media_options', arguments: { url: APOLLO } });
      expect((opts.content as { text: string }[])[0]?.text).toContain('Video: none (audio only)');
      const res = await client.callTool({
        name: 'download_media',
        arguments: { url: APOLLO, format: 'opus', quality: '64', dir },
      });
      expect(res.isError).toBeFalsy();
      const files = (res.structuredContent as { files: { path: string; filename: string }[] }).files;
      expect(files[0]?.filename).toBe('apollo11-small-step.opus');
      expect(new TextDecoder().decode((await readFile(files[0]?.path as string)).slice(0, 4))).toBe('OggS');
      const bad = await client.callTool({
        name: 'download_media',
        arguments: { url: APOLLO, format: 'mp3', quality: '1080', dir },
      });
      expect(bad.isError).toBe(true);
      expect((bad.content as { text: string }[])[0]?.text).toContain('bad-request');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

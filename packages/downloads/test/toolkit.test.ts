/**
 * The media toolkit end to end on real media, no network: the public-domain
 * Apollo 11 clip (packages/ffmpeg/test/fixtures) as H.264 mp4 with a sidecar
 * .en.srt from Wikimedia Commons, and as mkv with the same subtitles embedded;
 * the Apollo 11 mp3 for audio-only cases. Captions run through the real
 * transcript pipeline (the media-file captions provider), frames and clips
 * through the real ffmpeg, and the HTTP routes through the real task queue.
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Registry, Vid2ContextError } from '@vid2context/core';
import { testContext } from '@vid2context/core/testing';
import { probe, tryLocateFfmpeg } from '@vid2context/ffmpeg';
import mediaFile from '@vid2context/provider-media-file';
import { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { normalizeCaptionsRequest } from '../src/captions.ts';
import { normalizeAnimationRequest, normalizeFramesRequest } from '../src/clips.ts';
import { downloadsRoutes } from '../src/http.ts';
import { registerDownloadTools } from '../src/mcp.ts';
import { createDownloader, createDownloadManager } from '../src/node.ts';
import type { TaskJob } from '../src/toolkit.ts';
import { unzipEntries } from './unzip.ts';

const FIX = new URL('../../ffmpeg/test/fixtures/', import.meta.url).pathname;
const MP4 = join(FIX, 'apollo11-first-steps.mp4');
const MKV = join(FIX, 'apollo11-first-steps-subs.mkv');
const MP3 = new URL('../../../tests/fixtures/media/apollo11-small-step.mp3', import.meta.url).pathname;
const env = { PATH: process.env.PATH, HOME: process.env.HOME };
const hasFfmpeg = !!(await tryLocateFfmpeg({ env }).catch(() => null));

const registry = new Registry(mediaFile, 'node');
const downloader = createDownloader({ registry });
const toolkit = downloader.toolkit as NonNullable<typeof downloader.toolkit>;
const ctx = testContext({ env });

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'v2c-toolkit-'));
});
afterAll(async () => {
  await toolkit.jobs.close();
  await rm(dir, { recursive: true, force: true });
});

const text = async (path: string) => readFile(path, 'utf8');

describe.skipIf(!hasFfmpeg)('captions only', () => {
  it('lists the sidecar and the embedded track with formats', async () => {
    const mp4 = await toolkit.captionTracks(MP4, ctx);
    expect(mp4.tracks.map((t) => [t.language, t.auto])).toEqual([['en', false]]);
    expect(mp4.formats.map((f) => f.id)).toContain('original');
    const mkv = await toolkit.captionTracks(MKV, ctx);
    expect(mkv.tracks[0]?.language).toBe('en');
    expect(mkv.tracks[0]?.sources).toEqual(['media-file-captions']);
  });

  it('converts the sidecar through the pipeline to srt, vtt, txt, json and markdown', async () => {
    const srt = await toolkit.captions(normalizeCaptionsRequest({ url: MP4 }), ctx, { dir });
    expect(srt.filename).toBe('apollo11-first-steps.en.srt');
    expect(srt.tracks).toEqual([
      { language: 'en', origin: 'creator-captions', producer: 'media-file-captions', via: 'pipeline' },
    ]);
    expect(await text(srt.path)).toMatch(/^1\n00:00:0\d,\d{3} --> /);
    expect(await text(srt.path)).toContain('one small step');

    const vtt = await toolkit.captions(normalizeCaptionsRequest({ url: MP4, format: 'vtt', languages: 'en' }), ctx, { dir });
    expect((await text(vtt.path)).startsWith('WEBVTT')).toBe(true);

    const txt = await toolkit.captions(normalizeCaptionsRequest({ url: MP4, format: 'txt', timestamps: true }), ctx, { dir });
    expect(await text(txt.path)).toMatch(/^\[0:0\d\] /);

    const json = await toolkit.captions(normalizeCaptionsRequest({ url: MP4, format: 'json' }), ctx, { dir });
    const body = JSON.parse(await text(json.path)) as { language: string; segments: { startSec: number; text: string }[] };
    expect(body.language).toBe('en');
    expect(body.segments.length).toBeGreaterThan(3);

    const md = await toolkit.captions(normalizeCaptionsRequest({ url: MP4, format: 'md' }), ctx, { dir });
    expect(md.filename.endsWith('.en.md')).toBe(true);
    expect(await text(md.path)).toContain('# ');
  });

  it('keeps the original sidecar bytes and copies an embedded stream out', async () => {
    const side = await toolkit.captions(normalizeCaptionsRequest({ url: MP4, format: 'original' }), ctx, { dir });
    expect(side.tracks?.[0]?.via).toBe('file');
    expect(await readFile(side.path)).toEqual(await readFile(join(FIX, 'apollo11-first-steps.en.srt')));
    const emb = await toolkit.captions(normalizeCaptionsRequest({ url: MKV, format: 'original', zip: true }), ctx, { dir });
    expect(emb.format).toBe('zip');
    const entries = await unzipEntries(new Uint8Array(await readFile(emb.path)));
    expect(entries.map((e) => e.path)).toEqual(['apollo11-first-steps-subs.en.srt']);
    expect(new TextDecoder().decode(entries[0]?.data)).toContain('one small step');
  });

  it('zips every language and reports the ones that are missing', async () => {
    const all = await toolkit.captions(normalizeCaptionsRequest({ url: MKV, languages: 'all', format: 'vtt' }), ctx, { dir });
    expect(all.format).toBe('vtt');
    const two = await toolkit.captions(normalizeCaptionsRequest({ url: MP4, languages: ['en', 'de'], mode: 'captions' }), ctx, {
      dir: join(dir, 'two'),
    });
    expect(two.filename).toBe('apollo11-first-steps.en.srt');
    expect(two.warnings.join(' ')).toContain('de: not saved');
  });

  it('fails with no-transcript when there are no captions and transcription is off', async () => {
    const err = await toolkit
      .captions(normalizeCaptionsRequest({ url: MP3, mode: 'captions' }), ctx, { dir })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Vid2ContextError);
    expect((err as Vid2ContextError).code).toBe('no-transcript');
  });

  it('validates requests', () => {
    expect(() => normalizeCaptionsRequest({ url: MP4, format: 'docx' })).toThrow(/Unknown caption format/);
    expect(() => normalizeCaptionsRequest({ url: MP4, languages: 'english!' })).toThrow(/not a language code/);
    expect(() => normalizeCaptionsRequest({ url: MP4, format: 'original', mode: 'stt' })).toThrow(/no original/);
    expect(normalizeCaptionsRequest({ url: MP4, lang: 'all' })).toMatchObject({ allLanguages: true, languages: [] });
    expect(() => normalizeCaptionsRequest({ url: MP4, languages: 'en,de,fr' }, { VID2CONTEXT_MAX_CAPTION_TRACKS: '2' })).toThrow(
      /limit is 2/,
    );
  });
});

describe.skipIf(!hasFfmpeg)('frames and animated clips', () => {
  it('grabs one png at a time, and several frames as a zip of jpgs', async () => {
    const one = await toolkit.frames(normalizeFramesRequest({ url: MP4, times: '10' }), ctx, { dir });
    expect(one.filename).toBe('apollo11-first-steps 0m10s.png');
    const png = await readFile(one.path);
    expect(png.subarray(1, 4).toString('latin1')).toBe('PNG');
    const p = await probe(one.path, ctx);
    expect(p.streams[0]).toMatchObject({ width: 160, height: 120 });

    const many = await toolkit.frames(normalizeFramesRequest({ url: MP4, times: '1:00,2,30.5', format: 'jpg', width: 80 }), ctx, {
      dir,
    });
    expect(many.format).toBe('zip');
    const entries = await unzipEntries(new Uint8Array(await readFile(many.path)));
    expect(entries.map((e) => e.path)).toEqual([
      'apollo11-first-steps 0m02s.jpg',
      'apollo11-first-steps 0m30s500ms.jpg',
      'apollo11-first-steps 1m00s.jpg',
    ]);
    expect(entries[0]?.data[0]).toBe(0xff);
  });

  it('skips times past the end and refuses audio-only files', async () => {
    const res = await toolkit.frames(normalizeFramesRequest({ url: MP4, times: '5,500' }), ctx, { dir });
    expect(res.warnings.join(' ')).toContain('past the end');
    await expect(toolkit.frames(normalizeFramesRequest({ url: MP3, times: '1' }), ctx, { dir })).rejects.toThrow(
      /no video track/,
    );
  });

  it('exports a looping GIF and an animated WebP within the size and fps asked', async () => {
    const gif = await toolkit.animation(normalizeAnimationRequest({ url: MP4, from: '10', to: '12', fps: 5, width: 120 }), ctx, {
      dir,
    });
    expect(gif.filename).toBe('apollo11-first-steps (0m10s-0m12s).gif');
    const g = await readFile(gif.path);
    expect(g.subarray(0, 6).toString('latin1')).toBe('GIF89a');
    expect(g.readUInt16LE(6)).toBe(120);
    expect(g.includes(Buffer.from('NETSCAPE2.0'))).toBe(true);

    const webp = await toolkit.animation(normalizeAnimationRequest({ url: MP4, from: '0', to: '1', format: 'webp' }), ctx, {
      dir,
    });
    const w = await readFile(webp.path);
    expect(w.subarray(0, 4).toString('latin1')).toBe('RIFF');
    expect(w.subarray(8, 12).toString('latin1')).toBe('WEBP');
    expect(w.includes(Buffer.from('ANIM'))).toBe(true);
  });

  it('enforces the clip limits, tighter on public servers', () => {
    expect(() => normalizeAnimationRequest({ url: MP4, from: '0', to: '90' })).toThrow(/at most 60 s/);
    expect(() => normalizeAnimationRequest({ url: MP4, from: '0', to: '20' }, { VID2CONTEXT_PUBLIC: '1' })).toThrow(
      /at most 15 s/,
    );
    expect(() => normalizeAnimationRequest({ url: MP4, fps: 60 })).toThrow(/fps 60/);
    expect(normalizeAnimationRequest({ url: MP4, from: '3' })).toMatchObject({ fromSec: 3, toSec: 8, fps: 10, width: 480 });
    expect(() => normalizeFramesRequest({ url: MP4 })).toThrow(/at least one time/);
  });
});

describe.skipIf(!hasFfmpeg)('batches', () => {
  it('saves every item, reports a failed one, and zips the rest', async () => {
    const res = await toolkit.batch(
      {
        kind: 'batch',
        inputs: [MP3, MP4, join(FIX, 'missing.mp4')],
        item: { ...normalizeCaptionsRequest({ url: MP4, format: 'vtt', mode: 'captions' }), input: undefined } as never,
        limit: 10,
        playlist: false,
        zip: true,
      },
      ctx,
      { dir },
    );
    expect(res.items?.map((i) => i.status)).toEqual(['error', 'done', 'error']);
    expect(res.items?.[0]?.error?.code).toBe('no-transcript');
    expect(res.file?.format).toBe('zip');
    const entries = await unzipEntries(new Uint8Array(await readFile(res.file?.path as string)));
    expect(entries.map((e) => e.path)).toEqual(['apollo11-first-steps.en.vtt']);
    expect(res.file?.warnings.join(' ')).toContain('2 of 3 items failed');
  });
});

describe.skipIf(!hasFfmpeg)('HTTP routes for the toolkit', () => {
  let manager: ReturnType<typeof createDownloadManager>;
  let app: Hono;
  let currentEnv: Record<string, string | undefined> = env;

  beforeAll(() => {
    manager = createDownloadManager({ downloader });
    app = new Hono();
    app.onError((err, c) => {
      const e = err instanceof Vid2ContextError ? err : undefined;
      const status = e?.code === 'bad-request' ? 400 : e?.code === 'not-found' ? 404 : e?.code === 'unavailable' ? 403 : 500;
      return c.json({ error: { code: e?.code ?? 'internal', message: err.message, hint: e?.hint } }, status);
    });
    app.route('/api/v1', downloadsRoutes({ makeCtx: (req) => testContext({ env: currentEnv, signal: req.signal }), manager }));
  });
  afterAll(async () => {
    await manager.close();
  });

  const call = (path: string, init?: RequestInit) => app.request(`http://local/api/v1${path}`, init);
  const post = (path: string, body: unknown) =>
    call(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  async function wait(id: string): Promise<TaskJob> {
    let job = (await (await call(`/downloads/${id}`)).json()) as TaskJob;
    for (let i = 0; i < 200 && (job.status === 'queued' || job.status === 'running'); i++) {
      await new Promise((r) => setTimeout(r, 50));
      job = (await (await call(`/downloads/${id}`)).json()) as TaskJob;
    }
    return job;
  }

  it('describes the toolkit and lists caption tracks', async () => {
    const t = (await (await call('/downloads/toolkit')).json()) as { enabled: boolean; clips: { maxSec: number } };
    expect(t.enabled).toBe(true);
    expect(t.clips.maxSec).toBe(60);
    const tracks = (await (await call(`/downloads/captions/tracks?url=${encodeURIComponent(MP4)}`)).json()) as {
      tracks: { language: string }[];
    };
    expect(tracks.tracks[0]?.language).toBe('en');
    // Paths that are not toolkit tasks still reach the download routes.
    expect((await call('/downloads/status')).status).toBe(200);
    expect((await call('/downloads/00000000-0000-0000-0000-000000000000')).status).toBe(404);
  });

  it('runs a captions task and serves its file, listed with the downloads', async () => {
    const res = await post('/downloads/captions', { url: MP4, format: 'srt' });
    expect(res.status).toBe(202);
    const created = (await res.json()) as TaskJob;
    expect(res.headers.get('location')).toBe(`/api/v1/downloads/${created.id}`);
    expect(created.request.kind).toBe('captions');
    const job = await wait(created.id);
    expect(job.status).toBe('done');
    expect(job.file?.filename).toBe('apollo11-first-steps.en.srt');
    const file = await call(`/downloads/${job.id}/file`);
    expect(file.headers.get('content-type')).toContain('subrip');
    expect(await file.text()).toContain('one small step');
    const part = await call(`/downloads/${job.id}/file`, { headers: { range: 'bytes=0-1' } });
    expect(part.status).toBe(206);
    const list = (await (await call('/downloads')).json()) as { jobs: { id: string }[] };
    expect(list.jobs.map((j) => j.id)).toContain(job.id);
    expect((await call(`/downloads/${job.id}`, { method: 'DELETE' })).status).toBe(200);
    expect((await call(`/downloads/${job.id}`)).status).toBe(404);
  });

  it('runs frames and clip tasks', async () => {
    const frames = await wait(((await (await post('/downloads/frames', { url: MP4, times: [3] })).json()) as TaskJob).id);
    expect(frames.file?.mimeType).toBe('image/png');
    const clip = await wait(
      ((await (await post('/downloads/clips', { url: MP4, from: 1, to: 2, format: 'webp' })).json()) as TaskJob).id,
    );
    expect(clip.status).toBe('done');
    expect(clip.file?.mimeType).toBe('image/webp');
  });

  it('runs a batch without zip and serves each item, with per-item errors', async () => {
    const res = await post('/downloads/batch', { urls: [MP3, MP4], kind: 'audio', format: 'opus', quality: '64' });
    const job = await wait(((await res.json()) as TaskJob).id);
    expect(job.status).toBe('done');
    expect(job.items?.map((i) => i.status)).toEqual(['done', 'done']);
    const item = await call(`/downloads/${job.id}/items/1/file`);
    expect(item.status).toBe(200);
    expect(new Uint8Array(await item.arrayBuffer()).subarray(0, 4)).toEqual(new TextEncoder().encode('OggS'));
    expect((await call(`/downloads/${job.id}/file`)).status).toBe(404);
    expect((await call(`/downloads/${job.id}/items/7/file`)).status).toBe(404);
  });

  it('validates bodies and honours the public policy', async () => {
    expect((await post('/downloads/clips', { url: MP4, format: 'avi' })).status).toBe(400);
    expect((await post('/downloads/batch', {})).status).toBe(400);
    currentEnv = { ...env, VID2CONTEXT_PUBLIC: '1' };
    try {
      expect((await post('/downloads/captions', { url: MP4 })).status).toBe(403);
    } finally {
      currentEnv = env;
    }
  });

  it('cancels a running task', async () => {
    const res = await post('/downloads/clips', { url: MP4, from: 0, to: 30, fps: 30, width: 1280 });
    const { id } = (await res.json()) as TaskJob;
    expect((await call(`/downloads/${id}`, { method: 'DELETE' })).status).toBe(200);
    expect((await call(`/downloads/${id}`)).status).toBe(404);
  });
});

describe.skipIf(!hasFfmpeg)('MCP toolkit tools', () => {
  async function connect() {
    const server = new McpServer({ name: 't', version: '0' });
    registerDownloadTools(server, { registry, ctx, downloader });
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'c', version: '0' });
    await Promise.all([server.connect(a), client.connect(b)]);
    return client;
  }
  const textOf = (r: unknown) => ((r as { content: { text: string }[] }).content[0]?.text ?? '');

  it('lists caption tracks and saves captions, frames, a clip and a batch where asked', async () => {
    const client = await connect();
    const out = join(dir, 'mcp');
    const opts = await client.callTool({ name: 'get_caption_options', arguments: { url: MKV } });
    expect(textOf(opts)).toContain('en       creator');

    const cap = await client.callTool({ name: 'download_captions', arguments: { url: MP4, format: 'vtt', dir: out } });
    expect(cap.isError).toBeFalsy();
    const file = (cap.structuredContent as { file: { path: string; filename: string } }).file;
    expect(file.filename).toBe('apollo11-first-steps.en.vtt');
    expect((await text(file.path)).startsWith('WEBVTT')).toBe(true);

    const frames = await client.callTool({ name: 'grab_frames', arguments: { url: MP4, times: ['0:05', 20], dir: out } });
    expect(textOf(frames)).toContain('2 files');

    const clip = await client.callTool({ name: 'export_clip', arguments: { url: MP4, from: '0:20', to: '0:21', dir: out } });
    expect(textOf(clip)).toMatch(/Saved .*\.gif/);

    const batch = await client.callTool({
      name: 'download_batch',
      arguments: { urls: [MP3, MP4], kind: 'captions', mode: 'captions', dir: out },
    });
    expect(batch.isError).toBeFalsy();
    expect(textOf(batch)).toContain('1 of 2 saved');
    expect(textOf(batch)).toContain('error:');

    const bad = await client.callTool({ name: 'export_clip', arguments: { url: MP4, from: '0', to: '5:00', dir: out } });
    expect(bad.isError).toBe(true);
    expect(textOf(bad)).toContain('bad-request');
  });
});

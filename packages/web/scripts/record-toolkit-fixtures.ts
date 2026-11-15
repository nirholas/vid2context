/**
 * Record real /downloads toolkit responses (captions, frames, clips, batch and
 * a chapter split) for the web app's tests into test/fixtures/toolkit-*.json.
 * Mounts the real routes, task queue and downloader (with the real provider
 * registry) on an in-process Hono app, the same code the Node server mounts,
 * so it needs no running server and no network: every input is a local,
 * public-domain Apollo 11 clip from packages/ffmpeg/test/fixtures.
 *
 *   npx tsx packages/web/scripts/record-toolkit-fixtures.ts
 *
 * Inputs are passed as relative paths, so no absolute path from this machine
 * ends up in a fixture. Job ids are random UUIDs from the server.
 */
import { writeFileSync } from 'node:fs';
import { createContext } from '@vid2context/core';
import { downloadsRoutes } from '@vid2context/downloads/http';
import { createDownloader, createDownloadManager } from '@vid2context/downloads/node';
import { createRegistry } from '@vid2context/registry/node';
import { Hono } from 'hono';

const out = new URL('../test/fixtures/', import.meta.url);
const DIR = 'packages/ffmpeg/test/fixtures';
const MP4 = `${DIR}/apollo11-first-steps.mp4`;
const MKV = `${DIR}/apollo11-first-steps-subs.mkv`;
const M4A = `${DIR}/apollo11-first-steps-chapters.m4a`;

const env: Record<string, string | undefined> = { ...process.env, VID2CONTEXT_LOG_LEVEL: 'error' };
delete env.VID2CONTEXT_PUBLIC;
delete env.VID2CONTEXT_DOWNLOADS;
const registry = createRegistry();
const manager = createDownloadManager({ downloader: createDownloader({ registry }) });
const app = new Hono();
app.onError((err, c) => {
  const e = err as { code?: string; hint?: string; message: string };
  const status = e.code === 'bad-request' || e.code === 'unsupported-input' ? 400 : e.code === 'not-found' ? 404 : 502;
  return c.json(
    { error: { code: e.code ?? 'internal', message: e.message, ...(e.hint ? { hint: e.hint } : {}) }, attempts: [] },
    status,
  );
});
app.route('/api/v1', downloadsRoutes({ makeCtx: (req) => createContext({ runtime: 'node', env, signal: req.signal }), manager }));

async function call(method: string, path: string, body?: unknown) {
  const res = await app.request(`http://local/api/v1${path}`, {
    method,
    ...(body !== undefined ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}),
  });
  const contentType = res.headers.get('content-type') ?? '';
  const text = await res.text();
  return { status: res.status, contentType, body: contentType.includes('json') ? JSON.parse(text) : text };
}

/** This machine's repo path is replaced by nothing, so local paths read as the relative path that was passed. */
const ROOT = `${process.cwd().replace(/\/+$/, '')}/`;

function save(name: string, method: string, path: string, r: { status: number; contentType: string; body: unknown }): void {
  const text = JSON.stringify({ request: { method, path }, status: r.status, contentType: r.contentType, body: r.body }, null, 2)
    .split(ROOT)
    .join('');
  writeFileSync(new URL(name, out), `${text}\n`);
  console.error(`[record] ${name}: ${method} ${path} -> ${r.status}`);
}

async function record(name: string, method: string, path: string, body?: unknown) {
  const r = await call(method, path, body);
  save(name, method, path, r);
  return r.body as { id: string };
}

/** Poll a task, saving the first running snapshot and the final one. */
async function follow(id: string, prefix: string): Promise<void> {
  const path = `/downloads/${id}`;
  let savedRunning = false;
  for (let i = 0; i < 12_000; i++) {
    const r = await call('GET', path);
    const job = r.body as { status: string };
    if (job.status === 'running' && !savedRunning) {
      save(`${prefix}-running.json`, 'GET', path, r);
      savedRunning = true;
    }
    if (job.status === 'done' || job.status === 'error') {
      save(`${prefix}-${job.status}.json`, 'GET', path, r);
      return;
    }
    await new Promise((res) => setTimeout(res, 10));
  }
  throw new Error(`task ${id} did not finish`);
}

const q = (u: string) => encodeURIComponent(u);
try {
  await record('toolkit.json', 'GET', '/downloads/toolkit');
  await record('toolkit-options-mp4.json', 'GET', `/downloads/options?url=${q(MP4)}`);
  await record('toolkit-options-m4a.json', 'GET', `/downloads/options?url=${q(M4A)}`);
  await record('toolkit-tracks-mkv.json', 'GET', `/downloads/captions/tracks?url=${q(MKV)}`);
  const captions = await record('toolkit-captions-start.json', 'POST', '/downloads/captions', { url: MKV, format: 'srt' });
  await follow(captions.id, 'toolkit-captions');
  const ass = await record('toolkit-captions-ass-start.json', 'POST', '/downloads/captions', {
    url: MKV,
    format: 'ass',
    offsetSec: -1,
    maxLineChars: 32,
  });
  await follow(ass.id, 'toolkit-captions-ass');
  const frames = await record('toolkit-frames-start.json', 'POST', '/downloads/frames', {
    url: MP4,
    times: '0:05,0:30',
    format: 'png',
  });
  await follow(frames.id, 'toolkit-frames');
  const clip = await record('toolkit-clip-start.json', 'POST', '/downloads/clips', { url: MP4, from: '0:10', to: '0:13' });
  await follow(clip.id, 'toolkit-clip');
  const batch = await record('toolkit-batch-start.json', 'POST', '/downloads/batch', {
    urls: [M4A, MKV],
    kind: 'audio',
    format: 'mp3',
  });
  await follow(batch.id, 'toolkit-batch');
  const split = await record('toolkit-split-start.json', 'POST', '/downloads', {
    url: M4A,
    kind: 'audio',
    format: 'm4a',
    splitChapters: true,
  });
  await follow(split.id, 'toolkit-split');
} finally {
  await manager.close();
}

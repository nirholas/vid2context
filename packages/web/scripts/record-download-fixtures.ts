/**
 * Record real /downloads responses for the web app's tests into test/fixtures/.
 * Mounts the real routes, job queue and downloader from @vid2context/downloads
 * on an in-process Hono app (the same code the Node server mounts), so it
 * needs no running server. Run from the repo root:
 *
 *   npx tsx packages/web/scripts/record-download-fixtures.ts
 *
 * The local file is passed as a relative path so no absolute path from this
 * machine ends up in a fixture. The Big Buck Bunny options call reads YouTube
 * (network); every other response is local.
 */
import { writeFileSync } from 'node:fs';
import { createContext } from '@vid2context/core';
import { downloadsRoutes } from '@vid2context/downloads/http';
import { createDownloader, createDownloadManager } from '@vid2context/downloads/node';
import { Hono } from 'hono';

const out = new URL('../test/fixtures/', import.meta.url);
const APOLLO = 'tests/fixtures/media/apollo11-small-step.mp3';
const BBB = 'https://www.youtube.com/watch?v=aqz-KE-bpKQ';
const PLAYLIST = 'https://www.youtube.com/playlist?list=PLrAXtmErZgOeiKm4sgNOknGvNjby9efdf';

const env: Record<string, string | undefined> = { ...process.env, VID2CONTEXT_LOG_LEVEL: 'error' };
delete env.VID2CONTEXT_PUBLIC;
delete env.VID2CONTEXT_DOWNLOADS;
const manager = createDownloadManager({ downloader: createDownloader() });
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
  return r.body;
}

/** Poll a job, saving the first running snapshot (with a percentage when `withPercent`) and the final one. */
async function follow(id: string, prefix: string, withPercent = false): Promise<void> {
  const path = `/downloads/${id}`;
  let savedRunning = false;
  for (let i = 0; i < 6000; i++) {
    const r = await call('GET', path);
    const job = r.body as { status: string; progress: { percent?: number; phase: string } };
    const mid = job.progress.phase === 'downloading' && (job.progress.percent ?? 0) > 5 && (job.progress.percent ?? 0) < 95;
    if (job.status === 'running' && !savedRunning && (!withPercent || mid)) {
      save(`${prefix}-running.json`, 'GET', path, r);
      savedRunning = true;
    }
    if (job.status === 'done' || job.status === 'error') {
      save(`${prefix}-${job.status}.json`, 'GET', path, r);
      return;
    }
    await new Promise((res) => setTimeout(res, 15));
  }
  throw new Error(`job ${id} did not finish`);
}

const q = (u: string) => encodeURIComponent(u);
try {
  await record('downloads-status.json', 'GET', '/downloads/status');
  await record('downloads-options-bbb.json', 'GET', `/downloads/options?url=${q(BBB)}`);
  await record('downloads-options-apollo.json', 'GET', `/downloads/options?url=${q(APOLLO)}`);
  await record('downloads-options-playlist.json', 'GET', `/downloads/options?url=${q(PLAYLIST)}`);
  const job = (await record('downloads-start.json', 'POST', '/downloads', { url: APOLLO, format: 'mp3', quality: '128' })) as {
    id: string;
  };
  await follow(job.id, 'downloads-job');
  await record('downloads-delete.json', 'DELETE', `/downloads/${job.id}`);
  const bad = (await record('downloads-start-mp4.json', 'POST', '/downloads', { url: APOLLO, format: 'mp4' })) as { id: string };
  await follow(bad.id, 'downloads-job-mp4');
  await record('downloads-start-invalid.json', 'POST', '/downloads', { url: APOLLO, format: 'mp3', quality: '1080' });
  const yt = (await record('downloads-start-bbb.json', 'POST', '/downloads', { url: BBB, format: 'mp4', quality: '480' })) as {
    id: string;
  };
  await follow(yt.id, 'downloads-job-bbb', true);
} finally {
  await manager.close();
}

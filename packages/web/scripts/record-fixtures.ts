/**
 * Record real API responses for the web app's tests into test/fixtures/.
 * Run against a live server:
 *   npm run start:server            (in another terminal, PORT=xxxx)
 *   npx tsx packages/web/scripts/record-fixtures.ts http://127.0.0.1:xxxx/api/v1
 * Every file holds { request, status, contentType, body } exactly as served.
 */
import { readFileSync, writeFileSync } from 'node:fs';

const base = process.argv[2]?.replace(/\/+$/, '');
if (!base) {
  console.error('usage: tsx packages/web/scripts/record-fixtures.ts <api base, e.g. http://127.0.0.1:8787/api/v1>');
  process.exit(1);
}
const out = new URL('../test/fixtures/', import.meta.url);
const VIDEO = 'https://www.youtube.com/watch?v=jNQXAC9IVRw';
const MISSING = 'https://www.youtube.com/watch?v=xxxxxxxxxxx';
const PLAYLIST = 'https://www.youtube.com/playlist?list=PLrAXtmErZgOeiKm4sgNOknGvNjby9efdf';

/** Fields removed before saving: health's provider list shows which keys this machine has set. */
const STRIP: Record<string, string[]> = { 'health.json': ['providers'] };

async function record(name: string, method: string, path: string, init: RequestInit = {}): Promise<unknown> {
  const res = await fetch(`${base}${path}`, { method, ...init });
  const contentType = res.headers.get('content-type') ?? '';
  const text = await res.text();
  const body = contentType.includes('json') ? JSON.parse(text) : text;
  for (const field of STRIP[name] ?? []) delete (body as Record<string, unknown>)[field];
  writeFileSync(
    new URL(name, out),
    `${JSON.stringify({ request: { method, path }, status: res.status, contentType, body }, null, 2)}\n`,
  );
  console.error(`[record] ${name}: ${method} ${path} -> ${res.status}`);
  return body;
}

const q = (u: string) => encodeURIComponent(u);
await record('health.json', 'GET', '/health');
await record('openapi.json', 'GET', '/openapi.json');
await record('context-jNQXAC9IVRw.json', 'GET', `/context?url=${q(VIDEO)}`);
await record('context-not-found.json', 'GET', `/context?url=${q(MISSING)}`);
await record('context-playlist.json', 'GET', `/context?url=${q(PLAYLIST)}`);
await record('items-playlist.json', 'GET', `/items?url=${q(PLAYLIST)}&limit=3`);
const job = (await record('job-context.json', 'POST', '/jobs', {
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ kind: 'context', input: VIDEO, options: {} }),
})) as { id: string };
await record('job-context-events.json', 'GET', `/jobs/${job.id}/events`);
const missingJob = (await record('job-not-found.json', 'POST', '/jobs', {
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ kind: 'context', input: MISSING, options: {} }),
})) as { id: string };
await record('job-not-found-events.json', 'GET', `/jobs/${missingJob.id}/events`);
const form = new FormData();
const mp3 = readFileSync(new URL('../../../tests/fixtures/media/apollo11-small-step.mp3', import.meta.url));
form.append('file', new Blob([mp3], { type: 'audio/mpeg' }), 'apollo11-small-step.mp3');
const upload = (await record('upload-apollo.json', 'POST', '/uploads', { body: form })) as { input: string };
await record('context-upload-apollo.json', 'GET', `/context?url=${q(upload.input)}`);

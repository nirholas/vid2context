/**
 * Call the vid2context HTTP API without starting a server: build the same
 * Hono app `npm run start:server` serves and send it standard Request
 * objects. Useful in tests, in a Worker or behind your own Node server.
 *
 *   npx tsx examples/http/in-process.ts
 *
 * Offline: the library storage is seeded with two real recorded
 * transcripts, so every request below is answered from it without fetching
 * anything. Unknown URLs would go through the normal pipeline.
 */
import { readFileSync } from 'node:fs';
import { MemoryStorage, type VideoContext } from '@vid2context/core';
import { createNodeContext, createRegistry } from '@vid2context/registry/node';
import { createApp } from '@vid2context/server';

const load = (file: string): VideoContext =>
  JSON.parse(readFileSync(new URL(`../../tests/fixtures/contexts/${file}`, import.meta.url), 'utf8'));

const storage = new MemoryStorage();
await storage.putContext(load('youtube-jNQXAC9IVRw.json'));
await storage.putContext(load('youtube-cCPsdFdlshc.json'));

const app = createApp({
  registry: createRegistry(),
  makeCtx: (req) => createNodeContext({ signal: req.signal }),
  storage: async () => storage,
  onAccessLog: () => {},
});

const zoo = encodeURIComponent('https://www.youtube.com/watch?v=jNQXAC9IVRw');
const gwagon = encodeURIComponent('https://www.youtube.com/watch?v=cCPsdFdlshc');
const out = (s: string) => process.stdout.write(s);

const health = await app.request('/api/v1/health');
out(`GET /api/v1/health -> ${health.status}\n`);

const transcript = await app.request(`/api/v1/transcript?url=${zoo}&format=text&timestamps=1`);
out(`\nGET /api/v1/transcript -> ${transcript.status} ${transcript.headers.get('content-type')}\n`);
out(await transcript.text());

const outline = (await (await app.request(`/api/v1/outline?url=${gwagon}`)).json()) as {
  metadata: { title: string };
  chapters: { title: string; startSec: number; tokens: number }[];
  totalTokens: number;
};
out(`\nGET /api/v1/outline -> "${outline.metadata.title}", ${outline.totalTokens} tokens\n`);
for (const c of outline.chapters) out(`  ${c.title}: ${c.tokens} tokens\n`);

const section = await app.request(`/api/v1/section?url=${gwagon}&from=4:35&to=4:50&timestamps=1`);
out(`\nGET /api/v1/section?from=4:35&to=4:50 -> ${section.status}\n`);
out(await section.text());

const library = (await (await app.request('/api/v1/library')).json()) as { items: { id: string; title: string }[] };
out(`\nGET /api/v1/library -> ${library.items.length} saved\n`);
for (const v of library.items.sort((a, b) => a.id.localeCompare(b.id))) out(`  ${v.id}  ${v.title}\n`);

const missing = await app.request('/api/v1/transcript');
out(`\nGET /api/v1/transcript (no url) -> ${missing.status}\n${JSON.stringify(await missing.json(), null, 2)}\n`);

await app.close();

/**
 * The real packages/server app with a pinned set of providers (YouTube, local media files and
 * OpenAI-compatible speech-to-text), on PORT and HOST. Used by `record_fixtures.py --minimal`
 * when the full registry does not build (for example while another workspace is half written);
 * the client fixtures need nothing else.
 *
 * The library (collections and search) lives in one process-wide MemoryStorage, so a recording
 * run starts empty and leaves nothing behind. RECORD_JOBS=1 also passes an in-process jobs queue,
 * as the Node entry does, so collection ingest and refresh answer 202 with a Job.
 * RECORD_SEED=<file>,<file> saves real VideoContext JSON files (tests/fixtures/contexts/) into that
 * library first, so ingesting those videos reads them from storage instead of calling YouTube
 * (which answers this machine's caption requests with HTTP 429 at times).
 */
import { readFile } from 'node:fs/promises';
import { serve } from '@hono/node-server';
import { createContext, type Env, MemoryStorage, type Provider, Registry, type VideoContext } from '@vid2context/core';
import { createJobQueue, registerBuiltinKinds } from '@vid2context/jobs';
import mediaFile from '@vid2context/provider-media-file';
import stt from '@vid2context/provider-stt-openai-compatible';
import youtube from '@vid2context/provider-youtube';
import { createApp } from '@vid2context/server';

// Each package's default export is one provider or an array of them; accept both.
const providers: Provider[] = [youtube, mediaFile, stt].flat() as Provider[];
const registry = new Registry(providers, 'node');
const storage = new MemoryStorage();
for (const file of (process.env.RECORD_SEED ?? '').split(',').filter(Boolean)) {
  await storage.putContext(JSON.parse(await readFile(file, 'utf8')) as VideoContext);
}
const queue = process.env.RECORD_JOBS
  ? createJobQueue({ registry, ctx: createContext({ runtime: 'node', env: process.env as Env }), storage })
  : undefined;
if (queue) registerBuiltinKinds(queue);
const app = createApp({
  registry,
  makeCtx: (req) => createContext({ runtime: 'node', env: process.env as Env, signal: req.signal }),
  storage: async () => storage,
  ...(queue ? { jobs: { queue } } : {}),
});
const port = Number(process.env.PORT) || 8787;
const hostname = process.env.HOST || '127.0.0.1';
serve({ fetch: app.fetch, port, hostname }, (info) => {
  console.error(`[vid2context] minimal HTTP API listening on http://${hostname}:${info.port}/api/v1/health`);
});

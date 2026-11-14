/**
 * The real packages/server app with a pinned set of providers (YouTube, local media files and
 * OpenAI-compatible speech-to-text), on PORT and HOST. Used by `record_fixtures.py --minimal`
 * when the full registry does not build (for example while another workspace is half written);
 * the client fixtures need nothing else.
 */
import { serve } from '@hono/node-server';
import { createContext, type Env, type Provider, Registry } from '@vid2context/core';
import mediaFile from '@vid2context/provider-media-file';
import stt from '@vid2context/provider-stt-openai-compatible';
import youtube from '@vid2context/provider-youtube';
import { createApp } from '@vid2context/server';

const providers: Provider[] = [...youtube, mediaFile, stt];
const app = createApp({
  registry: new Registry(providers, 'node'),
  makeCtx: (req) => createContext({ runtime: 'node', env: process.env as Env, signal: req.signal }),
});
const port = Number(process.env.PORT) || 8787;
const hostname = process.env.HOST || '127.0.0.1';
serve({ fetch: app.fetch, port, hostname }, (info) => {
  console.error(`[vid2context] minimal HTTP API listening on http://${hostname}:${info.port}/api/v1/health`);
});

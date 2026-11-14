/**
 * The real packages/server app with only the YouTube provider registered, on PORT and HOST.
 * Used by `record_fixtures.py --youtube-only` when the full registry does not build (for
 * example while another workspace is half written); the YouTube fixtures need nothing else.
 */
import { serve } from '@hono/node-server';
import { createContext, type Env, Registry } from '@vid2context/core';
import youtube from '@vid2context/provider-youtube';
import { createApp } from '@vid2context/server';

const registry = new Registry(youtube, 'node');
const app = createApp({
  registry,
  makeCtx: (req) => createContext({ runtime: 'node', env: process.env as Env, signal: req.signal }),
});
const port = Number(process.env.PORT) || 8787;
const hostname = process.env.HOST || '127.0.0.1';
serve({ fetch: app.fetch, port, hostname }, (info) => {
  console.error(`[vid2context] YouTube-only HTTP API listening on http://${hostname}:${info.port}/api/v1/health`);
});

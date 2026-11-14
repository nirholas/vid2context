/**
 * Node entry: `npm run start:server` (or `dev:server` with reload).
 * Listens on PORT (default 8787) and HOST (default 127.0.0.1, so it is not
 * exposed to the network unless you ask for it with HOST=0.0.0.0).
 */
import { serve } from '@hono/node-server';
import { createNodeContext, createRegistry, loadEnvFiles } from '@vid2context/registry/node';
import pkg from '../package.json' with { type: 'json' };
import { createApp } from './app.ts';

loadEnvFiles();
const registry = createRegistry();
const app = createApp({ registry, makeCtx: (req) => createNodeContext({ signal: req.signal }), version: pkg.version });
const port = Number(process.env.PORT) || 8787;
const hostname = process.env.HOST || '127.0.0.1';

serve({ fetch: app.fetch, port, hostname }, (info) => {
  console.error(`[vid2context] HTTP API listening on http://${hostname}:${info.port}/api/v1/health`);
});

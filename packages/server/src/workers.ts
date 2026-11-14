/**
 * Cloudflare Workers entry: one Worker serves the site and the API.
 * `/api/*` goes to the Hono app; everything else is a static asset from `site/`
 * (see wrangler.jsonc at the repo root). `www.` redirects to the bare domain.
 * Provider keys come from Worker vars and secrets (`wrangler secret put GROQ_API_KEY`).
 */
import { createRegistry, createWorkersContext } from '@vid2context/registry/workers';
import pkg from '../package.json' with { type: 'json' };
import { createApp } from './app.ts';

interface WorkerEnv {
  ASSETS: { fetch: (req: Request) => Promise<Response> };
  [key: string]: unknown;
}

const registry = createRegistry();

export default {
  async fetch(req: Request, env: WorkerEnv, execCtx: unknown): Promise<Response> {
    const url = new URL(req.url);
    if (url.hostname.startsWith('www.')) {
      url.hostname = url.hostname.slice(4);
      return Response.redirect(url.toString(), 301);
    }
    if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
      const app = createApp({ registry, makeCtx: (r) => createWorkersContext(env, r.signal), version: pkg.version });
      return app.fetch(req, env, execCtx as never);
    }
    return env.ASSETS.fetch(req);
  },
};

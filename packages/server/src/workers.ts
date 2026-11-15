/**
 * Cloudflare Workers entry: one Worker serves the site and the API.
 * `/api/*` (and, with mcp-http mounted, `/mcp`, `/oauth/*` and its
 * `/.well-known/*` documents) go to the Hono app; everything else is a static
 * asset from the directory wrangler.jsonc names, with markdown negotiation,
 * discovery headers (src/discovery.ts) and the /app/ and /chat/ SPA
 * fallback. `www.` and `http:` are redirected at the zone, not here.
 * Provider keys come from Worker vars and secrets
 * (`wrangler secret put GROQ_API_KEY`).
 */
import { MCP_HTTP_PATHS } from '@vid2context/mcp-http';
import { createRegistry, createWorkersContext } from '@vid2context/registry/workers';
import { fetchAssetWithSpaFallback } from '../../../deploy/serverless/cloudflare/spa-fallback.ts';
import pkg from '../package.json' with { type: 'json' };
import { createApp, MOUNTED_SUB_APPS, type ServerApp } from './app.ts';
import { isAppPath, serveSite } from './discovery.ts';

interface WorkerEnv {
  ASSETS: { fetch: (req: Request) => Promise<Response> };
  [key: string]: unknown;
}

const registry = createRegistry();
const mcpMounted = (MOUNTED_SUB_APPS as readonly string[]).includes('@vid2context/mcp-http');
const appPaths = new Set<string>(mcpMounted ? MCP_HTTP_PATHS : []);

/**
 * One app per isolate and env object, so in-memory state (rate-limit buckets,
 * uploads, single-flight) lasts across requests instead of being rebuilt on
 * each one. Cloudflare passes the same env object for the life of an isolate.
 */
const apps = new WeakMap<object, ServerApp>();

function appFor(env: WorkerEnv): ServerApp {
  let app = apps.get(env);
  if (!app) {
    app = createApp({ registry, makeCtx: (r) => createWorkersContext(env, r.signal), version: pkg.version });
    apps.set(env, app);
  }
  return app;
}

export default {
  async fetch(req: Request, env: WorkerEnv, execCtx: unknown): Promise<Response> {
    const url = new URL(req.url);
    if (isAppPath(url.pathname, appPaths)) return appFor(env).fetch(req, env, execCtx as never);
    // Deep links under /app/ and /chat/ get that app's index.html (deploy/serverless/cloudflare/spa-fallback.ts).
    return serveSite(req, (r) => fetchAssetWithSpaFallback(r, env.ASSETS), { mcp: mcpMounted });
  },
};

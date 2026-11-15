/**
 * The vid2context HTTP API as one Hono app. Runtime entries (src/node.ts,
 * src/workers.ts) build the registry for their runtime and a Ctx per request,
 * then serve `app.fetch`. Everything runtime-specific (client address, access
 * log sink) comes in through AppOptions, so the app itself is the same on
 * Node, Workers, Vercel and the rest.
 *
 * Routes built here: health, context, transcript, metadata, formats, items,
 * section, outline, comments, pack, library, models, uploads, bundle and
 * openapi.json. Sub-apps exported by other packages are mounted below
 * (see SUB_APPS); docs/contracts/http-api.md lists every route and its owner.
 */
import { accountsRoutes, hostedMiddleware } from '@vid2context/accounts/http';
import { askRoutes } from '@vid2context/ask/http';
import { chaptersRoutes } from '@vid2context/chapters/http';
import { type Ctx, formatters, type RecoveryContext, type Registry, type Storage } from '@vid2context/core';
import { type DownloadManager, downloadPolicy } from '@vid2context/downloads';
import { downloadsRoutes } from '@vid2context/downloads/http';
import { exporterRoutes } from '@vid2context/exporters/http';
import { importRoutes } from '@vid2context/imports/http';
import { insightsRoutes } from '@vid2context/insights/http';
import { type JobsRouteDeps, jobsRoutes } from '@vid2context/jobs/http';
import { libraryRoutes as collectionRoutes } from '@vid2context/library/http';
import { type McpHttpApp, mcpHttpRoutes } from '@vid2context/mcp-http';
import { researchRoutes } from '@vid2context/research/http';
import { searchRoutes } from '@vid2context/search/http';
import { skipsRoutes } from '@vid2context/skips/http';
import { webhookRoutes } from '@vid2context/webhooks/http';
import { type Context, Hono } from 'hono';
import { concurrencyLimit } from './concurrency.ts';
import { renderError } from './errors.ts';
import { type AccessLogEntry, auth, bodyLimit, cors, rateLimit, requestContext, requestKeys, timeout } from './middleware.ts';
import { buildOpenApi, json, type PathsObject, RouteDocs } from './openapi.ts';
import { bundleRoutes } from './routes/bundle.ts';
import { libraryRoutes } from './routes/library.ts';
import { modelRoutes } from './routes/models.ts';
import { uploadRoutes } from './routes/uploads.ts';
import { videoRoutes } from './routes/videos.ts';
import { createServices, type Services } from './services.ts';
import type { AppEnv } from './types.ts';

export { STATUS_BY_CODE } from './errors.ts';
export type { AccessLogEntry } from './middleware.ts';
export { listModels, type ModelInfo } from './routes/models.ts';

export interface AppOptions {
  registry: Registry;
  /** Build a Ctx for one request (env, fetch, logger, the request's abort signal). */
  makeCtx: (req: Request) => Ctx;
  version?: string;
  /**
   * The client's network address for per-IP rate limits in open mode. Node
   * passes the socket address; on Workers the app reads CF-Connecting-IP.
   * X-Forwarded-For and X-Real-IP are used only when VID2CONTEXT_TRUST_PROXY=1.
   */
  clientIp?: (c: Context) => string | undefined;
  /** Receives one entry per request. Default: one JSON line on stderr (off with VID2CONTEXT_ACCESS_LOG=0). */
  onAccessLog?: (entry: AccessLogEntry) => void;
  /**
   * Open the library storage once (with the first request's env). Default:
   * the registry's enabled storage provider, else a process-wide
   * MemoryStorage. The Node entry passes the Storage it shares with the jobs queue.
   */
  storage?: (ctx: Ctx) => Promise<Storage>;
  /**
   * The jobs queue. When given, /jobs is mounted and collection ingest and
   * refresh run as jobs. Node creates an in-process queue (src/node.ts);
   * the Worker gets one when the Cloudflare Queues binding is wired (prompt 50).
   */
  jobs?: Pick<JobsRouteDeps, 'queue' | 'run' | 'heartbeatMs'>;
  /** Check the Host header on /mcp against loopback names (turn on when listening on a loopback address). */
  mcpDnsRebindingProtection?: boolean;
  /**
   * Server-side video and audio downloads (Node: createDownloadManager from
   * @vid2context/downloads/node). Without it /downloads answers no-provider.
   */
  downloads?: DownloadManager;
}

/** The app plus `close()`, which ends open MCP sessions (call it on shutdown). */
export type ServerApp = Hono<AppEnv> & { close(): Promise<void> };

/** A sub-app another package exports, mounted under `prefix`. */
interface SubApp {
  /** Package that exports it. */
  name: string;
  prefix: string;
  routes: Hono;
  /** OpenAPI paths the package publishes for its routes, relative to `prefix`. */
  paths?: PathsObject;
}

/**
 * Package names of the sub-apps this build mounts (jobs only when a queue is
 * passed). src/workers.ts reads it to route /mcp and the OAuth paths to the app.
 */
export const MOUNTED_SUB_APPS = [
  '@vid2context/accounts',
  '@vid2context/search',
  '@vid2context/library',
  '@vid2context/ask',
  '@vid2context/insights',
  '@vid2context/chapters',
  '@vid2context/jobs',
  '@vid2context/mcp-http',
  '@vid2context/skips',
  '@vid2context/research',
  '@vid2context/exporters',
  '@vid2context/webhooks',
  '@vid2context/imports',
  '@vid2context/downloads',
] as const;

function subApps(
  services: Services,
  opts: AppOptions,
  version: string,
  accountsDeps: Parameters<typeof accountsRoutes>[0],
): { list: SubApp[]; mcp: McpHttpApp } {
  const deps = { registry: services.registry, makeCtx: services.ctxFor, storage: services.storage };
  const mcp = mcpHttpRoutes({
    ...deps,
    version,
    ...(opts.clientIp ? { clientIp: opts.clientIp } : {}),
    ...(opts.mcpDnsRebindingProtection ? { dnsRebindingProtection: true } : {}),
  });
  const list: SubApp[] = [
    // Inert (404) unless VID2CONTEXT_HOSTED=1.
    { name: '@vid2context/accounts', prefix: '/api/v1', routes: accountsRoutes(accountsDeps) },
    { name: '@vid2context/search', prefix: '/api/v1', routes: searchRoutes(deps) },
    {
      name: '@vid2context/library',
      prefix: '/api/v1',
      // With the jobs queue, collection ingest and refresh answer 202 Job; without it they run inline.
      routes: collectionRoutes({ ...deps, kv: services.kv, ...(opts.jobs ? { jobs: opts.jobs.queue } : {}) }),
    },
    { name: '@vid2context/ask', prefix: '/api/v1', routes: askRoutes(deps) },
    {
      name: '@vid2context/insights',
      prefix: '/api/v1',
      // With the jobs queue, briefs and extractions answer 202 Job; without it they answer 200 with the result.
      routes: insightsRoutes({ ...deps, ...(opts.jobs ? { queue: opts.jobs.queue } : {}) }),
    },
    { name: '@vid2context/chapters', prefix: '/api/v1', routes: chaptersRoutes(deps) },
    ...(opts.jobs ? [{ name: '@vid2context/jobs', prefix: '/api/v1', routes: jobsRoutes({ ...deps, ...opts.jobs }) }] : []),
    { name: '@vid2context/skips', prefix: '/api/v1', routes: skipsRoutes(deps) },
    { name: '@vid2context/research', prefix: '/api/v1', routes: researchRoutes(deps) },
    { name: '@vid2context/exporters', prefix: '/api/v1', routes: exporterRoutes(deps) },
    {
      name: '@vid2context/webhooks',
      prefix: '/api/v1',
      routes: webhookRoutes({ makeCtx: services.ctxFor, storage: services.storage }),
    },
    // Hosted mode returns imports without saving them (shared storage, unverified transcripts).
    {
      name: '@vid2context/imports',
      prefix: '/api/v1',
      routes: importRoutes({ ...deps, hosted: (req) => services.config(req).hosted }),
    },
    // Off on public servers unless VID2CONTEXT_DOWNLOADS=1; no-provider where no manager is passed (Workers).
    {
      name: '@vid2context/downloads',
      prefix: '/api/v1',
      routes: downloadsRoutes({ makeCtx: services.ctxFor, ...(opts.downloads ? { manager: opts.downloads } : {}) }),
    },
    { name: '@vid2context/mcp-http', prefix: '', routes: mcp },
  ];
  return { list, mcp };
}

function forwardedIp(c: Context): string | undefined {
  const xff = c.req.header('x-forwarded-for')?.split(',')[0]?.trim();
  return xff || c.req.header('x-real-ip')?.trim() || undefined;
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

export function createApp(opts: AppOptions): ServerApp {
  const version = opts.version ?? '0.1.0';
  const services = createServices(opts.registry, opts.makeCtx, opts.storage);
  const docs = new RouteDocs();
  const app = new Hono<AppEnv>();

  const clientIp = (c: Context<AppEnv>): string | undefined => {
    if (services.config(c.req.raw).trustProxy) {
      const fwd = forwardedIp(c);
      if (fwd) return fwd;
    }
    const given = opts.clientIp?.(c);
    if (given) return given;
    return services.ctxFor(c.req.raw).runtime === 'workers' ? c.req.header('cf-connecting-ip') || undefined : undefined;
  };

  /** What this server can offer a caller whose request failed (core recovery.ts). */
  const recoveryFor = (c: Context<AppEnv>): RecoveryContext => {
    const ctx = services.ctxFor(c.req.raw);
    const input = c.req.query('url') || undefined;
    let platform: string | undefined;
    if (input) {
      try {
        platform = opts.registry.resolve(input).ref.platform;
      } catch {
        platform = undefined;
      }
    }
    const mode = c.req.query('mode');
    const host = new URL(c.req.url).hostname;
    return {
      surface: 'api',
      input,
      platform,
      ...(mode === 'auto' || mode === 'captions' || mode === 'stt' || mode === 'video' ? { mode } : {}),
      downloads: !!opts.downloads && downloadPolicy(ctx.env).enabled,
      keys: services.requestKeyNames(c.req.raw).length > 0 ? 'request' : 'env',
      keyNames: services.requestKeyNames(c.req.raw),
      imports: true,
      remote: ctx.runtime === 'workers' || !LOOPBACK_HOSTS.has(host),
    };
  };

  app.onError((err, c) => {
    const r = renderError(err, recoveryFor(c));
    if (r.unexpected) {
      services.ctxFor(c.req.raw).log.error('unhandled error', {
        message: err instanceof Error ? err.message : String(err),
        requestId: c.get('requestId'),
      });
    }
    return c.json(r.body, r.status, r.headers);
  });

  app.use('*', requestContext(services, { onAccessLog: opts.onAccessLog, clientIp }));
  app.use('/api/*', cors(services));
  app.use('/api/*', timeout(services));
  // Hosted mode (VID2CONTEXT_HOSTED=1): sessions, v2c_ keys, per-IP limits and quotas from @vid2context/accounts.
  // Pass-through otherwise. Pipeline work then runs on the caller's metered registry and the shared cache.
  const accountsDeps = {
    makeCtx: services.ctxFor,
    storage: services.storage,
    clientIp: (c: Context) => clientIp(c as Context<AppEnv>),
    basePath: '/api/v1',
  };
  app.use('/api/*', hostedMiddleware(accountsDeps));
  app.use('/api/*', async (c, next) => {
    const hosted = c.get('hosted');
    if (hosted) services.setHosted(c.req.raw, hosted);
    await next();
  });
  app.use('/api/*', auth(services));
  app.use('/api/*', rateLimit(services, clientIp));
  app.use('/api/*', bodyLimit(services));
  app.use('/api/*', requestKeys(services));
  // Expensive routes and MCP tool calls: VID2CONTEXT_MAX_CONCURRENT at once, then a bounded wait, then 503 busy.
  const heavy = concurrencyLimit((req) => services.ctxFor(req).env);
  app.use('/api/*', heavy);
  app.use('/mcp', heavy);

  docs.add({
    method: 'get',
    path: '/api/v1/health',
    summary: 'Liveness, version, formats, and every provider and rung with whether it is enabled.',
    description: 'Open without an API key. requires lists env var names a rung needs; values are never returned.',
    tags: ['meta'],
    auth: false,
    responses: {
      '200': {
        description: 'Health.',
        content: json({ type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] }),
      },
    },
  });
  app.get('/api/v1/health', (c) => {
    const ctx = services.ctxFor(c.req.raw);
    return c.json({
      ok: true,
      name: 'vid2context',
      version,
      runtime: ctx.runtime,
      formats: Object.values(formatters).map((f) => ({ id: f.id, description: f.description, mimeType: f.mimeType })),
      // Names of env vars only; values are never returned.
      providers: opts.registry.health(ctx.env),
      // Provider keys a caller may send per request in X-Vid2Context-Keys (names only).
      requestKeys: { accepted: services.requestKeyNames(c.req.raw).length > 0, names: services.requestKeyNames(c.req.raw) },
    });
  });

  const deps = { services, docs, version };
  app.route('/api/v1', videoRoutes(deps));
  app.route('/api/v1', libraryRoutes(deps));
  app.route('/api/v1', modelRoutes(deps));
  app.route('/api/v1', uploadRoutes(deps));
  app.route('/api/v1', bundleRoutes(deps));

  const { list: mounted, mcp } = subApps(services, opts, version, accountsDeps);
  for (const sub of mounted) app.route(sub.prefix || '/', sub.routes);

  docs.add({
    method: 'get',
    path: '/api/v1/openapi.json',
    summary: 'This document: OpenAPI 3.1 for every route the server serves.',
    tags: ['meta'],
    responses: { '200': { description: 'OpenAPI 3.1.', content: json({ type: 'object' }) } },
  });
  let openapi: Record<string, unknown> | undefined;
  app.get('/api/v1/openapi.json', (c) => {
    openapi ??= buildOpenApi({
      version,
      routes: app.routes,
      docs,
      subAppPaths: mounted
        .filter((s) => s.paths)
        .map((s) => ({ prefix: s.prefix, paths: s.paths as PathsObject, tag: s.name.replace('@vid2context/', '') })),
      tagFor: (path) => {
        const owner = mounted.find((s) =>
          s.routes.routes.some((r) => `${s.prefix}${r.path}`.replace(/\/+$/, '') === path.replace(/\/+$/, '')),
        );
        return owner ? owner.name.replace('@vid2context/', '') : 'other';
      },
    });
    return c.json(openapi);
  });

  app.notFound((c) =>
    c.json(
      {
        error: {
          code: 'not-found',
          message: `No route for ${c.req.method} ${c.req.path}`,
          hint: 'GET /api/v1/openapi.json lists every route.',
        },
        attempts: [],
      },
      404,
    ),
  );

  return Object.assign(app, { close: () => mcp.closeSessions() });
}

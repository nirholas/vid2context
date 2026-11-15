/**
 * The remote MCP server as a Hono sub-app. Mount it at the root of the main
 * app (these paths are not under /api/v1):
 *
 *   app.route('/', mcpHttpRoutes({ registry, makeCtx, storage, version }));
 *
 * It serves /mcp, /mcp/server-card, /.well-known/oauth-protected-resource[/mcp],
 * /.well-known/oauth-authorization-server, /.well-known/ai-catalog.json,
 * /.well-known/openai-apps-challenge and /oauth/{register,authorize,token,revoke}.
 * It answers its own errors (401 with WWW-Authenticate, 403, 429) instead of
 * throwing, so the parent app's onError never rewrites them.
 */

import {
  type Ctx,
  hasKv,
  type KvStore,
  MemoryKv,
  MemoryStorage,
  type Registry,
  type Storage,
  Vid2ContextError,
} from '@vid2context/core';
import type { ServerOptions } from '@vid2context/mcp';
import { type Context, Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { authenticate, oauthEnabled } from './auth.ts';
import { type McpHttpConfig, type McpHttpMode, readConfig } from './config.ts';
import { aiCatalog, cachedJson, SERVER_CARD_TYPE, serverCard } from './discovery.ts';
import { errorResponse, rateLimited } from './errors.ts';
import { checkHost, checkOrigin, corsHeaders, PUBLIC_CORS, withHeaders } from './guard.ts';
import { mountOAuth, type RequestState } from './oauth.ts';
import { takeToken } from './ratelimit.ts';
import { OAuthStore } from './store.ts';
import { McpTransport } from './transport.ts';
import { MCP_PATH, urlsFor } from './urls.ts';

export interface McpHttpDeps {
  registry: Registry;
  /** Build a Ctx for one request (env, fetch, logger, the request's abort signal). Same as RouteDeps in the HTTP API. */
  makeCtx: (req: Request) => Ctx;
  /**
   * The library backend, opened once and shared by every request and session.
   * When it implements KvStore it also holds OAuth clients, codes, tokens and
   * rate-limit buckets. Default: the registry's enabled storage provider,
   * else MemoryStorage. Without KV support a process-local MemoryKv is used,
   * which loses every OAuth token on restart.
   */
  storage?: (ctx: Ctx) => Promise<Storage>;
  /** A KvStore to use for OAuth and rate limits (wins over the storage's own KV). */
  kv?: KvStore;
  version?: string;
  /** Passed to createServer() (for example extractAudio for watch_live). */
  serverOptions?: Omit<ServerOptions, 'storage'>;
  /** Override VID2CONTEXT_MCP_MODE. Default: session on Node, stateless elsewhere. */
  mode?: McpHttpMode;
  /**
   * Check the Host header against loopback names, the public host and
   * VID2CONTEXT_MCP_ALLOWED_HOSTS. Turn on when the server listens on a
   * loopback address (the bin does), to stop DNS-rebinding attacks.
   */
  dnsRebindingProtection?: boolean;
  /** The caller's address for login and registration limits. Default: see `clientAddress`. */
  clientIp?: (c: Context) => string | undefined;
}

export interface McpHttpApp extends Hono {
  /** Close open MCP sessions (Node shutdown, tests). */
  closeSessions(): Promise<void>;
}

/** Every path this sub-app serves. Middleware is scoped to these so it never leaks into a parent app. */
export const MCP_HTTP_PATHS = [
  MCP_PATH,
  `${MCP_PATH}/server-card`,
  '/.well-known/oauth-protected-resource',
  `/.well-known/oauth-protected-resource${MCP_PATH}`,
  '/.well-known/oauth-authorization-server',
  '/.well-known/ai-catalog.json',
  '/.well-known/openai-apps-challenge',
  '/oauth/register',
  '/oauth/authorize',
  '/oauth/token',
  '/oauth/revoke',
] as const;

const LOOPBACK_ADDR = /^(127\.|::1$|::ffff:127\.)/;

/**
 * The caller's address: the socket address on Node, trusting Cloudflare's
 * CF-Connecting-IP only when the socket is loopback (cloudflared on the same
 * machine) or when there is no socket (Workers, where Cloudflare sets it).
 */
export function clientAddress(c: Context): string {
  const incoming = (c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined)?.incoming;
  const remote = incoming?.socket?.remoteAddress;
  const cf = c.req.header('cf-connecting-ip');
  if (!remote) return cf ?? 'unknown';
  return LOOPBACK_ADDR.test(remote) && cf ? cf : remote;
}

interface State extends RequestState {
  storage: Storage;
}

export function mcpHttpRoutes(deps: McpHttpDeps): McpHttpApp {
  const app = new Hono() as unknown as McpHttpApp;
  const transport = new McpTransport({
    registry: deps.registry,
    version: deps.version ?? '0.1.0',
    serverOptions: deps.serverOptions,
  });
  const memoryKv = new MemoryKv();
  let storagePromise: Promise<Storage> | undefined;
  let warned = false;

  const openStorage = (ctx: Ctx): Promise<Storage> => {
    // Opened once with this request's env and fetch, but not its signal: the storage outlives the request.
    const base = { ...ctx, signal: undefined };
    storagePromise ??= (async () => {
      try {
        const s = deps.storage ? await deps.storage(base) : await deps.registry.openStorage(base);
        if (s) return s;
      } catch (err) {
        ctx.log.warn('mcp-http: storage failed to open, using memory storage', { message: (err as Error).message });
      }
      return new MemoryStorage();
    })();
    return storagePromise;
  };

  const pickKv = (storage: Storage, ctx: Ctx, cfg: McpHttpConfig): KvStore => {
    const kv = deps.kv ?? (hasKv(storage) ? storage : memoryKv);
    if (kv === memoryKv && oauthEnabled(cfg) && !warned) {
      warned = true;
      ctx.log.warn(
        'mcp-http: OAuth state is kept in memory (MemoryKv). Every token is lost on restart and connectors must sign in again. Use a storage backend with KV support to keep them.',
      );
    }
    return kv;
  };

  const stateCache = new WeakMap<Request, Promise<State>>();
  const getState = (c: Context): Promise<State> => {
    const req = c.req.raw;
    let hit = stateCache.get(req);
    if (!hit) {
      hit = (async () => {
        const ctx = deps.makeCtx(req);
        const cfg = await readConfig(ctx.env);
        const storage = await openStorage(ctx);
        const kv = pickKv(storage, ctx, cfg);
        const store = new OAuthStore(kv, { accessSec: cfg.accessTtlSec, refreshSec: cfg.refreshTtlSec });
        const ip = deps.clientIp?.(c) ?? clientAddress(c);
        return { cfg, kv, store, ctx, storage, urls: urlsFor(req, cfg), ip };
      })();
      stateCache.set(req, hit);
    }
    return hit;
  };

  if (deps.dnsRebindingProtection) {
    for (const p of MCP_HTTP_PATHS) {
      app.use(p, async (c, next) => {
        const s = await getState(c);
        const refused = checkHost(c.req.raw, s.cfg);
        if (refused) return refused;
        await next();
      });
    }
  }

  // Bodies are read whole by the MCP SDK and the OAuth form parser: cap them before either sees a byte
  // past VID2CONTEXT_MCP_MAX_BODY_KB (Content-Length is checked up front, chunked bodies while streaming).
  for (const p of [MCP_PATH, '/oauth/register', '/oauth/authorize', '/oauth/token', '/oauth/revoke']) {
    app.use(p, async (c, next) => {
      if (c.req.method !== 'POST' && c.req.method !== 'PUT' && c.req.method !== 'PATCH') return next();
      const s = await getState(c);
      const before = c.req.raw;
      return bodyLimit({
        maxSize: s.cfg.maxBodyBytes,
        onError: () =>
          errorResponse(
            new Vid2ContextError('too-large', `The request body is larger than ${Math.round(s.cfg.maxBodyBytes / 1024)} KB.`, {
              hint: 'Send a smaller request, or raise VID2CONTEXT_MCP_MAX_BODY_KB on the server.',
            }),
            413,
            corsHeaders(before, s.cfg),
          ),
      })(c, async () => {
        // The limiter re-wraps chunked bodies in a new Request; keep this request's state for it.
        if (c.req.raw !== before) stateCache.set(c.req.raw, stateCache.get(before) as Promise<State>);
        await next();
      });
    });
  }

  // ---------------------------------------------------------------- discovery (public)

  const preflightPublic = () => new Response(null, { status: 204, headers: PUBLIC_CORS });
  for (const p of [
    '/.well-known/oauth-protected-resource',
    '/.well-known/oauth-protected-resource/mcp',
    '/.well-known/oauth-authorization-server',
    '/.well-known/ai-catalog.json',
    `${MCP_PATH}/server-card`,
  ]) {
    app.options(p, preflightPublic);
  }

  app.get(`${MCP_PATH}/server-card`, async (c) => {
    const s = await getState(c);
    return cachedJson(c.req.raw, serverCard(s.urls), SERVER_CARD_TYPE);
  });

  app.get('/.well-known/ai-catalog.json', async (c) => {
    const s = await getState(c);
    return cachedJson(c.req.raw, aiCatalog(s.urls), 'application/ai-catalog+json');
  });

  app.get('/.well-known/openai-apps-challenge', async (c) => {
    const s = await getState(c);
    const token = s.ctx.env.VID2CONTEXT_OPENAI_APPS_CHALLENGE?.trim();
    if (!token) return c.text('Not found: VID2CONTEXT_OPENAI_APPS_CHALLENGE is not set.', 404);
    return c.text(token, 200, { 'cache-control': 'no-store' });
  });

  // ---------------------------------------------------------------- OAuth

  for (const p of ['/oauth/register', '/oauth/token', '/oauth/revoke']) {
    app.options(p, async (c) => {
      const s = await getState(c);
      return new Response(null, { status: 204, headers: corsHeaders(c.req.raw, s.cfg) });
    });
  }
  mountOAuth(app, getState);

  // ---------------------------------------------------------------- MCP

  app.options(MCP_PATH, async (c) => {
    const s = await getState(c);
    const refused = checkOrigin(c.req.raw, s.cfg);
    if (refused) return refused;
    return new Response(null, { status: 204, headers: corsHeaders(c.req.raw, s.cfg) });
  });

  app.on(['GET', 'POST', 'DELETE'], MCP_PATH, async (c) => {
    const s = await getState(c);
    const req = c.req.raw;
    const refused = checkOrigin(req, s.cfg);
    if (refused) return refused;
    const cors = corsHeaders(req, s.cfg);
    const auth = await authenticate(req, s.cfg, s.store, s.urls);
    if (!auth.ok) return withHeaders(auth.response, cors);
    const limit = await takeToken(s.kv, `mcp:${auth.principal.id}`, s.cfg.rateLimitPerMin);
    if (!limit.ok) return withHeaders(rateLimited(limit.retryAfterSec, 'MCP requests for this token'), cors);
    const mode = deps.mode ?? s.cfg.mode ?? (s.ctx.runtime === 'node' ? 'session' : 'stateless');
    const res = await transport.handle(req, {
      mode,
      ctx: s.ctx,
      storage: s.storage,
      authInfo: auth.principal.authInfo,
      principal: auth.principal.id,
      idleSec: s.cfg.sessionIdleSec,
    });
    return withHeaders(res, cors);
  });

  app.closeSessions = () => transport.closeAll();
  return app;
}

/** A plain fetch handler, for runtimes that take `(req) => Promise<Response>` (Workers, Deno, Bun, Vercel). */
export function createMcpHttpHandler(deps: McpHttpDeps): (req: Request) => Promise<Response> {
  const app = mcpHttpRoutes(deps);
  return async (req) => app.fetch(req);
}

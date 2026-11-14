/**
 * Middleware for the HTTP API, in the order createApp installs them:
 *
 *   requestContext  X-Request-Id in and out, JSON access log, X-Robots-Tag on /api/*
 *   cors            VID2CONTEXT_CORS_ORIGINS (preflights answered before auth)
 *   timeout         VID2CONTEXT_REQUEST_TIMEOUT_MS, answered with `timeout` (504)
 *   hosted          @vid2context/accounts when VID2CONTEXT_HOSTED=1 (installed by app.ts)
 *   auth            VID2CONTEXT_API_KEYS, Bearer keys with scopes (off in hosted mode)
 *   rateLimit       token bucket per key, or per client IP in open mode (off in hosted mode)
 *   bodyLimit       VID2CONTEXT_MAX_BODY_KB, or the upload cap on POST /uploads
 *
 * Settings are read from the request's env on every request.
 */
import { Vid2ContextError } from '@vid2context/core';
import type { Context, MiddlewareHandler } from 'hono';
import { bodyLimit as honoBodyLimit } from 'hono/body-limit';
import { cors as honoCors } from 'hono/cors';
import { apiKeysFor, assertScope, authenticate, requiredScope } from './auth.ts';
import { takeToken } from './rate-limit.ts';
import { tooLarge } from './routes/uploads.ts';
import type { Services } from './services.ts';
import type { AppEnv } from './types.ts';

export interface AccessLogEntry {
  ts: string;
  level: 'info';
  msg: 'request';
  requestId: string;
  method: string;
  path: string;
  status: number;
  ms: number;
  /** Name of the API key used (never the key itself). */
  key?: string;
  ip?: string;
}

const REQUEST_ID = /^[A-Za-z0-9._:-]{1,128}$/;

/** Paths that never need a key and are never rate limited. */
const OPEN_PATHS = new Set(['/api/v1/health']);

export function requestContext(
  services: Services,
  opts: { onAccessLog?: (entry: AccessLogEntry) => void; clientIp: (c: Context<AppEnv>) => string | undefined },
): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const started = Date.now();
    const incoming = c.req.header('x-request-id');
    const requestId = incoming && REQUEST_ID.test(incoming) ? incoming : crypto.randomUUID();
    c.set('requestId', requestId);
    await next();
    c.header('x-request-id', requestId);
    if (c.req.path === '/api' || c.req.path.startsWith('/api/')) c.header('x-robots-tag', 'noindex');
    if (!services.config(c.req.raw).accessLog && !opts.onAccessLog) return;
    const entry: AccessLogEntry = {
      ts: new Date(started).toISOString(),
      level: 'info',
      msg: 'request',
      requestId,
      method: c.req.method,
      path: c.req.path,
      status: c.res.status,
      ms: Date.now() - started,
      ...(c.get('principal') ? { key: c.get('principal')?.name } : {}),
      ...(opts.clientIp(c) ? { ip: opts.clientIp(c) } : {}),
    };
    if (opts.onAccessLog) opts.onAccessLog(entry);
    else console.error(JSON.stringify(entry));
  };
}

const ALLOW_HEADERS = ['Authorization', 'Content-Type', 'X-Request-Id', 'If-None-Match'];
const EXPOSE_HEADERS = [
  'X-Request-Id',
  'Retry-After',
  'ETag',
  'Content-Disposition',
  'X-Data-Attribution',
  'X-Translated-Via',
  'X-RateLimit-Limit',
  'X-RateLimit-Remaining',
];

export function cors(services: Services): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const origins = services.config(c.req.raw).corsOrigins;
    if (origins.length === 0) return next();
    const any = origins.includes('*');
    return honoCors({
      origin: (origin) => (any ? '*' : origins.includes(origin.replace(/\/+$/, '')) ? origin : null),
      allowMethods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
      allowHeaders: ALLOW_HEADERS,
      exposeHeaders: EXPOSE_HEADERS,
      maxAge: 600,
    })(c, next);
  };
}

export function timeout(services: Services): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const ms = services.config(c.req.raw).requestTimeoutMs;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () =>
          reject(
            new Vid2ContextError('timeout', `The request took longer than ${Math.round(ms / 1000)} s.`, {
              hint: 'Long videos can take minutes to transcribe. Retry (finished work is cached), or use a job for long audio.',
            }),
          ),
        ms,
      );
    });
    try {
      await Promise.race([next(), expired]);
    } finally {
      clearTimeout(timer);
    }
  };
}

export function auth(services: Services): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const cfg = services.config(c.req.raw);
    const raw = cfg.apiKeys;
    if (!raw || cfg.hosted || OPEN_PATHS.has(c.req.path) || c.req.method === 'OPTIONS') return next();
    const principal = await authenticate(c.req.header('authorization'), await apiKeysFor(raw));
    c.set('principal', principal);
    assertScope(principal, requiredScope(c.req.method, c.req.path), c.req.method, c.req.path);
    return next();
  };
}

export function rateLimit(services: Services, clientIp: (c: Context<AppEnv>) => string | undefined): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const cfg = services.config(c.req.raw);
    if (cfg.ratePerMinute <= 0 || cfg.hosted || OPEN_PATHS.has(c.req.path) || c.req.method === 'OPTIONS') return next();
    const principal = c.get('principal');
    const who = principal ? `key:${principal.name}` : `ip:${clientIp(c) ?? 'unknown'}`;
    const result = await takeToken(await services.kv(services.ctxFor(c.req.raw)), who, {
      perMinute: cfg.ratePerMinute,
      burst: cfg.rateBurst,
    });
    if (!result.ok) {
      throw new Vid2ContextError(
        'rate-limited',
        `Too many requests: the limit is ${cfg.ratePerMinute} per minute (bursts of ${cfg.rateBurst}).`,
        {
          hint: `Wait ${result.retryAfterSec} s before retrying (see Retry-After).`,
          retryAfterSec: result.retryAfterSec,
        },
      );
    }
    await next();
    c.header('x-ratelimit-limit', String(result.limit));
    c.header('x-ratelimit-remaining', String(result.remaining));
  };
}

/** Multipart overhead allowed on top of the upload cap (boundaries and part headers). */
const MULTIPART_SLACK = 64 * 1024;

export function bodyLimit(services: Services): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const cfg = services.config(c.req.raw);
    const isUpload = c.req.method === 'POST' && c.req.path.replace(/\/+$/, '') === '/api/v1/uploads';
    const maxSize = isUpload ? cfg.maxUploadBytes + MULTIPART_SLACK : cfg.maxBodyBytes;
    const before = c.req.raw;
    return honoBodyLimit({
      maxSize,
      onError: () => {
        throw isUpload
          ? tooLarge(cfg.maxUploadMb)
          : new Vid2ContextError('too-large', `The request body is larger than ${Math.round(cfg.maxBodyBytes / 1024)} KB.`, {
              hint: 'Send fewer inputs per request, or raise VID2CONTEXT_MAX_BODY_KB on the server.',
            });
      },
    })(c, async () => {
      // The body limit re-wraps chunked bodies in a new Request; keep the same Ctx for it.
      if (c.req.raw !== before) services.alias(c.req.raw, before);
      await next();
    });
  };
}

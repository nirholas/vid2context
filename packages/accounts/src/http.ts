/**
 * Hosted-mode HTTP surface, for item 46 or the integration pass to mount:
 *
 *   app.use('*', hostedMiddleware(deps));            // before every route
 *   app.route('/api/v1', accountsRoutes(deps));      // /auth/*, /me, /me/usage, /me/keys
 *
 * Both are inert unless VID2CONTEXT_HOSTED=1: the middleware passes every
 * request through and the routes answer 404. With hosted mode on, the
 * middleware guards every route under /api/v1 except /health, /auth/* and
 * /bots/*: a per-IP token bucket, then a session cookie or `Authorization:
 * Bearer v2c_...` key (or the anonymous plan per IP, with Turnstile on routes
 * that can trigger speech-to-text), then the daily request quota. It puts the
 * caller on the Hono context as `account` (Account | null) and `hosted`
 * (HostedRequest). Routes that run the pipeline should use
 * `c.var.hosted?.registry(registry)` and `c.var.hosted?.storage(storage, ...)`
 * so speech-to-text minutes and LLM calls are counted and public videos come
 * from the shared cache.
 *
 * Privacy: logs carry the account id (or a keyed hash of the IP), never the
 * GitHub login, and never together with request content.
 */
import {
  type Ctx,
  hasKv,
  type KvStore,
  MemoryKv,
  type Registry,
  type Storage,
  type TranscriptMode,
  Vid2ContextError,
} from '@vid2context/core';
import { type Context, Hono, type MiddlewareHandler } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { type Account, getAccount, upsertGithubAccount } from './accounts.ts';
import { createApiKey, deleteApiKey, listApiKeys, resolveApiKey } from './apikeys.ts';
import { type HostedConfig, readHostedConfig, requireSessionSecret, safeLocalPath } from './config.ts';
import { hmac, sign, unsign } from './crypto.ts';
import { beginGithubLogin, consumeOAuthState, exchangeGithubCode, fetchGithubIdentity, OAUTH_STATE_TTL_SEC } from './github.ts';
import { ANONYMOUS_PLAN, type Plan, planFor } from './plans.ts';
import { type IpLimiter, KvWindowLimiter, MemoryTokenBucket } from './ratelimit.ts';
import { createSession, deleteSession, readSession, SESSION_COOKIE } from './sessions.ts';
import { sharedCache } from './shared-cache.ts';
import { turnstileToken, verifyTurnstile } from './turnstile.ts';
import { type LimitHit, secondsUntilUtcMidnight, UsageMeter, utcDay } from './usage.ts';

export const OAUTH_COOKIE = '__Host-v2c_oauth';

export interface AccountsDeps {
  /** Build a Ctx for one request (env, fetch, logger, abort signal), as for every other route. */
  makeCtx: (req: Request) => Ctx;
  /** The instance storage. Its KvStore (when it has one) holds accounts, sessions, keys, usage and the shared cache. */
  storage?: (ctx: Ctx) => Promise<Storage | null> | Storage | null;
  /** A KvStore to use instead of the storage's. */
  kv?: KvStore;
  /** Where the API is mounted. Default '/api/v1'. */
  basePath?: string;
  /** The client IP for this request. On Node pass `(c) => getConnInfo(c).remote.address` from '@hono/node-server/conninfo'. */
  clientIp?: (c: Context) => string | undefined;
  /** Replace the per-IP limiter (tests, or a Durable Object based one). */
  ipLimiter?: IpLimiter;
  /** More path prefixes, relative to basePath, that the middleware leaves alone. */
  exempt?: string[];
  /** Clock, for tests. */
  now?: () => number;
}

export type AuthVia = 'session' | 'api-key' | 'anonymous';

/** What the middleware puts on the Hono context as `hosted`. */
export interface HostedRequest {
  /** Account id, or `ip_<hash>` for anonymous callers. Safe to log. */
  principal: string;
  account: Account | null;
  via: AuthVia;
  planName: string;
  plan: Plan;
  meter: UsageMeter;
  kv: KvStore;
  config: HostedConfig;
  /** The registry for this request, with speech-to-text, video and LLM rungs metered against the caller's plan. */
  registry(inner: Registry): Registry;
  /**
   * The storage for this request, with public videos served from and saved to the shared cache.
   * Pass `userCredentials: true` when the request fetched with the user's own cookies or provider keys.
   */
  storage(
    inner: Storage,
    opts: { mode?: TranscriptMode; language?: string; refresh?: boolean; userCredentials?: boolean },
  ): Storage;
}

declare module 'hono' {
  interface ContextVariableMap {
    /** The signed-in account in hosted mode, null for anonymous callers. Unset when hosted mode is off. */
    account: Account | null;
    hosted: HostedRequest;
  }
}

/** The signed-in account on this request, or null (anonymous, or hosted mode off). */
export function accountOf(c: Context): Account | null {
  return (c.get('account') as Account | null | undefined) ?? null;
}

// ---------------------------------------------------------------- shared helpers

let processKv: MemoryKv | undefined;
let warnedMemoryKv = false;

async function kvFor(deps: AccountsDeps, ctx: Ctx): Promise<KvStore> {
  if (deps.kv) return deps.kv;
  const storage = deps.storage ? await deps.storage(ctx) : null;
  if (hasKv(storage)) return storage;
  if (!warnedMemoryKv) {
    warnedMemoryKv = true;
    ctx.log.warn(
      'hosted mode is using process memory for accounts, sessions and usage: everything is lost on restart. Configure a storage backend with KV (SQLite, Cloudflare KV, Postgres).',
    );
  }
  processKv ??= new MemoryKv();
  return processKv;
}

function relPath(path: string, base: string): string | null {
  if (path === base) return '/';
  if (path.startsWith(`${base}/`)) return path.slice(base.length);
  return null;
}

function errorJson(c: Context, status: ContentfulStatusCode, code: string, message: string, hint?: string): Response {
  return c.json({ error: { code, message, ...(hint ? { hint } : {}) }, attempts: [] }, status);
}

function unauthorized(c: Context, message: string, hint: string): Response {
  c.header('WWW-Authenticate', 'Bearer realm="vid2context"');
  return errorJson(c, 401, 'auth', message, hint);
}

function limitResponse(c: Context, hit: LimitHit | { message: string; hint: string; retryAfterSec: number }): Response {
  c.header('Retry-After', String(hit.retryAfterSec));
  return errorJson(c, 429, 'rate-limited', hit.message, hit.hint);
}

const SIGN_IN_HINT = 'Sign in with GitHub at /api/v1/auth/github/login, or send an API key as "Authorization: Bearer v2c_...".';

async function identify(
  c: Context,
  kv: KvStore,
  secret: string,
  now: number,
): Promise<{ account: Account | null; via: AuthVia } | { invalid: string }> {
  const auth = c.req.header('authorization');
  if (auth) {
    const m = /^Bearer\s+(\S+)$/i.exec(auth.trim());
    const rec = m?.[1] ? await resolveApiKey(kv, m[1], now) : null;
    const account = rec ? await getAccount(kv, rec.accountId) : null;
    if (!account) return { invalid: 'This API key is not valid. It may have been deleted.' };
    return { account, via: 'api-key' };
  }
  const session = await readSession(kv, secret, getCookie(c, SESSION_COOKIE), now);
  const account = session ? await getAccount(kv, session.accountId) : null;
  return account ? { account, via: 'session' } : { account: null, via: 'anonymous' };
}

function clientIp(c: Context, ctx: Ctx, config: HostedConfig, deps: AccountsDeps): string | undefined {
  const fromDeps = deps.clientIp?.(c);
  if (fromDeps) return fromDeps;
  if (config.ipHeader) {
    // The last address is the one the closest (trusted) proxy added; earlier ones are client-supplied.
    const v = c.req.header(config.ipHeader)?.split(',').at(-1)?.trim();
    if (v) return v;
  }
  if (ctx.runtime === 'workers') return c.req.header('cf-connecting-ip') ?? undefined;
  return undefined;
}

/** GET routes (relative to basePath) that only read and can never start speech-to-text. */
const READ_ONLY_PREFIXES = [
  '/health',
  '/metadata',
  '/formats',
  '/items',
  '/comments',
  '/library',
  '/search',
  '/models',
  '/openapi.json',
  '/skips',
  '/caption-languages',
  '/collections',
  '/webhooks',
  '/me',
];

function under(rel: string, prefix: string): boolean {
  return rel === prefix || rel.startsWith(prefix.endsWith('/') ? prefix : `${prefix}/`);
}

/**
 * True when a request may start speech-to-text (and so needs Turnstile from
 * anonymous callers). Unknown routes count as able to: new routes are
 * protected until they are added to the read-only list.
 */
export function canTriggerStt(method: string, rel: string, mode: string | undefined): boolean {
  if (mode === 'captions') return false;
  const m = method.toUpperCase();
  if (m === 'DELETE' || m === 'OPTIONS' || m === 'HEAD') return false;
  if (m === 'GET' && (READ_ONLY_PREFIXES.some((p) => under(rel, p)) || /^\/jobs\/[^/]+(\/events)?$/.test(rel))) return false;
  if (m === 'PATCH' && under(rel, '/collections')) return false;
  return true;
}

function sameOrigin(c: Context, env: Ctx['env']): boolean {
  const origin = c.req.header('origin');
  if (!origin) return true;
  let host: string;
  try {
    host = new URL(origin).host;
  } catch {
    return false;
  }
  const allowed = [new URL(c.req.url).host, c.req.header('x-forwarded-host'), c.req.header('host')];
  if (allowed.includes(host)) return true;
  return (env.VID2CONTEXT_CORS_ORIGINS ?? '')
    .split(',')
    .map((s) => s.trim())
    .includes(origin);
}

// ---------------------------------------------------------------- middleware

/**
 * Hosted-mode guard. Install before every route; it ignores paths outside
 * basePath and the exempt ones (/health, /auth/*, /bots/*).
 */
export function hostedMiddleware(deps: AccountsDeps): MiddlewareHandler {
  const base = deps.basePath ?? '/api/v1';
  const exempt = ['/health', '/auth', '/bots', ...(deps.exempt ?? [])];
  const now = deps.now ?? Date.now;
  let bucket: { key: string; limiter: MemoryTokenBucket } | undefined;
  let warnedNoIp = false;

  return async (c, next) => {
    const ctx = deps.makeCtx(c.req.raw);
    const config = readHostedConfig(ctx.env);
    if (!config.hosted) return next();
    const rel = relPath(c.req.path, base);
    if (rel === null || exempt.some((p) => under(rel, p))) return next();

    const secret = requireSessionSecret(config);
    const kv = await kvFor(deps, ctx);
    const t = now();

    // 1. Per-IP token bucket, before any other work.
    const ip = clientIp(c, ctx, config, deps);
    if (!ip && !warnedNoIp) {
      warnedNoIp = true;
      ctx.log.warn(
        'hosted mode cannot see client IPs, so every caller shares one per-IP bucket. Pass clientIp in the deps or set VID2CONTEXT_IP_HEADER.',
      );
    }
    const ipHash = (await hmac(secret, `ip:${ip ?? 'unknown'}`)).slice(0, 22);
    const limiters: IpLimiter[] = [];
    if (deps.ipLimiter) limiters.push(deps.ipLimiter);
    else {
      const key = `${config.ipBurst}/${config.ipPerMinute}`;
      if (bucket?.key !== key) bucket = { key, limiter: new MemoryTokenBucket(config.ipBurst, config.ipPerMinute) };
      limiters.push(bucket.limiter);
      if (ctx.runtime === 'workers') limiters.push(new KvWindowLimiter(kv, config.ipPerMinute));
    }
    for (const l of limiters) {
      const r = await l.take(ipHash, t);
      if (!r.ok) {
        return limitResponse(c, {
          message: 'Too many requests from this address.',
          hint: `Wait ${r.retryAfterSec} s and retry. Signed-in users share the same per-address limit, so spread requests out.`,
          retryAfterSec: r.retryAfterSec,
        });
      }
    }

    // 2. Who is calling.
    const who = await identify(c, kv, secret, t);
    if ('invalid' in who) return unauthorized(c, who.invalid, SIGN_IN_HINT);
    const { account, via } = who;
    if (!account && !config.anonymous) {
      return unauthorized(c, 'This server needs you to sign in.', SIGN_IN_HINT);
    }
    const { name: planName, plan } = account
      ? planFor(account.plan, config.plans, ctx.env)
      : planFor(ANONYMOUS_PLAN, config.plans, { ...ctx.env, VID2CONTEXT_DEFAULT_PLAN: ANONYMOUS_PLAN });
    const principal = account ? account.id : `ip_${ipHash}`;
    const meter = new UsageMeter(kv, principal, planName, plan, now);
    const mode = c.req.query('mode');
    const sttPossible = canTriggerStt(c.req.method, rel, mode);

    // 3. Anonymous callers prove they are human before anything that can spend speech-to-text.
    if (!account && sttPossible) {
      if (!config.turnstileSecret) {
        return errorJson(
          c,
          403,
          'auth',
          'Anonymous transcription is turned off on this server.',
          `${SIGN_IN_HINT} Or pass mode=captions to use existing captions only.`,
        );
      }
      const check = await verifyTurnstile(ctx, {
        secret: config.turnstileSecret,
        token: turnstileToken(c.req.raw.headers),
        remoteIp: ip,
      });
      if (!check.success) {
        return errorJson(
          c,
          403,
          'auth',
          `The Turnstile check failed (${check.errorCodes.join(', ') || 'no reason given'}).`,
          'Complete the Turnstile challenge and send its token in the X-Turnstile-Token header. A token works once and expires after 5 minutes. Signed-in users skip this check.',
        );
      }
    }

    // 4. Daily quotas. Account management under /me is not counted.
    if (!under(rel, '/me')) {
      const hit = await meter.chargeRequest();
      if (hit) return limitResponse(c, hit);
    }
    const collection = /^\/collections\/([^/]+)\/items$/.exec(rel);
    if (collection?.[1] && c.req.method === 'POST' && deps.storage) {
      const storage = await deps.storage(ctx);
      const body = (await c.req.json().catch(() => null)) as { inputs?: unknown } | null;
      const adding = Array.isArray(body?.inputs) ? body.inputs.length : 0;
      const existing = storage ? await storage.getCollection(decodeURIComponent(collection[1])) : null;
      if (existing && existing.videoIds.length + adding > plan.maxCollectionSize) {
        return errorJson(
          c,
          413,
          'too-large',
          `A collection on the ${planName} plan holds at most ${plan.maxCollectionSize} videos; this one has ${existing.videoIds.length}.`,
          'Remove videos you no longer need, or split the work into another collection.',
        );
      }
    }

    const hosted: HostedRequest = {
      principal,
      account,
      via,
      planName,
      plan,
      meter,
      kv,
      config,
      registry: (inner) => meter.wrapRegistry(inner),
      storage: (inner, opts) =>
        sharedCache(inner, {
          kv,
          userCredentials: opts.userCredentials ?? false,
          mode: opts.mode,
          language: opts.language,
          refresh: opts.refresh,
          ttlSec: config.sharedCacheTtlSec,
          publicPlatforms: config.sharedCachePlatforms,
        }),
    };
    c.set('account', account);
    c.set('hosted', hosted);
    ctx.log.debug('hosted request', { principal, via, plan: planName });

    await next();

    // A metered rung refused because a limit ran out mid-request: say so instead of a generic failure.
    if (meter.blocked && c.res.status >= 400) {
      const res = limitResponse(c, meter.blocked);
      c.res = undefined;
      c.res = res;
    }
  };
}

/** For ingest jobs: throw when adding videos would take a collection past the caller's plan. */
export function assertCollectionSize(hosted: HostedRequest | undefined, totalVideos: number): void {
  if (!hosted || totalVideos <= hosted.plan.maxCollectionSize) return;
  throw new Vid2ContextError(
    'too-large',
    `A collection on the ${hosted.planName} plan holds at most ${hosted.plan.maxCollectionSize} videos; this would make ${totalVideos}.`,
    { hint: 'Remove videos you no longer need, or split the work into another collection.' },
  );
}

// ---------------------------------------------------------------- routes

function hostedOff(): Vid2ContextError {
  return new Vid2ContextError('not-found', 'Hosted mode is off on this server.', {
    hint: 'Set VID2CONTEXT_HOSTED=1 (and the settings in packages/accounts/README.md) to enable sign-in and accounts.',
  });
}

const COOKIE_BASE = { httpOnly: true, secure: true, sameSite: 'Lax', path: '/' } as const;

/** /auth/github/login, /auth/github/callback, /auth/logout, /me, /me/usage, /me/keys. Mount under basePath. */
export function accountsRoutes(deps: AccountsDeps): Hono {
  const base = deps.basePath ?? '/api/v1';
  const now = deps.now ?? Date.now;
  const app = new Hono();

  async function setup(c: Context): Promise<{ ctx: Ctx; config: HostedConfig; secret: string; kv: KvStore }> {
    const ctx = deps.makeCtx(c.req.raw);
    const config = readHostedConfig(ctx.env);
    if (!config.hosted) throw hostedOff();
    const secret = requireSessionSecret(config);
    return { ctx, config, secret, kv: await kvFor(deps, ctx) };
  }

  /** The caller from the middleware when it ran, else resolved here (routes mounted without the middleware). */
  async function caller(
    c: Context,
    kv: KvStore,
    secret: string,
  ): Promise<{ account: Account | null; via: AuthVia } | { invalid: string }> {
    const hosted = c.get('hosted') as HostedRequest | undefined;
    if (hosted) return { account: hosted.account, via: hosted.via };
    return identify(c, kv, secret, now());
  }

  function github(config: HostedConfig): NonNullable<HostedConfig['github']> {
    if (!config.github) {
      throw new Vid2ContextError('no-provider', 'GitHub sign-in is not configured on this server.', {
        hint: 'Set GITHUB_OAUTH_CLIENT_ID and GITHUB_OAUTH_CLIENT_SECRET from a GitHub OAuth app (see packages/accounts/README.md).',
      });
    }
    return config.github;
  }

  function redirectUri(c: Context, config: HostedConfig): string {
    return config.github?.redirectUri ?? `${new URL(c.req.url).origin}${base}/auth/github/callback`;
  }

  app.get('/auth/github/login', async (c) => {
    const { config, secret, kv } = await setup(c);
    const gh = github(config);
    const returnTo = safeLocalPath(c.req.query('return_to')) ?? config.postLoginPath;
    const { url, state } = await beginGithubLogin(kv, { clientId: gh.clientId, redirectUri: redirectUri(c, config), returnTo });
    // Binds the state to this browser, so a sign-in started elsewhere cannot be completed here (login CSRF).
    setCookie(c, OAUTH_COOKIE, await sign(secret, state), { ...COOKIE_BASE, maxAge: OAUTH_STATE_TTL_SEC });
    return c.redirect(url, 302);
  });

  app.get('/auth/github/callback', async (c) => {
    const { ctx, config, secret, kv } = await setup(c);
    const gh = github(config);
    const stateParam = c.req.query('state');
    const bound = await unsign(secret, getCookie(c, OAUTH_COOKIE) ?? '');
    deleteCookie(c, OAUTH_COOKIE, { path: '/', secure: true });
    if (!stateParam || bound !== stateParam) {
      throw new Vid2ContextError('bad-request', 'This sign-in was started in another browser, or it expired.', {
        hint: 'Start sign-in again from /api/v1/auth/github/login in this browser.',
      });
    }
    const state = await consumeOAuthState(kv, stateParam);
    if (!state) {
      throw new Vid2ContextError('bad-request', 'This sign-in link expired or was already used.', {
        hint: 'Start sign-in again from /api/v1/auth/github/login. A sign-in must finish within 10 minutes.',
      });
    }
    const error = c.req.query('error');
    if (error) {
      const sep = state.returnTo.includes('?') ? '&' : '?';
      return c.redirect(`${state.returnTo}${sep}login=${error === 'access_denied' ? 'cancelled' : 'failed'}`, 302);
    }
    const code = c.req.query('code');
    if (!code || code.length > 256) {
      throw new Vid2ContextError('bad-request', 'GitHub did not return an authorization code.', {
        hint: 'Start sign-in again from /api/v1/auth/github/login.',
      });
    }
    const token = await exchangeGithubCode(ctx, {
      clientId: gh.clientId,
      clientSecret: gh.clientSecret,
      code,
      redirectUri: state.redirectUri,
      verifier: state.verifier,
    });
    const identity = await fetchGithubIdentity(ctx, token);
    const account = await upsertGithubAccount(kv, identity, { plan: planFor(undefined, config.plans, ctx.env).name });
    const { cookie } = await createSession(kv, secret, account.id, { ttlSec: config.sessionTtlSec, now: now() });
    setCookie(c, SESSION_COOKIE, cookie, { ...COOKIE_BASE, maxAge: config.sessionTtlSec });
    ctx.log.info('signed in', { account: account.id });
    return c.redirect(state.returnTo, 302);
  });

  app.post('/auth/logout', async (c) => {
    const { secret, kv } = await setup(c);
    await deleteSession(kv, secret, getCookie(c, SESSION_COOKIE));
    deleteCookie(c, SESSION_COOKIE, { path: '/', secure: true });
    return c.body(null, 204);
  });

  app.get('/me', async (c) => {
    const { secret, kv } = await setup(c);
    const who = await caller(c, kv, secret);
    if ('invalid' in who) return unauthorized(c, who.invalid, SIGN_IN_HINT);
    if (!who.account) return unauthorized(c, 'You are not signed in.', SIGN_IN_HINT);
    const { id, login, plan, avatarUrl } = who.account;
    return c.json({ id, login, plan, ...(avatarUrl ? { avatarUrl } : {}) });
  });

  app.get('/me/usage', async (c) => {
    const { ctx, config, secret, kv } = await setup(c);
    let meter = (c.get('hosted') as HostedRequest | undefined)?.meter;
    if (!meter) {
      const who = await caller(c, kv, secret);
      if ('invalid' in who) return unauthorized(c, who.invalid, SIGN_IN_HINT);
      if (!who.account) return unauthorized(c, 'You are not signed in.', SIGN_IN_HINT);
      const { name, plan } = planFor(who.account.plan, config.plans, ctx.env);
      meter = new UsageMeter(kv, who.account.id, name, plan, now);
    }
    const used = await meter.read();
    const t = now();
    return c.json({
      period: utcDay(t),
      resetsAt: new Date(t + secondsUntilUtcMidnight(t) * 1000).toISOString(),
      plan: meter.planName,
      used: { requests: used.requests, sttMinutes: Math.round(used.sttSeconds / 6) / 10, llmCalls: used.llmCalls },
      limits: { ...meter.plan },
    });
  });

  async function keyOwner(c: Context, needSession: boolean): Promise<Account | Response> {
    const { ctx, secret, kv } = await setup(c);
    const who = await caller(c, kv, secret);
    if ('invalid' in who) return unauthorized(c, who.invalid, SIGN_IN_HINT);
    if (!who.account) return unauthorized(c, 'You are not signed in.', SIGN_IN_HINT);
    if (needSession && who.via !== 'session') {
      return errorJson(
        c,
        403,
        'auth',
        'API keys can only be created or deleted from a signed-in browser session.',
        'Sign in with GitHub and manage keys there.',
      );
    }
    if (needSession && !sameOrigin(c, ctx.env)) {
      return errorJson(c, 403, 'auth', 'Cross-site request refused.', 'Manage API keys from the vid2context site itself.');
    }
    return who.account;
  }

  app.get('/me/keys', async (c) => {
    const owner = await keyOwner(c, false);
    if (owner instanceof Response) return owner;
    const { kv } = await setup(c);
    return c.json({ keys: await listApiKeys(kv, owner.id) });
  });

  app.post('/me/keys', async (c) => {
    const owner = await keyOwner(c, true);
    if (owner instanceof Response) return owner;
    const { ctx, kv } = await setup(c);
    const body = (await c.req.json().catch(() => null)) as { name?: unknown } | null;
    const { key, record } = await createApiKey(kv, owner.id, body?.name, new Date(now()));
    ctx.log.info('api key created', { account: owner.id, key: record.id });
    const { accountId: _owner, ...info } = record;
    return c.json({ ...info, key }, 201);
  });

  app.delete('/me/keys/:id', async (c) => {
    const owner = await keyOwner(c, true);
    if (owner instanceof Response) return owner;
    const { ctx, kv } = await setup(c);
    const id = c.req.param('id');
    if (!(await deleteApiKey(kv, owner.id, id))) {
      throw new Vid2ContextError('not-found', `No API key ${id.slice(0, 40)} on this account.`, {
        hint: 'List your keys with GET /api/v1/me/keys.',
      });
    }
    ctx.log.info('api key deleted', { account: owner.id, key: id });
    return c.body(null, 204);
  });

  return app;
}

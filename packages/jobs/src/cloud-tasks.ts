/**
 * Google Cloud Tasks adapter. The producer creates an HTTP task that POSTs to
 * `<runUrl>/jobs/<id>/run` with an OIDC token for a service account; the run
 * endpoint verifies that token (issuer, audience, expiry, signature against
 * Google's JWKS fetched through ctx.fetch, and optionally the service account
 * email) before running the job. Uses plain fetch and WebCrypto only.
 */
import { type Ctx, type Env, errorFromResponse, Vid2ContextError } from '@vid2context/core';
import type { Dispatch } from './remote.ts';
import type { Job } from './types.ts';

export interface CloudTasksConfig {
  /** Full queue path: projects/<project>/locations/<location>/queues/<queue>. */
  queue: string;
  /** Public base URL of the API, including /api/v1 (tasks POST to `${runUrl}/jobs/<id>/run`). */
  runUrl: string;
  /** Service account Cloud Tasks signs the OIDC token as. */
  serviceAccountEmail: string;
  /** Token audience. Default: `runUrl`. */
  audience?: string;
}

const QUEUE_RE = /^projects\/[a-z][a-z0-9-]{4,61}[a-z0-9]\/locations\/[a-z0-9-]+\/queues\/[A-Za-z0-9-]{1,100}$/;

/** Read the Cloud Tasks settings from env, or null when they are not all set. */
export function cloudTasksConfigFromEnv(env: Env): CloudTasksConfig | null {
  const queue = env.VID2CONTEXT_CLOUD_TASKS_QUEUE;
  const runUrl = env.VID2CONTEXT_CLOUD_TASKS_RUN_URL;
  const serviceAccountEmail = env.VID2CONTEXT_CLOUD_TASKS_SERVICE_ACCOUNT;
  if (!queue || !runUrl || !serviceAccountEmail) return null;
  if (!QUEUE_RE.test(queue)) {
    throw new Vid2ContextError('bad-request', 'VID2CONTEXT_CLOUD_TASKS_QUEUE is not a queue path.', {
      hint: 'Use projects/<project>/locations/<location>/queues/<queue>.',
    });
  }
  if (!/^https:\/\//.test(runUrl)) {
    throw new Vid2ContextError('bad-request', 'VID2CONTEXT_CLOUD_TASKS_RUN_URL must be an https URL.', {
      hint: 'Use the public base of the API, for example https://vid2context-xyz.a.run.app/api/v1.',
    });
  }
  const audience = env.VID2CONTEXT_CLOUD_TASKS_AUDIENCE;
  return { queue, runUrl: runUrl.replace(/\/+$/, ''), serviceAccountEmail, ...(audience ? { audience } : {}) };
}

export interface CloudTask {
  name: string;
  scheduleTime?: string;
  httpRequest: {
    httpMethod: 'POST';
    url: string;
    headers: Record<string, string>;
    body: string;
    oidcToken: { serviceAccountEmail: string; audience: string };
  };
}

/**
 * The task for one attempt of a job. The task name includes the attempt, so
 * Cloud Tasks deduplicates a repeated dispatch of the same attempt.
 */
export function buildCloudTask(cfg: CloudTasksConfig, job: Job & { attempts?: number }, delayMs = 0, now = Date.now()): CloudTask {
  const attempt = job.attempts ?? 0;
  const body = btoa(JSON.stringify({ jobId: job.id }));
  return {
    name: `${cfg.queue}/tasks/${job.id}-a${attempt}-${Math.floor(now / 1000)}`,
    ...(delayMs > 0 ? { scheduleTime: new Date(now + delayMs).toISOString() } : {}),
    httpRequest: {
      httpMethod: 'POST',
      url: `${cfg.runUrl}/jobs/${encodeURIComponent(job.id)}/run`,
      headers: { 'content-type': 'application/json' },
      body,
      oidcToken: { serviceAccountEmail: cfg.serviceAccountEmail, audience: cfg.audience ?? cfg.runUrl },
    },
  };
}

/** OAuth access token for the Cloud Tasks API. */
export type AccessTokenSource = () => Promise<string>;

/**
 * Access tokens from the GCP metadata server (Cloud Run, GCE, Cloud
 * Functions), cached until a minute before they expire.
 */
export function metadataAccessToken(ctx: Ctx): AccessTokenSource {
  let cached: { token: string; expiresAt: number } | null = null;
  return async () => {
    if (cached && cached.expiresAt > Date.now() + 60_000) return cached.token;
    const res = await ctx.fetch('http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token', {
      headers: { 'Metadata-Flavor': 'Google' },
      ...(ctx.signal ? { signal: ctx.signal } : {}),
    });
    if (!res.ok) throw await errorFromResponse(res, 'GCP metadata token');
    const json = (await res.json()) as { access_token: string; expires_in: number };
    cached = { token: json.access_token, expiresAt: Date.now() + json.expires_in * 1000 };
    return cached.token;
  };
}

/** Producer: create one HTTP task per dispatch. */
export function cloudTasksDispatch(cfg: CloudTasksConfig, ctx: Ctx, accessToken: AccessTokenSource = metadataAccessToken(ctx)): Dispatch {
  return async (job, delayMs) => {
    const task = buildCloudTask(cfg, job, delayMs);
    const res = await ctx.fetch(`https://cloudtasks.googleapis.com/v2/${cfg.queue}/tasks`, {
      method: 'POST',
      headers: { authorization: `Bearer ${await accessToken()}`, 'content-type': 'application/json' },
      body: JSON.stringify({ task }),
      ...(ctx.signal ? { signal: ctx.signal } : {}),
    });
    if (res.status === 409) {
      await res.body?.cancel();
      return; // The same task already exists: this dispatch is a duplicate.
    }
    if (!res.ok) throw await errorFromResponse(res, 'Cloud Tasks createTask');
    await res.body?.cancel();
  };
}

// OIDC verification

export const GOOGLE_JWKS_URL = 'https://www.googleapis.com/oauth2/v3/certs';
const GOOGLE_ISSUERS = new Set(['https://accounts.google.com', 'accounts.google.com']);
/** Allowed clock difference, in seconds. */
const SKEW_SEC = 60;

export interface Jwk {
  kty: string;
  kid: string;
  n: string;
  e: string;
  alg?: string;
  use?: string;
}

export interface GoogleIdClaims {
  iss: string;
  aud: string;
  sub: string;
  exp: number;
  iat: number;
  email?: string;
  email_verified?: boolean;
  azp?: string;
}

export interface VerifyOptions {
  /** Expected `aud`: the audience configured on the task. */
  audience: string;
  /** When set, `email` must equal it and be verified. */
  serviceAccountEmail?: string;
  /** Seconds since the epoch. Default: now. */
  nowSec?: number;
  jwksUrl?: string;
}

function unauthorized(message: string): Vid2ContextError {
  return new Vid2ContextError('auth', message, {
    status: 401,
    hint: 'Only Cloud Tasks may call this endpoint: check the queue OIDC service account and audience.',
  });
}

function b64urlBytes(s: string): Uint8Array<ArrayBuffer> {
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function b64urlJson<T>(s: string): T {
  return JSON.parse(new TextDecoder().decode(b64urlBytes(s))) as T;
}

interface JwksCache {
  keys: Map<string, CryptoKey>;
  expiresAt: number;
}

/** Imports the RSA signing keys of a JWKS document. Keys of other types are skipped. */
export async function importJwks(doc: { keys: Jwk[] }): Promise<Map<string, CryptoKey>> {
  const out = new Map<string, CryptoKey>();
  for (const jwk of doc.keys ?? []) {
    if (jwk.kty !== 'RSA' || (jwk.alg && jwk.alg !== 'RS256') || (jwk.use && jwk.use !== 'sig')) continue;
    const key = await crypto.subtle.importKey(
      'jwk',
      { kty: 'RSA', n: jwk.n, e: jwk.e, alg: 'RS256', ext: true },
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      false,
      ['verify'],
    );
    out.set(jwk.kid, key);
  }
  return out;
}

/** Verifies Google-issued OIDC tokens; caches the JWKS for its Cache-Control max-age. */
export class GoogleOidcVerifier {
  private cache: JwksCache | null = null;

  constructor(private opts: VerifyOptions) {}

  private async keys(ctx: Ctx, force: boolean): Promise<Map<string, CryptoKey>> {
    if (!force && this.cache && this.cache.expiresAt > Date.now()) return this.cache.keys;
    const res = await ctx.fetch(this.opts.jwksUrl ?? GOOGLE_JWKS_URL, ctx.signal ? { signal: ctx.signal } : {});
    if (!res.ok) throw await errorFromResponse(res, 'Google JWKS');
    const maxAge = Number(/max-age=(\d+)/.exec(res.headers.get('cache-control') ?? '')?.[1] ?? 3600);
    const keys = await importJwks((await res.json()) as { keys: Jwk[] });
    this.cache = { keys, expiresAt: Date.now() + Math.min(maxAge, 86_400) * 1000 };
    return keys;
  }

  /** Returns the claims of a valid token; throws `auth` (status 401) otherwise. */
  async verify(token: string, ctx: Ctx): Promise<GoogleIdClaims> {
    const parts = token.split('.');
    if (parts.length !== 3 || parts.some((p) => !/^[A-Za-z0-9_-]+$/.test(p))) throw unauthorized('Malformed bearer token.');
    const [h, p, s] = parts as [string, string, string];
    let header: { alg?: string; kid?: string };
    let claims: GoogleIdClaims;
    try {
      header = b64urlJson(h);
      claims = b64urlJson(p);
    } catch {
      throw unauthorized('Malformed bearer token.');
    }
    if (header.alg !== 'RS256' || !header.kid) throw unauthorized('The token is not RS256-signed with a key id.');

    let key = (await this.keys(ctx, false)).get(header.kid);
    if (!key) key = (await this.keys(ctx, true)).get(header.kid); // Google rotated its keys.
    if (!key) throw unauthorized('The token was not signed by a current Google key.');
    const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, b64urlBytes(s), new TextEncoder().encode(`${h}.${p}`));
    if (!ok) throw unauthorized('The token signature is invalid.');

    checkClaims(claims, this.opts);
    return claims;
  }
}

/** Issuer, audience, time and (optionally) service account checks on verified claims. */
export function checkClaims(claims: GoogleIdClaims, opts: VerifyOptions): void {
  const now = opts.nowSec ?? Math.floor(Date.now() / 1000);
  if (!GOOGLE_ISSUERS.has(claims.iss)) throw unauthorized('The token was not issued by Google.');
  if (claims.aud !== opts.audience) throw unauthorized('The token audience does not match this endpoint.');
  if (typeof claims.exp !== 'number' || claims.exp + SKEW_SEC < now) throw unauthorized('The token has expired.');
  if (typeof claims.iat === 'number' && claims.iat - SKEW_SEC > now) throw unauthorized('The token is not valid yet.');
  if (opts.serviceAccountEmail && (claims.email !== opts.serviceAccountEmail || claims.email_verified !== true)) {
    throw unauthorized('The token belongs to another service account.');
  }
}

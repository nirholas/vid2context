/**
 * Hosted-mode settings, read from the request's env (ctx.env), never from
 * process.env directly. Every variable is documented in docs/providers.md
 * ("Hosted mode") and .env.example.
 */
import type { Env } from '@vid2context/core';
import { type Plan, parsePlans } from './plans.ts';

export interface HostedConfig {
  /** VID2CONTEXT_HOSTED=1. When false, the middleware passes everything through and the routes answer 404. */
  hosted: boolean;
  /** VID2CONTEXT_ANONYMOUS=1: callers without a session or key are served on the anonymous plan, per IP. */
  anonymous: boolean;
  /** VID2CONTEXT_SESSION_SECRET: signs cookies and keys the IP hashes. At least 32 characters. */
  sessionSecret?: string;
  sessionTtlSec: number;
  github?: { clientId: string; clientSecret: string; redirectUri?: string };
  /** TURNSTILE_SECRET: Cloudflare Turnstile secret key for anonymous requests that can trigger speech-to-text. */
  turnstileSecret?: string;
  plans: Record<string, Plan>;
  sharedCacheTtlSec: number;
  sharedCachePlatforms: string[];
  /** Token bucket in front of every route: capacity and refill per minute, per IP. */
  ipBurst: number;
  ipPerMinute: number;
  /** Request header that carries the client IP behind a trusted proxy (for example x-forwarded-for). */
  ipHeader?: string;
  /** Where the browser lands after sign-in when the login link has no return_to. */
  postLoginPath: string;
}

const DAY = 86_400;

function on(v: string | undefined): boolean {
  return v === '1' || v === 'true' || v === 'yes';
}

function num(v: string | undefined, fallback: number, name: string): number {
  if (v === undefined || v.trim() === '') return fallback;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) throw new Error(`${name} must be a number of 0 or more, got "${v.slice(0, 40)}".`);
  return n;
}

function list(v: string | undefined, fallback: string[]): string[] {
  if (v === undefined) return fallback;
  return v
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

/** A relative path on this site, never a scheme-relative or absolute URL (no open redirects). */
export function safeLocalPath(v: string | undefined | null): string | null {
  if (!v?.startsWith('/') || v.startsWith('//') || v.startsWith('/\\')) return null;
  if (/[\r\n\t\0]/.test(v) || v.length > 512) return null;
  return v;
}

const cache = new WeakMap<Env, { key: string; config: HostedConfig }>();

const KEYS = [
  'VID2CONTEXT_HOSTED',
  'VID2CONTEXT_ANONYMOUS',
  'VID2CONTEXT_SESSION_SECRET',
  'VID2CONTEXT_SESSION_TTL_DAYS',
  'GITHUB_OAUTH_CLIENT_ID',
  'GITHUB_OAUTH_CLIENT_SECRET',
  'GITHUB_OAUTH_REDIRECT_URI',
  'TURNSTILE_SECRET',
  'VID2CONTEXT_PLANS',
  'VID2CONTEXT_DEFAULT_PLAN',
  'VID2CONTEXT_SHARED_CACHE_TTL_DAYS',
  'VID2CONTEXT_SHARED_CACHE_PLATFORMS',
  'VID2CONTEXT_IP_BURST',
  'VID2CONTEXT_IP_PER_MINUTE',
  'VID2CONTEXT_IP_HEADER',
  'VID2CONTEXT_POST_LOGIN_PATH',
] as const;

/** Read hosted settings from env. Throws a plain Error (an operator mistake, answered as 500) on invalid values. */
export function readHostedConfig(env: Env): HostedConfig {
  const key = KEYS.map((k) => env[k] ?? '\u0000').join('\u0001');
  const hit = cache.get(env);
  if (hit && hit.key === key) return hit.config;

  const clientId = env.GITHUB_OAUTH_CLIENT_ID?.trim();
  const clientSecret = env.GITHUB_OAUTH_CLIENT_SECRET?.trim();
  const config: HostedConfig = {
    hosted: on(env.VID2CONTEXT_HOSTED),
    anonymous: on(env.VID2CONTEXT_ANONYMOUS),
    sessionSecret: env.VID2CONTEXT_SESSION_SECRET || undefined,
    sessionTtlSec: Math.round(num(env.VID2CONTEXT_SESSION_TTL_DAYS, 30, 'VID2CONTEXT_SESSION_TTL_DAYS') * DAY),
    github:
      clientId && clientSecret
        ? { clientId, clientSecret, redirectUri: env.GITHUB_OAUTH_REDIRECT_URI?.trim() || undefined }
        : undefined,
    turnstileSecret: env.TURNSTILE_SECRET?.trim() || undefined,
    plans: parsePlans(env.VID2CONTEXT_PLANS),
    sharedCacheTtlSec: Math.round(num(env.VID2CONTEXT_SHARED_CACHE_TTL_DAYS, 30, 'VID2CONTEXT_SHARED_CACHE_TTL_DAYS') * DAY),
    sharedCachePlatforms: list(env.VID2CONTEXT_SHARED_CACHE_PLATFORMS, ['youtube']),
    ipBurst: num(env.VID2CONTEXT_IP_BURST, 60, 'VID2CONTEXT_IP_BURST'),
    ipPerMinute: num(env.VID2CONTEXT_IP_PER_MINUTE, 120, 'VID2CONTEXT_IP_PER_MINUTE'),
    ipHeader: env.VID2CONTEXT_IP_HEADER?.trim().toLowerCase() || undefined,
    postLoginPath: safeLocalPath(env.VID2CONTEXT_POST_LOGIN_PATH) ?? '/app/',
  };
  cache.set(env, { key, config });
  return config;
}

/** The session secret, or a plain Error naming the variable (hosted mode cannot run without it). */
export function requireSessionSecret(config: HostedConfig): string {
  const s = config.sessionSecret;
  if (!s || s.length < 32) {
    throw new Error(
      'Hosted mode needs VID2CONTEXT_SESSION_SECRET with at least 32 characters (for example the output of `openssl rand -base64 48`).',
    );
  }
  return s;
}

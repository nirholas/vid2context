/**
 * Server settings read from the request's env (process.env on Node, Worker
 * vars and secrets on Cloudflare). Read per request, so a Worker picks up new
 * vars without code changes. Every value has a safe default.
 */
import { type Env, isPublicMode, limits } from '@vid2context/core';

export interface ServerConfig {
  /** Raw VID2CONTEXT_API_KEYS (parsed and cached by auth.ts). Empty: open mode. */
  apiKeys: string;
  /**
   * VID2CONTEXT_HOSTED=1: @vid2context/accounts guards /api/* (sessions, v2c_ keys, per-IP limits, quotas),
   * so the server's own key check and rate limit step aside.
   */
  hosted: boolean;
  /** Requests per minute per key (or per IP in open mode). 0 turns rate limiting off. */
  ratePerMinute: number;
  /** Bucket size: how many requests may arrive at once before the per-minute rate applies. */
  rateBurst: number;
  /** Allowed CORS origins. Empty: no CORS headers. `*` allows any origin. */
  corsOrigins: string[];
  /** Largest JSON or form body for routes other than /uploads, in bytes. */
  maxBodyBytes: number;
  /** Largest file accepted by POST /uploads, in bytes. */
  maxUploadBytes: number;
  maxUploadMb: number;
  /** How long an upload stays available, in minutes. */
  uploadTtlMin: number;
  /** Longest a request may take before it is answered with `timeout` (504). */
  requestTimeoutMs: number;
  /** Trust X-Forwarded-For and X-Real-IP for the client address (behind a reverse proxy only). */
  trustProxy: boolean;
  /** Refuse local file paths and file:// inputs. */
  publicMode: boolean;
  /** Write one JSON access log line per request to stderr. */
  accessLog: boolean;
}

function num(value: string | undefined, fallback: number, opts: { allowZero?: boolean } = {}): number {
  if (value === undefined || value.trim() === '') return fallback;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0 || (n === 0 && !opts.allowZero)) return fallback;
  return n;
}

function flag(value: string | undefined, fallback: boolean): boolean {
  const v = value?.trim().toLowerCase();
  if (v === undefined || v === '') return fallback;
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}

const MB = 1024 * 1024;

/** Default upload cap: 100 MB, the request body limit of the Cloudflare Workers free plan. */
export const DEFAULT_MAX_UPLOAD_MB = 100;

export function serverConfig(env: Env): ServerConfig {
  const ratePerMinute = num(env.VID2CONTEXT_RATE_LIMIT, 120, { allowZero: true });
  // limits() owns VID2CONTEXT_MAX_UPLOAD_MB when it is set; the server's own default is the Workers free-plan limit.
  const maxUploadMb = env.VID2CONTEXT_MAX_UPLOAD_MB?.trim() ? limits(env).maxUploadMb : DEFAULT_MAX_UPLOAD_MB;
  return {
    apiKeys: env.VID2CONTEXT_API_KEYS?.trim() ?? '',
    // Same reading as @vid2context/accounts (readHostedConfig).
    hosted: ['1', 'true', 'yes'].includes(env.VID2CONTEXT_HOSTED ?? ''),
    ratePerMinute,
    rateBurst: Math.max(1, Math.floor(num(env.VID2CONTEXT_RATE_BURST, Math.max(1, Math.ceil(ratePerMinute / 2))))),
    corsOrigins: (env.VID2CONTEXT_CORS_ORIGINS ?? '')
      .split(',')
      .map((s) => s.trim().replace(/\/+$/, ''))
      .filter(Boolean),
    maxBodyBytes: Math.floor(num(env.VID2CONTEXT_MAX_BODY_KB, 1024) * 1024),
    maxUploadBytes: maxUploadMb * MB,
    maxUploadMb,
    uploadTtlMin: num(env.VID2CONTEXT_UPLOAD_TTL_MIN, 60),
    requestTimeoutMs: Math.floor(num(env.VID2CONTEXT_REQUEST_TIMEOUT_MS, 300_000)),
    trustProxy: flag(env.VID2CONTEXT_TRUST_PROXY, false),
    publicMode: isPublicMode(env),
    accessLog: flag(env.VID2CONTEXT_ACCESS_LOG, true),
  };
}

/**
 * Settings for the remote MCP server, read from env (process.env on Node,
 * Worker vars and secrets on Workers). Parsed once per distinct env object.
 */
import type { Env } from '@vid2context/core';
import { sha256 } from './crypto.ts';
import { parsePasswordHash } from './scrypt.ts';

export type McpHttpMode = 'stateless' | 'session';

export interface McpHttpConfig {
  /** SHA-256 of each static bearer token in VID2CONTEXT_MCP_TOKENS. The tokens themselves are not kept. */
  tokenHashes: Uint8Array[];
  /** VID2CONTEXT_OWNER_PASSWORD_HASH when it parses; OAuth is enabled only when this is set. */
  ownerPasswordHash?: string;
  /** True when VID2CONTEXT_OWNER_PASSWORD_HASH is set but is not a valid scrypt hash. */
  ownerPasswordHashInvalid: boolean;
  /** Public origin (scheme + host) from VID2CONTEXT_MCP_PUBLIC_URL, without a trailing slash. */
  publicOrigin?: string;
  /** Origins allowed to call /mcp from a browser (CORS and Origin checks), from VID2CONTEXT_CORS_ORIGINS. */
  corsOrigins: string[];
  /** Extra Host header values accepted by the DNS-rebinding check, from VID2CONTEXT_MCP_ALLOWED_HOSTS. */
  allowedHosts: string[];
  /** Requests per minute per token (token bucket capacity and refill), from VID2CONTEXT_MCP_RATE_LIMIT. 0 turns it off. */
  rateLimitPerMin: number;
  mode?: McpHttpMode;
  sessionIdleSec: number;
  accessTtlSec: number;
  refreshTtlSec: number;
  /** Redirect URI prefixes clients may register or declare, from VID2CONTEXT_OAUTH_ALLOWED_REDIRECTS. Empty means any https or loopback URI. */
  allowedRedirects: string[];
  /** Largest request body on /mcp and the OAuth endpoints, in bytes, from VID2CONTEXT_MCP_MAX_BODY_KB (default 1024). */
  maxBodyBytes: number;
}

const list = (v: string | undefined): string[] =>
  (v ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

function int(v: string | undefined, fallback: number, min: number, max: number): number {
  const n = Number(v);
  if (v === undefined || v.trim() === '' || !Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

function origin(v: string | undefined): string | undefined {
  if (!v?.trim()) return undefined;
  try {
    return new URL(v.trim()).origin;
  } catch {
    return undefined;
  }
}

const cache = new WeakMap<Env, Promise<McpHttpConfig>>();

export function readConfig(env: Env): Promise<McpHttpConfig> {
  let hit = cache.get(env);
  if (!hit) {
    hit = parse(env);
    cache.set(env, hit);
  }
  return hit;
}

async function parse(env: Env): Promise<McpHttpConfig> {
  const rawHash = env.VID2CONTEXT_OWNER_PASSWORD_HASH?.trim();
  const hashOk = rawHash ? parsePasswordHash(rawHash) !== null : false;
  const mode = env.VID2CONTEXT_MCP_MODE?.trim();
  return {
    tokenHashes: await Promise.all(list(env.VID2CONTEXT_MCP_TOKENS).map((t) => sha256(t))),
    ownerPasswordHash: hashOk ? rawHash : undefined,
    ownerPasswordHashInvalid: Boolean(rawHash) && !hashOk,
    publicOrigin: origin(env.VID2CONTEXT_MCP_PUBLIC_URL),
    corsOrigins: list(env.VID2CONTEXT_CORS_ORIGINS)
      .map((o) => origin(o))
      .filter((o): o is string => Boolean(o)),
    allowedHosts: list(env.VID2CONTEXT_MCP_ALLOWED_HOSTS).map((h) => h.toLowerCase()),
    rateLimitPerMin: int(env.VID2CONTEXT_MCP_RATE_LIMIT, 120, 0, 100_000),
    mode: mode === 'stateless' || mode === 'session' ? mode : undefined,
    sessionIdleSec: int(env.VID2CONTEXT_MCP_SESSION_IDLE_SEC, 1800, 30, 86_400),
    accessTtlSec: int(env.VID2CONTEXT_OAUTH_ACCESS_TTL_SEC, 3600, 60, 86_400),
    refreshTtlSec: int(env.VID2CONTEXT_OAUTH_REFRESH_TTL_SEC, 30 * 86_400, 3600, 365 * 86_400),
    allowedRedirects: list(env.VID2CONTEXT_OAUTH_ALLOWED_REDIRECTS),
    maxBodyBytes: int(env.VID2CONTEXT_MCP_MAX_BODY_KB, 1024, 1, 1024 * 1024) * 1024,
  };
}

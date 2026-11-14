/**
 * Whether this deployment offers downloads, and its limits. Read from the
 * request's env, so a Worker or server picks up changes without code.
 *
 * Default: on for local and self-hosted use, off on public servers
 * (VID2CONTEXT_PUBLIC=1). A public server serving media files spends a lot of
 * bandwidth, invites abuse, and most sites' terms (YouTube's included) forbid
 * downloading outside their own download button. A public operator who has
 * weighed that sets VID2CONTEXT_DOWNLOADS=1. VID2CONTEXT_DOWNLOADS=0 turns
 * downloads off everywhere.
 */
import { type Env, isPublicMode } from '@vid2context/core';

export interface DownloadPolicy {
  enabled: boolean;
  /** Why downloads are off, with how to turn them on. */
  reason?: string;
  /** Largest file, in bytes. 0 means no limit. */
  maxBytes: number;
  /** Longest source video, in seconds. 0 means no limit. */
  maxDurationSec: number;
  /** Minutes a finished server-side file is kept. */
  ttlMin: number;
  /** Downloads that run at once on a server. */
  concurrency: number;
  /** Jobs a server keeps (queued, running and finished) before refusing new ones. */
  maxJobs: number;
  /** Longest a single download may run, in seconds. */
  timeoutSec: number;
}

function flag(v: string | undefined): boolean | undefined {
  const s = v?.trim().toLowerCase();
  if (!s) return undefined;
  if (['1', 'true', 'yes', 'on'].includes(s)) return true;
  if (['0', 'false', 'no', 'off'].includes(s)) return false;
  return undefined;
}

function num(v: string | undefined, fallback: number): number {
  if (v === undefined || v.trim() === '') return fallback;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

export const NOTICE =
  'Download only media you have the rights to: your own uploads, public-domain or Creative Commons works, or videos the site lets you download.';

export function downloadPolicy(env: Env): DownloadPolicy {
  const pub = isPublicMode(env);
  const setting = flag(env.VID2CONTEXT_DOWNLOADS);
  const enabled = setting ?? !pub;
  const policy: DownloadPolicy = {
    enabled,
    maxBytes: Math.floor(num(env.VID2CONTEXT_MAX_DOWNLOAD_MB, pub ? 1024 : 0) * 1024 * 1024),
    maxDurationSec: Math.floor(num(env.VID2CONTEXT_MAX_DOWNLOAD_MIN, pub ? 120 : 0) * 60),
    ttlMin: Math.max(1, num(env.VID2CONTEXT_DOWNLOAD_TTL_MIN, 30)),
    concurrency: Math.max(1, Math.floor(num(env.VID2CONTEXT_DOWNLOAD_CONCURRENCY, 2))),
    maxJobs: Math.max(1, Math.floor(num(env.VID2CONTEXT_MAX_DOWNLOAD_JOBS, 50))),
    timeoutSec: Math.max(30, Math.floor(num(env.VID2CONTEXT_DOWNLOAD_TIMEOUT_SEC, 7200))),
  };
  if (!enabled) {
    policy.reason =
      setting === false
        ? 'Downloads are turned off on this server (VID2CONTEXT_DOWNLOADS=0).'
        : 'Downloads are off on public servers by default. The operator can set VID2CONTEXT_DOWNLOADS=1, or run vid2context locally (npx vid2context download <url>).';
  }
  return policy;
}

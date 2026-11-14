/**
 * The checks every request passes before any work starts, in this order:
 * allowlist, video input, rate limit. Only requests that start a job count
 * against the limit, so help messages and refused links cost nothing.
 */
import type { Registry, VideoRef } from '@vid2context/core';
import { describeError, type UserError } from './reply.ts';
import { pickVideo } from './input.ts';
import { formatWait, type RateLimiter } from './ratelimit.ts';

export type Admission = { ok: true; ref: VideoRef; input: string } | { ok: false; error: UserError };

export interface GateRequest {
  registry: Registry;
  limiter: RateLimiter;
  perHour: number;
  allowed: boolean;
  /** What the allowlist is about, for the refusal text: "chat", "server", "workspace". */
  scope: string;
  candidates: string[];
  rateKeys: string[];
  now?: number;
}

export function admit(req: GateRequest): Admission {
  if (!req.allowed) {
    return {
      ok: false,
      error: {
        code: 'auth',
        message: `This bot is not enabled for this ${req.scope}.`,
        hint: 'Ask the person who runs this vid2context server to add it to the allowlist.',
      },
    };
  }
  let picked: { ref: VideoRef; input: string };
  try {
    picked = pickVideo(req.registry, req.candidates);
  } catch (err) {
    return { ok: false, error: describeError(err) };
  }
  const decision = req.limiter.take(req.rateKeys, req.perHour, req.now);
  if (!decision.ok) {
    return {
      ok: false,
      error: {
        code: 'rate-limited',
        message: `The limit of ${req.perHour} videos per hour is reached.`,
        hint: `Try again in ${formatWait(decision.retryAfterSec ?? 3600)}.`,
      },
    };
  }
  return { ok: true, ...picked };
}

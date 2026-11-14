/**
 * Per-process circuit breaker for YouTube. After a `blocked` result, every
 * further YouTube request fails fast with the same error for the cooldown
 * (YOUTUBE_BLOCK_COOLDOWN_SEC, default 600), instead of hammering an IP that
 * YouTube has already flagged, which tends to extend the block.
 *
 * The state is module-level on purpose: one process (or one Workers isolate)
 * shares one IP. Tests reset it with resetBreaker().
 */
import { type Ctx, Vid2ContextError } from '@vid2context/core';

const DEFAULT_COOLDOWN_SEC = 600;

interface Open {
  until: number;
  error: Vid2ContextError;
}

let open: Open | null = null;

export function cooldownSec(ctx: Ctx): number {
  const raw = ctx.env.YOUTUBE_BLOCK_COOLDOWN_SEC?.trim();
  const n = raw ? Number(raw) : Number.NaN;
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_COOLDOWN_SEC;
}

/** Open the breaker after a blocked result. */
export function tripBreaker(error: Vid2ContextError, ctx: Ctx): void {
  const sec = cooldownSec(ctx);
  if (sec === 0) return;
  open = { until: Date.now() + sec * 1000, error };
  ctx.log.warn('youtube: blocked, pausing YouTube requests', { cooldownSec: sec });
}

/** Seconds left while open, or 0 when closed. */
export function breakerRemainingSec(): number {
  if (!open) return 0;
  const ms = open.until - Date.now();
  if (ms <= 0) {
    open = null;
    return 0;
  }
  return Math.ceil(ms / 1000);
}

/** Throw the remembered blocked error (with a circuit-open attempt) while the breaker is open. */
export function assertBreakerClosed(stage: 'metadata' | 'captions'): void {
  const left = breakerRemainingSec();
  if (!open || left === 0) return;
  const { error } = open;
  throw Object.assign(
    new Vid2ContextError('blocked', `${error.message} (circuit open: YouTube requests paused for ${left}s more)`, {
      hint: error.hint,
      status: error.status,
      retryAfterSec: left,
    }),
    { attempts: [{ id: 'youtube', stage, outcome: 'skipped', reason: 'circuit-open', detail: `${left}s left` }] },
  );
}

export function resetBreaker(): void {
  open = null;
}

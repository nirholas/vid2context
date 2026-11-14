/**
 * Per-process circuit breaker for YouTube, one per route (direct, relay) and
 * per endpoint family (scope). After a `blocked` result, further requests of
 * that scope on that route fail fast for the cooldown
 * (YOUTUBE_BLOCK_COOLDOWN_SEC, default 600) instead of hammering an IP that
 * YouTube has already flagged, which tends to extend the block. With a relay
 * configured, an open direct breaker sends requests through the relay instead
 * (see relay.ts).
 *
 * Scopes, because YouTube blocks its endpoints independently. On 2026-11-14,
 * from a GCP VM, every caption download got HTTP 429 while the player and
 * `next` kept answering; at other times the player got the bot check while
 * `next` and oEmbed still worked. One shared breaker turned a caption block
 * into a failed metadata step.
 *   player     POST /youtubei/v1/player
 *   timedtext  caption downloads (/api/timedtext)
 *   web        the other innertube endpoints: next, browse, search, resolve_url
 *
 * The state is module-level on purpose: one process (or one Workers isolate)
 * shares one IP. Tests reset it with resetBreaker().
 */
import { type Ctx, Vid2ContextError } from '@vid2context/core';
import type { Route } from './relay.ts';

const DEFAULT_COOLDOWN_SEC = 600;

export type Scope = 'player' | 'timedtext' | 'web';
const SCOPES: readonly Scope[] = ['player', 'timedtext', 'web'];

/** How each scope is named in messages. */
const WHAT: Record<Scope, string> = {
  player: 'YouTube player requests',
  timedtext: 'YouTube caption downloads',
  web: 'YouTube watch-page requests (next, browse, search)',
};

interface Open {
  until: number;
  at: number;
  error: Vid2ContextError;
}

const open: Record<Route, Record<Scope, Open | null>> = {
  direct: { player: null, timedtext: null, web: null },
  relay: { player: null, timedtext: null, web: null },
};

export function cooldownSec(ctx: Ctx): number {
  const raw = ctx.env.YOUTUBE_BLOCK_COOLDOWN_SEC?.trim();
  const n = raw ? Number(raw) : Number.NaN;
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_COOLDOWN_SEC;
}

/** Open the breaker for one scope of a route after a blocked result. */
export function tripBreaker(error: Vid2ContextError, ctx: Ctx, route: Route = 'direct', scope: Scope = 'player'): void {
  const sec = cooldownSec(ctx);
  if (sec === 0) return;
  const now = Date.now();
  open[route][scope] = { until: now + sec * 1000, at: now, error };
  ctx.log.warn('youtube: blocked, pausing YouTube requests', { route, scope, cooldownSec: sec });
}

function remaining(route: Route, scope: Scope): number {
  const o = open[route][scope];
  if (!o) return 0;
  const ms = o.until - Date.now();
  if (ms <= 0) {
    open[route][scope] = null;
    return 0;
  }
  return Math.ceil(ms / 1000);
}

/** Seconds left while the breaker is open, or 0 when closed. Without a scope: the longest of the route's scopes. */
export function breakerRemainingSec(route: Route = 'direct', scope?: Scope): number {
  if (scope) return remaining(route, scope);
  return Math.max(...SCOPES.map((s) => remaining(route, s)));
}

function ago(ms: number): string {
  const sec = Math.max(0, Math.round(ms / 1000));
  return sec < 90 ? `${sec}s ago` : `${Math.round(sec / 60)} min ago`;
}

/**
 * Throw while the breaker for this scope (or, without a scope, any scope) of
 * the route is open. The message says that this request was not sent and
 * why, and quotes the earlier blocked request separately, so it never reads
 * as if this video failed with another video's error.
 */
export function assertBreakerClosed(stage: 'metadata' | 'captions', route: Route = 'direct', scope?: Scope): void {
  const scopes = scope ? [scope] : SCOPES;
  const hit = scopes.map((s) => ({ s, left: remaining(route, s) })).find((x) => x.left > 0);
  if (!hit) return;
  const o = open[route][hit.s] as Open;
  const { left } = hit;
  const who = route === 'relay' ? "the relay's IP address" : 'this IP address';
  throw Object.assign(
    new Vid2ContextError(
      'blocked',
      `${WHAT[hit.s]} are paused for ${left}s more: YouTube blocked ${who} ${ago(Date.now() - o.at)}, so this request was not sent. The blocked request: ${o.error.message}`,
      { hint: o.error.hint, status: o.error.status, retryAfterSec: left },
    ),
    {
      attempts: [
        {
          id: route === 'relay' ? 'youtube@relay' : 'youtube',
          stage,
          outcome: 'skipped',
          reason: 'circuit-open',
          detail: `${hit.s}, ${left}s left`,
        },
      ],
    },
  );
}

export function resetBreaker(): void {
  for (const route of Object.keys(open) as Route[]) for (const s of SCOPES) open[route][s] = null;
}

/**
 * Stall protection for running jobs. A handler that hangs (an upstream that
 * accepts the connection and never answers, a child process that stops
 * writing) would otherwise hold one of the runner's few slots forever, and
 * every job queued behind it would wait with it.
 *
 * Two limits, both checked per attempt:
 *   stall    no `progress` or `item` event for VID2CONTEXT_JOB_STALL_SEC
 *            (default 1800). Handlers report progress as they go, so silence
 *            this long means the work is stuck, not slow.
 *   timeout  the attempt has run for VID2CONTEXT_JOB_TIMEOUT_SEC in total
 *            (default 0, no limit: a long download that keeps reporting
 *            progress is legitimate).
 *
 * Either one aborts the attempt's signal, so fetches and child processes
 * that honour it stop, and fails the attempt with a retryable `timeout`.
 * A kind can override both through its KindOptions; 0 turns a check off.
 */
import { type Env, Vid2ContextError } from '@vid2context/core';
import type { KindEntry } from './kinds.ts';

export const DEFAULT_STALL_SEC = 1800;
export const DEFAULT_TIMEOUT_SEC = 0;

function envSeconds(env: Env, name: string, fallback: number): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) {
    throw new Vid2ContextError('bad-request', `${name}="${raw}" is not a number of seconds.`, {
      hint: `Set ${name} to a number like ${fallback || 3600} (0 turns the check off), or unset it for the default.`,
    });
  }
  return n;
}

export interface WatchdogLimits {
  /** Seconds without a progress or item event; 0 is off. */
  stallSec: number;
  /** Seconds per attempt; 0 is off. */
  timeoutSec: number;
}

/** The limits for one kind: its own options first, then the env, then the defaults. */
export function watchdogLimits(env: Env, kind?: Pick<KindEntry, 'stallSec' | 'timeoutSec'>): WatchdogLimits {
  return {
    stallSec: kind?.stallSec ?? envSeconds(env, 'VID2CONTEXT_JOB_STALL_SEC', DEFAULT_STALL_SEC),
    timeoutSec: kind?.timeoutSec ?? envSeconds(env, 'VID2CONTEXT_JOB_TIMEOUT_SEC', DEFAULT_TIMEOUT_SEC),
  };
}

/** Abort reason when the watchdog stops an attempt. Carries the error the attempt fails with. */
export class JobStalled extends Error {
  constructor(readonly error: Vid2ContextError) {
    super(error.message);
    this.name = 'JobStalled';
  }
}

function stalledError(kind: string, limits: WatchdogLimits, why: 'stall' | 'timeout', lastMessage?: string): Vid2ContextError {
  if (why === 'stall') {
    const last = lastMessage ? ` The last progress was "${lastMessage}".` : '';
    return new Vid2ContextError(
      'timeout',
      `The ${kind} job made no progress for ${formatSec(limits.stallSec)}, so it was stopped.${last}`,
      {
        hint: 'It will be retried if attempts remain. An upstream service that stopped answering is the usual cause. If this kind of job legitimately runs that long without reporting progress, raise VID2CONTEXT_JOB_STALL_SEC (0 turns the check off).',
      },
    );
  }
  return new Vid2ContextError('timeout', `The ${kind} job ran longer than ${formatSec(limits.timeoutSec)}, so it was stopped.`, {
    hint: 'It will be retried if attempts remain. Split the work into smaller jobs, or raise VID2CONTEXT_JOB_TIMEOUT_SEC (0 means no limit).',
  });
}

function formatSec(sec: number): string {
  if (sec < 120) return `${sec} s`;
  if (sec < 7200) return `${Math.round(sec / 60)} min`;
  return `${Math.round((sec / 3600) * 10) / 10} h`;
}

export interface Watchdog {
  /** Aborted with a JobStalled reason when a limit is hit. */
  signal: AbortSignal;
  /** Record activity (a progress or item event). */
  touch(message?: string): void;
  /** Stop the timers. Safe to call more than once. */
  stop(): void;
}

/** Start watching one attempt. With both limits off, the signal never aborts and no timer is set. */
export function startWatchdog(kind: string, limits: WatchdogLimits, now: () => number = Date.now): Watchdog {
  const controller = new AbortController();
  let last = now();
  let lastMessage: string | undefined;
  let stallTimer: ReturnType<typeof setTimeout> | undefined;
  let totalTimer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;

  const fire = (why: 'stall' | 'timeout') => {
    if (stopped || controller.signal.aborted) return;
    stop();
    controller.abort(new JobStalled(stalledError(kind, limits, why, lastMessage)));
  };

  // One timer for the stall check, re-armed for the time left instead of on every event, so a chatty handler costs nothing.
  const armStall = (ms: number) => {
    stallTimer = setTimeout(() => {
      if (stopped) return;
      const left = limits.stallSec * 1000 - (now() - last);
      if (left <= 0) fire('stall');
      else armStall(left);
    }, ms);
    unref(stallTimer);
  };

  function stop() {
    stopped = true;
    if (stallTimer) clearTimeout(stallTimer);
    if (totalTimer) clearTimeout(totalTimer);
  }

  if (limits.stallSec > 0) armStall(limits.stallSec * 1000);
  if (limits.timeoutSec > 0) {
    totalTimer = setTimeout(() => fire('timeout'), limits.timeoutSec * 1000);
    unref(totalTimer);
  }

  return {
    signal: controller.signal,
    touch(message?: string) {
      last = now();
      if (message) lastMessage = message.slice(0, 200);
    },
    stop,
  };
}

/** Node timers keep the process alive; a watchdog must not. Workers timers have no unref. */
function unref(timer: unknown): void {
  (timer as { unref?: () => void } | undefined)?.unref?.();
}

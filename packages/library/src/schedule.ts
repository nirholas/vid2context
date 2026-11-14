/**
 * Watch list schedules: how often a collection refreshes itself, and when it
 * is next due. Times are UTC. Pure functions, no clock reads: callers pass
 * `from` so tests and the scheduler agree on what "now" is.
 */
import { Vid2ContextError } from '@vid2context/core';

export type Every = 'hourly' | 'daily' | 'weekly' | { minutes: number };

export interface Schedule {
  every: Every;
  /** UTC time of day, `HH:MM`. Hourly schedules use only the minutes. */
  at?: string;
  enabled: boolean;
}

/** Below this, refreshes would poll platforms harder than any upload rhythm needs. */
export const MIN_MINUTES = 5;
/** Four weeks. */
export const MAX_MINUTES = 40_320;

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const AT = /^([01]\d|2[0-3]):([0-5]\d)$/;

function bad(message: string, hint: string): Vid2ContextError {
  return new Vid2ContextError('bad-request', message, { hint });
}

const SCHEDULE_HINT = 'Send {"every": "hourly" | "daily" | "weekly" | {"minutes": n}, "at"?: "HH:MM" (UTC), "enabled"?: true}.';

/** Validate an untrusted schedule (HTTP body, MCP input, imported JSON). `enabled` defaults to true. */
export function parseSchedule(input: unknown): Schedule {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw bad('The schedule must be a JSON object.', SCHEDULE_HINT);
  }
  const o = input as Record<string, unknown>;
  let every: Every;
  if (o.every === 'hourly' || o.every === 'daily' || o.every === 'weekly') {
    every = o.every;
  } else if (o.every && typeof o.every === 'object' && !Array.isArray(o.every)) {
    const minutes = (o.every as Record<string, unknown>).minutes;
    if (typeof minutes !== 'number' || !Number.isInteger(minutes) || minutes < MIN_MINUTES || minutes > MAX_MINUTES) {
      throw bad(
        `every.minutes must be a whole number from ${MIN_MINUTES} to ${MAX_MINUTES}.`,
        `Use at least ${MIN_MINUTES} minutes; new uploads rarely need faster polling.`,
      );
    }
    every = { minutes };
  } else {
    throw bad('every must be "hourly", "daily", "weekly" or {"minutes": n}.', SCHEDULE_HINT);
  }
  let at: string | undefined;
  if (o.at !== undefined && o.at !== null) {
    if (typeof o.at !== 'string' || !AT.test(o.at)) throw bad('at must be a UTC time of day as HH:MM.', 'For example "06:30".');
    if (typeof every === 'object')
      throw bad('at only applies to hourly, daily and weekly schedules.', 'Drop "at", or use "daily".');
    at = o.at;
  }
  if (o.enabled !== undefined && typeof o.enabled !== 'boolean') throw bad('enabled must be true or false.', SCHEDULE_HINT);
  return { every, ...(at ? { at } : {}), enabled: o.enabled ?? true };
}

function periodMs(every: Every): number {
  if (typeof every === 'object') return every.minutes * 60_000;
  return every === 'hourly' ? HOUR : every === 'daily' ? DAY : 7 * DAY;
}

/** The first instant strictly after `after` whose UTC clock reads `at` (hourly: whose minute matches). */
function nextSlot(after: number, at: string, hourly: boolean): number {
  const [hh, mm] = at.split(':').map(Number) as [number, number];
  const d = new Date(after);
  if (hourly) {
    let t = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), d.getUTCHours(), mm);
    if (t <= after) t += HOUR;
    return t;
  }
  let t = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), hh, mm);
  if (t <= after) t += DAY;
  return t;
}

/**
 * When a collection checked at `from` is next due.
 * Without `at`: `from` plus the period. With `at`: the next matching slot
 * more than an hour away (daily) or more than six days away (weekly), so a
 * run that started late never triggers a second run straight after.
 */
export function nextDueAt(schedule: Schedule, from: Date): Date {
  const t = from.getTime();
  const { every, at } = schedule;
  if (!at || typeof every === 'object') return new Date(t + periodMs(every));
  if (every === 'hourly') return new Date(nextSlot(t, at, true));
  if (every === 'daily') return new Date(nextSlot(t + HOUR, at, false));
  return new Date(nextSlot(t + 6 * DAY, at, false));
}

/**
 * When a newly set schedule first runs: now when there is no `at` (so a new
 * watch list ingests straight away), otherwise the next matching slot.
 */
export function firstDueAt(schedule: Schedule, now: Date): Date {
  const { every, at } = schedule;
  if (!at || typeof every === 'object') return now;
  return new Date(nextSlot(now.getTime(), at, every === 'hourly'));
}

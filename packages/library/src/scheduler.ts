/**
 * Ways to call Library.runDue on a schedule.
 *
 * startScheduler: a timer loop for long-running Node processes (the HTTP
 * server, a daemon). The timer is unref'd, so it never keeps a process alive
 * on its own, and stop() waits for a run in progress to finish.
 *
 * scheduledHandler: a function for a Cloudflare Workers `scheduled()` export.
 * The cron trigger decides the cadence; each tick refreshes whatever is due.
 *
 * Both use only timers, so this file stays runtime-neutral.
 */
import type { DueResult, Library } from './library.ts';

export interface SchedulerOptions {
  /** Time between checks. Default 60 s. Collections still refresh on their own schedules. */
  intervalMs?: number;
  /** Called after each check with what ran. */
  onRun?: (results: DueResult[]) => void;
}

export interface SchedulerHandle {
  /** Stop the loop and wait for a run in progress to finish. */
  stop(): Promise<void>;
}

export function startScheduler(library: Library, opts: SchedulerOptions = {}): SchedulerHandle {
  const intervalMs = Math.max(1000, opts.intervalMs ?? 60_000);
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let current: Promise<void> = Promise.resolve();

  const arm = (ms: number) => {
    if (stopped) return;
    timer = setTimeout(tick, ms);
    (timer as { unref?: () => void }).unref?.();
  };

  function tick(): void {
    current = (async () => {
      try {
        const results = await library.runDue();
        await library.flush();
        opts.onRun?.(results);
      } catch (err) {
        library.ctx.log.error('library scheduler: run failed', { error: err instanceof Error ? err.message : String(err) });
      }
    })();
    current.then(() => arm(intervalMs));
  }

  arm(0);
  return {
    async stop() {
      stopped = true;
      if (timer !== undefined) clearTimeout(timer);
      await current;
    },
  };
}

/** The parts of a Workers ScheduledController and ExecutionContext this handler uses. */
export interface ScheduledEventLike {
  scheduledTime: number;
}
export interface ExecutionContextLike {
  waitUntil(promise: Promise<unknown>): void;
}

export interface ScheduledDeps<E> {
  /** Build the library for this invocation from the Worker's env (registry, storage, ctx). */
  library: (env: E) => Library | Promise<Library>;
}

/**
 * `export default { scheduled: scheduledHandler({ library: (env) => ... }) }`.
 * Runs every due watch list at the cron's scheduled time and keeps the
 * Worker alive (waitUntil) until webhooks are delivered.
 */
export function scheduledHandler<E = unknown>(
  deps: ScheduledDeps<E>,
): (event: ScheduledEventLike, env: E, exec?: ExecutionContextLike) => Promise<DueResult[]> {
  return async (event, env, exec) => {
    const library = await deps.library(env);
    const run = (async () => {
      const results = await library.runDue(new Date(event.scheduledTime));
      await library.flush();
      return results;
    })();
    exec?.waitUntil(run);
    return run;
  };
}

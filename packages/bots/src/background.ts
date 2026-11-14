/**
 * Work that continues after the webhook has been answered. Platforms want an
 * answer within seconds (Slack 3 s, Discord 3 s), while a summary can take a
 * minute, so the route acks first and finishes here.
 *
 * Where the promise goes, in order: the `waitUntil` the caller passed, the
 * Workers `executionCtx.waitUntil` of the request, or a tracked set on Node
 * (`idle()` resolves once every task has settled, for tests and shutdown).
 * A task never rejects: failures are logged and reported to the user by the
 * task's own `onError`.
 */
import type { Ctx } from '@vid2context/core';

export type WaitUntil = (p: Promise<unknown>) => void;

export class Background {
  private pending = new Set<Promise<unknown>>();

  constructor(private readonly waitUntil?: WaitUntil) {}

  run(
    ctx: Ctx,
    label: string,
    task: () => Promise<void>,
    onError: (err: unknown) => Promise<void>,
    requestWaitUntil?: WaitUntil,
  ): void {
    const p = (async () => {
      try {
        await task();
      } catch (err) {
        ctx.log.error(`bots: ${label} failed`, { error: err instanceof Error ? err.message.slice(0, 300) : String(err) });
        try {
          await onError(err);
        } catch (notifyErr) {
          ctx.log.error(`bots: ${label}: could not tell the user about the failure`, {
            error: notifyErr instanceof Error ? notifyErr.message.slice(0, 300) : String(notifyErr),
          });
        }
      }
    })();
    this.pending.add(p);
    p.finally(() => this.pending.delete(p));
    const hand = this.waitUntil ?? requestWaitUntil;
    hand?.(p);
  }

  /** Resolves when every task started so far has settled. */
  async idle(): Promise<void> {
    while (this.pending.size > 0) await Promise.allSettled([...this.pending]);
  }
}

/** A Ctx for background work: the request's env, fetch and logger, with its own deadline instead of the request's abort signal (which may fire once the response is sent). */
export function backgroundCtx(ctx: Ctx, timeoutMs: number): Ctx {
  return { ...ctx, signal: AbortSignal.timeout(timeoutMs) };
}

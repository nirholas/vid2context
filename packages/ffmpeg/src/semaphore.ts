/**
 * A counting semaphore for child processes. Slots pass straight from the
 * releasing call to the next waiter, so a slot is never lost. A waiter whose
 * signal aborts leaves the queue at once and rejects, so it never takes a slot
 * (or spawns a process) after its caller gave up.
 */

interface Waiter {
  limit: number;
  grant: () => void;
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException('The operation was aborted.', 'AbortError');
}

export class Semaphore {
  private active = 0;
  private readonly waiting: Waiter[] = [];

  /** Slots in use. */
  get inUse(): number {
    return this.active;
  }

  /** Callers waiting for a slot. */
  get queued(): number {
    return this.waiting.length;
  }

  /**
   * Wait until fewer than `limit` slots are in use, then take one. Returns a
   * release function; calling it more than once does nothing.
   */
  acquire(limit: number, signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) return Promise.reject(abortReason(signal));
    if (this.active < limit && this.waiting.length === 0) {
      this.active++;
      return Promise.resolve(this.releaser());
    }
    return new Promise((resolve, reject) => {
      const waiter: Waiter = {
        limit,
        grant: () => {
          signal?.removeEventListener('abort', onAbort);
          resolve(this.releaser());
        },
      };
      const onAbort = () => {
        const i = this.waiting.indexOf(waiter);
        if (i >= 0) this.waiting.splice(i, 1);
        reject(abortReason(signal as AbortSignal));
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      this.waiting.push(waiter);
    });
  }

  /** Run `fn` while holding a slot. Rejects without calling `fn` if `signal` aborts first. */
  async run<T>(limit: number, signal: AbortSignal | undefined, fn: () => Promise<T>): Promise<T> {
    const release = await this.acquire(limit, signal);
    try {
      // The abort may land between the grant and this line; the listener is gone by then.
      if (signal?.aborted) throw abortReason(signal);
      return await fn();
    } finally {
      release();
    }
  }

  private releaser(): () => void {
    let done = false;
    return () => {
      if (done) return;
      done = true;
      this.active = Math.max(0, this.active - 1);
      this.drain();
    };
  }

  private drain(): void {
    for (;;) {
      const next = this.waiting[0];
      if (!next || this.active >= next.limit) return;
      this.waiting.shift();
      this.active++;
      next.grant();
    }
  }
}

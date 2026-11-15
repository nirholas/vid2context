/**
 * A cap on expensive requests (anything that may run the pipeline, call a
 * model or hold an upload in memory). At most VID2CONTEXT_MAX_CONCURRENT run
 * at once per process; up to VID2CONTEXT_MAX_WAITING more wait for a slot for
 * at most VID2CONTEXT_QUEUE_WAIT_MS. Anything past that is answered at once
 * with 503 `busy` and Retry-After, instead of piling up work until the
 * process runs out of memory or sockets. A caller that disconnects while
 * waiting leaves the queue. Cheap routes (health, OpenAPI, job status,
 * library reads) are never limited.
 */
import type { Env } from '@vid2context/core';
import type { MiddlewareHandler } from 'hono';
import { HttpError } from './errors.ts';
import type { AppEnv } from './types.ts';

export interface ConcurrencyConfig {
  /** Expensive requests running at once. 0 turns the cap off. */
  maxConcurrent: number;
  /** Requests allowed to wait for a slot. */
  maxWaiting: number;
  /** Longest a request waits for a slot before it is answered busy. */
  queueWaitMs: number;
}

function int(raw: string | undefined, fallback: number): number {
  const v = raw?.trim();
  const n = Number(v);
  return v && Number.isInteger(n) && n >= 0 ? n : fallback;
}

export function concurrencyConfig(env: Env): ConcurrencyConfig {
  return {
    maxConcurrent: int(env.VID2CONTEXT_MAX_CONCURRENT, 16),
    maxWaiting: int(env.VID2CONTEXT_MAX_WAITING, 64),
    queueWaitMs: int(env.VID2CONTEXT_QUEUE_WAIT_MS, 30_000),
  };
}

/** Routes under /api/v1 that can run the pipeline, a model or a large upload. */
const HEAVY = new Set([
  'context',
  'transcript',
  'metadata',
  'formats',
  'items',
  'section',
  'outline',
  'comments',
  'pack',
  'bundle',
  'uploads',
  'ask',
  'chat',
  'research',
  'key-moments',
  'caption-languages',
  'briefs',
  'extract',
  'chapters',
  'skips',
  'exports',
  'imports',
  'duplicates',
]);

/** True for requests the cap applies to. */
export function isHeavy(method: string, path: string): boolean {
  if (method === 'OPTIONS' || method === 'HEAD') return false;
  const p = path.replace(/\/+$/, '');
  if (p === '/mcp') return method === 'POST';
  const m = /^\/api\/v1\/([^/]+)/.exec(p);
  return !!m?.[1] && HEAVY.has(m[1]);
}

function busy(cfg: ConcurrencyConfig, why: string): HttpError {
  return new HttpError('busy', 503, `The server is busy: ${why}.`, {
    hint: `Retry after a few seconds (see Retry-After). Operators can raise VID2CONTEXT_MAX_CONCURRENT (now ${cfg.maxConcurrent}) or VID2CONTEXT_MAX_WAITING (now ${cfg.maxWaiting}), or send long work as a job.`,
    headers: { 'retry-after': '5' },
  });
}

interface Waiter {
  grant: () => void;
}

/** A counting semaphore whose slots pass straight to the next live waiter, so none is ever lost. */
export class RequestLimiter {
  private active = 0;
  private readonly waiting: Waiter[] = [];

  get running(): number {
    return this.active;
  }

  get queued(): number {
    return this.waiting.length;
  }

  async acquire(cfg: ConcurrencyConfig, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) throw signal.reason;
    if (this.active < cfg.maxConcurrent && this.waiting.length === 0) {
      this.active++;
      return;
    }
    if (this.waiting.length >= cfg.maxWaiting) {
      throw busy(cfg, `${this.active} expensive requests are running and ${this.waiting.length} are waiting`);
    }
    await new Promise<void>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const leave = () => {
        const i = this.waiting.indexOf(waiter);
        if (i >= 0) this.waiting.splice(i, 1);
        if (timer) clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
      };
      const waiter: Waiter = {
        grant: () => {
          leave();
          resolve();
        },
      };
      const onAbort = () => {
        leave();
        reject(signal?.reason ?? new DOMException('Aborted', 'AbortError'));
      };
      timer = setTimeout(() => {
        leave();
        reject(busy(cfg, `no slot came free within ${Math.round(cfg.queueWaitMs / 1000)} s`));
      }, cfg.queueWaitMs);
      signal?.addEventListener('abort', onAbort, { once: true });
      this.waiting.push(waiter);
    });
  }

  release(): void {
    const next = this.waiting.shift();
    if (next) next.grant();
    else this.active = Math.max(0, this.active - 1);
  }
}

/** The middleware. `env` reads the server's own env for a request. */
export function concurrencyLimit(env: (req: Request) => Env, limiter = new RequestLimiter()): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    if (!isHeavy(c.req.method, c.req.path)) return next();
    const cfg = concurrencyConfig(env(c.req.raw));
    if (cfg.maxConcurrent <= 0) return next();
    await limiter.acquire(cfg, c.req.raw.signal);
    try {
      await next();
    } finally {
      limiter.release();
    }
  };
}

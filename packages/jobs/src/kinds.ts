/**
 * Job kinds by name. Every runner of the same deployment registers the same
 * kinds, so the producer can reject unknown kinds before anything is queued.
 */
import { Vid2ContextError } from '@vid2context/core';
import type { JobHandler, KindOptions } from './types.ts';

export interface KindEntry {
  handler: JobHandler;
  maxAttempts: number;
  backoff: { baseMs: number; maxMs: number; blockedMs: number };
}

export const DEFAULT_MAX_ATTEMPTS = 3;
export const DEFAULT_BACKOFF = { baseMs: 2_000, maxMs: 5 * 60_000, blockedMs: 15 * 60_000 };

const KIND_RE = /^[a-z][a-z0-9-]{0,63}$/;

export class JobKinds {
  private entries = new Map<string, KindEntry>();

  register<I, O>(kind: string, handler: JobHandler<I, O>, opts: KindOptions = {}): void {
    if (!KIND_RE.test(kind)) {
      throw new Vid2ContextError('bad-request', `Invalid job kind "${kind}".`, {
        hint: 'Kinds are lowercase letters, digits and dashes, starting with a letter (for example "ingest").',
      });
    }
    const maxAttempts = Math.max(1, Math.floor(opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS));
    this.entries.set(kind, { handler: handler as JobHandler, maxAttempts, backoff: { ...DEFAULT_BACKOFF, ...opts.backoff } });
  }

  /** Same as `register`, so a bare kind table can be passed wherever a queue's `registerKind` is expected. */
  registerKind<I, O>(kind: string, handler: JobHandler<I, O>, opts: KindOptions = {}): void {
    this.register(kind, handler, opts);
  }

  get(kind: string): KindEntry | undefined {
    return this.entries.get(kind);
  }

  names(): string[] {
    return [...this.entries.keys()].sort();
  }

  /** The entry for `kind`, or a `bad-request` error that lists the registered kinds. */
  require(kind: unknown): KindEntry {
    const entry = typeof kind === 'string' ? this.entries.get(kind) : undefined;
    if (entry) return entry;
    const names = this.names();
    throw new Vid2ContextError('bad-request', `Unknown job kind "${String(kind)}".`, {
      hint: names.length ? `Registered kinds: ${names.join(', ')}.` : 'No job kinds are registered on this server.',
    });
  }
}

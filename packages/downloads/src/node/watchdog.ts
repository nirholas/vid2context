/**
 * Stall protection for one child process (yt-dlp or ffmpeg).
 *
 * A Watchdog owns an AbortSignal that follows the caller's signal and also
 * fires when:
 *   - no progress was reported for `stallMs` (a hung connection, a stuck
 *     muxer): reason "stall", which the engine retries
 *   - the shared deadline for the whole download passed: reason "deadline"
 *   - the bytes written passed `maxBytes`, by the reported progress or by
 *     polling the work folder: reason "too-large"
 *
 * The child runners kill their process (yt-dlp: the whole process group) when
 * the signal aborts, so passing `watchdog.signal` as the ctx signal is enough.
 */
import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { Vid2ContextError } from '@vid2context/core';

export type TripReason = 'stall' | 'deadline' | 'too-large' | 'canceled';

export interface WatchdogOptions {
  /** What runs, for messages: "yt-dlp download", "ffmpeg GIF export". */
  label: string;
  /** No-progress limit in ms. 0 turns stall detection off. */
  stallMs: number;
  /** Epoch ms after which the run is stopped. */
  deadlineAt?: number;
  /** Largest number of bytes the run may write. 0 or undefined: no cap. */
  maxBytes?: number;
  /** Folder whose total size is polled against `maxBytesOnDisk`. */
  dir?: string;
  /** Cap for the polled folder size (temporary copies during a merge count). Default 2 x maxBytes. */
  maxBytesOnDisk?: number;
  parent?: AbortSignal;
  /** Poll interval in ms. Default 1000. */
  pollMs?: number;
  /**
   * Called with the polled folder size. A growing folder counts as progress, so a long
   * step that prints nothing (yt-dlp's ffmpeg post-processing) is never taken for a stall.
   */
  onPoll?: (bytes: number) => void;
}

/** Total size of the files under a folder. Missing files (moved mid-walk) count as 0. */
export async function folderBytes(dir: string): Promise<number> {
  let total = 0;
  let entries: import('node:fs').Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) total += await folderBytes(p);
    else if (e.isFile()) {
      try {
        total += (await stat(p)).size;
      } catch {
        // Renamed between readdir and stat.
      }
    }
  }
  return total;
}

export class Watchdog {
  readonly signal: AbortSignal;
  private readonly controller = new AbortController();
  private lastProgress = Date.now();
  private timer?: ReturnType<typeof setInterval>;
  private polling = false;
  private lastBytes = -1;
  private onParentAbort?: () => void;
  tripped?: TripReason;

  constructor(private readonly opts: WatchdogOptions) {
    this.signal = this.controller.signal;
    const parent = opts.parent;
    if (parent?.aborted) this.trip('canceled', parent.reason);
    else if (parent) {
      this.onParentAbort = () => this.trip('canceled', parent.reason);
      parent.addEventListener('abort', this.onParentAbort, { once: true });
    }
    this.timer = setInterval(() => void this.check(), opts.pollMs ?? 1000);
    this.timer.unref?.();
  }

  /** Something happened: a progress line, a postprocessor step. */
  touch(): void {
    this.lastProgress = Date.now();
  }

  /** Bytes written so far by the child, from its own progress output. */
  reportBytes(bytes: number): void {
    this.touch();
    const max = this.opts.maxBytes ?? 0;
    if (max > 0 && bytes > max) this.trip('too-large');
  }

  /** Milliseconds left before the deadline, at least 1. */
  remainingMs(fallback: number): number {
    if (this.opts.deadlineAt === undefined) return fallback;
    return Math.max(1, Math.min(fallback, this.opts.deadlineAt - Date.now()));
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    if (this.onParentAbort) this.opts.parent?.removeEventListener('abort', this.onParentAbort);
  }

  /** The error that explains why the run was stopped, or undefined when it was not stopped by this watchdog. */
  error(): Vid2ContextError | undefined {
    const o = this.opts;
    switch (this.tripped) {
      case 'stall':
        return new Vid2ContextError(
          'timeout',
          `${o.label} made no progress for ${Math.round(o.stallMs / 1000)} s and was stopped.`,
          {
            hint: 'The connection or the encoder hung. It is retried automatically; raise VID2CONTEXT_DOWNLOAD_STALL_SEC for very slow sources.',
          },
        );
      case 'deadline':
        return new Vid2ContextError('timeout', `${o.label} ran past the time limit for one download and was stopped.`, {
          hint: 'Pick a lower quality or a shorter part, or raise VID2CONTEXT_DOWNLOAD_TIMEOUT_SEC.',
        });
      case 'too-large':
        return new Vid2ContextError(
          'too-large',
          `${o.label} wrote more than ${Math.round((o.maxBytes ?? 0) / 1048576)} MB and was stopped.`,
          { hint: 'Pick a lower quality or a shorter part, or raise VID2CONTEXT_MAX_DOWNLOAD_MB.' },
        );
      default:
        return undefined;
    }
  }

  private trip(reason: TripReason, cause?: unknown): void {
    if (this.tripped) return;
    this.tripped = reason;
    this.stop();
    this.controller.abort(reason === 'canceled' ? (cause ?? new DOMException('Aborted', 'AbortError')) : this.error());
  }

  private async check(): Promise<void> {
    if (this.tripped || this.polling) return;
    const o = this.opts;
    if (o.deadlineAt !== undefined && Date.now() >= o.deadlineAt) return this.trip('deadline');
    const cap = o.maxBytesOnDisk ?? (o.maxBytes ? o.maxBytes * 2 : 0);
    if (o.dir) {
      this.polling = true;
      try {
        const bytes = await folderBytes(o.dir);
        if (bytes !== this.lastBytes) {
          this.lastBytes = bytes;
          this.touch();
        }
        o.onPoll?.(bytes);
        if (cap > 0 && bytes > cap) return this.trip('too-large');
      } finally {
        this.polling = false;
      }
    }
    if (this.tripped) return;
    if (o.stallMs > 0 && Date.now() - this.lastProgress >= o.stallMs) this.trip('stall');
  }
}

/** Resolve once the process is gone (signal 0 fails), or after `graceMs`. */
export async function waitForExit(pid: number | undefined, graceMs = 5000): Promise<void> {
  if (pid === undefined) return;
  const until = Date.now() + graceMs;
  while (Date.now() < until) {
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
    await new Promise((r) => setTimeout(r, 50));
  }
}

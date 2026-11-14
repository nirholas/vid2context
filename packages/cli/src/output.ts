/**
 * Output helpers. stdout carries only program output (or the --out file gets
 * it); progress, notes, errors, hints and attempts go to stderr.
 */
import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { type Attempt, attemptsOf, Vid2ContextError } from '@vid2context/core';
import { exitCodeFor, UsageError } from './exit-codes.ts';

export interface Io {
  stdout: (s: string) => void;
  stderr: (s: string) => void;
  /** True when stderr is a terminal. Spinners only run then. */
  stderrIsTTY?: boolean;
}

export function formatAttempts(attempts: Attempt[]): string {
  if (attempts.length === 0) return '';
  const rows = attempts.map((a) => {
    const what = [a.reason, a.detail].filter(Boolean).join(': ');
    return `  ${a.stage.padEnd(8)} ${a.outcome.padEnd(7)} ${a.id}${what ? `  ${what}` : ''}`;
  });
  return `Attempts:\n${rows.join('\n')}\n`;
}

/** Message and hint always; the attempts list with `withAttempts`. */
export function formatError(err: unknown, withAttempts = false): string {
  const attempts = withAttempts ? formatAttempts(attemptsOf(err)) : '';
  if (err instanceof Vid2ContextError) {
    return `error (${err.code}): ${err.message}\n${err.hint ? `hint: ${err.hint}\n` : ''}${attempts}`;
  }
  if (err instanceof UsageError) return `error: ${err.message}\n${err.hint ? `hint: ${err.hint}\n` : ''}`;
  return `error: ${err instanceof Error ? err.message : String(err)}\n${attempts}`;
}

export function errorJson(err: unknown): string {
  const code = err instanceof Vid2ContextError ? err.code : err instanceof UsageError ? 'usage' : 'error';
  const hint = err instanceof Vid2ContextError || err instanceof UsageError ? err.hint : undefined;
  return `${JSON.stringify({
    error: {
      code,
      message: err instanceof Error ? err.message : String(err),
      hint,
      exitCode: exitCodeFor(err),
      attempts: attemptsOf(err),
    },
  })}\n`;
}

/**
 * Program output. Without --out it streams to stdout; with --out it is
 * collected and written to the file at the end, refusing to overwrite an
 * existing file unless --force.
 */
export class Output {
  private chunks: Uint8Array[] = [];
  private readonly path?: string;
  private written = 0;

  constructor(
    private readonly io: Io,
    out: string | undefined,
    private readonly force: boolean,
    cwd: string,
  ) {
    this.path = out ? resolve(cwd, out) : undefined;
  }

  get toFile(): boolean {
    return this.path !== undefined;
  }

  /** Fail before doing any work when the --out file exists and --force is not set. */
  precheck(): void {
    if (this.path && !this.force && existsSync(this.path)) {
      throw new UsageError(`${this.path} already exists.`, 'Pass --force to overwrite it, or choose another --out path.');
    }
  }

  text(s: string): void {
    if (this.path) this.chunks.push(new TextEncoder().encode(s));
    else this.io.stdout(s);
  }

  bytes(b: Uint8Array): void {
    if (!this.path) throw new UsageError('This command writes binary output.', 'Pass --out <file>.');
    this.chunks.push(b);
  }

  /** Write the collected output to the --out file. Returns the path and byte count, or undefined without --out. */
  async flush(): Promise<{ path: string; bytes: number } | undefined> {
    if (!this.path) return undefined;
    const total = this.chunks.reduce((n, c) => n + c.byteLength, 0);
    const all = new Uint8Array(total);
    for (const c of this.chunks) {
      all.set(c, this.written);
      this.written += c.byteLength;
    }
    try {
      await writeFile(this.path, all, { flag: this.force ? 'w' : 'wx' });
    } catch (err) {
      if ((err as { code?: string }).code === 'EEXIST') {
        throw new UsageError(`${this.path} already exists.`, 'Pass --force to overwrite it, or choose another --out path.');
      }
      throw err;
    }
    return { path: this.path, bytes: total };
  }
}

const FRAMES = ['|', '/', '-', '\\'];

/** A one-line spinner on stderr. Silent unless stderr is a TTY and --quiet is off. */
export class Progress {
  private timer?: ReturnType<typeof setInterval>;
  private label = '';
  private frame = 0;

  constructor(
    private readonly io: Io,
    private readonly enabled: boolean,
  ) {}

  start(label: string): void {
    this.label = label;
    if (!this.enabled) return;
    if (!this.timer) {
      this.timer = setInterval(() => this.draw(), 100);
      this.timer.unref?.();
    }
    this.draw();
  }

  private draw(): void {
    this.frame = (this.frame + 1) % FRAMES.length;
    this.io.stderr(`\r\x1b[2K${FRAMES[this.frame]} ${this.label}`);
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = undefined;
    this.io.stderr('\r\x1b[2K');
  }
}

/** Pad columns to the widest cell. The last column is never padded. */
export function table(rows: string[][]): string {
  const widths: number[] = [];
  for (const r of rows) {
    for (const [i, c] of r.entries()) widths[i] = Math.max(widths[i] ?? 0, c.length);
  }
  return rows
    .map((r) =>
      r
        .map((c, i) => (i === r.length - 1 ? c : c.padEnd(widths[i] ?? 0)))
        .join('  ')
        .trimEnd(),
    )
    .join('\n');
}

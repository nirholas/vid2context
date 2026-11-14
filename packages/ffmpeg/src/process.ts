/**
 * Safe child processes for ffmpeg and ffprobe.
 *
 * Every call spawns the binary directly (never through a shell) with an
 * argument array, so file names cannot inject commands. Inputs that start with
 * `-` are refused so they cannot be read as options, and relative paths are
 * made absolute so a name like `concat:a|b` is never taken as an ffmpeg
 * protocol. Each run has a timeout, is killed when the caller's signal aborts,
 * and keeps only a bounded tail of stderr for error messages.
 */
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { type Ctx, Vid2ContextError } from '@vid2context/core';

/** The parts of a Ctx this package uses. Every field is optional. */
export type FfCtx = Partial<Pick<Ctx, 'env' | 'signal' | 'log' | 'fetch'>>;

export interface RunOptions {
  /** Short name for messages: 'ffprobe', 'ffmpeg audio extraction'. */
  label: string;
  signal?: AbortSignal;
  /** Default 10 minutes. */
  timeoutMs?: number;
  /** Collect stdout into the result. Default false (stdout is ignored). */
  captureStdout?: boolean;
  /** Refuse stdout beyond this many bytes. Default 64 MB. */
  maxStdoutBytes?: number;
  /** Called for each stderr line, for parsers (silencedetect, showinfo). */
  onStderrLine?: (line: string) => void;
  /** Bytes of stderr kept for error messages. Default 16 KB. */
  stderrTailBytes?: number;
  /** Called with the child's pid right after spawn. */
  onSpawn?: (pid: number) => void;
}

export interface RunResult {
  stdout: Uint8Array;
  /** The last `stderrTailBytes` of stderr. */
  stderr: string;
}

const UNREADABLE =
  /Invalid data found|No such file or directory|could not find codec parameters|does not contain any stream|matches no streams|Permission denied|moov atom not found|EBML header parsing failed|Server returned 4\d\d|HTTP error 4\d\d|Failed to resolve hostname|Connection refused/i;

function abortError(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException('The operation was aborted.', 'AbortError');
}

/**
 * Validate an ffmpeg input and return the string to pass after `-i`.
 * http(s) URLs pass through; anything else is a local path made absolute.
 */
export function toInput(input: string): string {
  if (typeof input !== 'string' || input.length === 0 || input.includes('\0')) {
    throw new Vid2ContextError('bad-request', 'Empty or invalid media input.', { hint: 'Pass a file path or an http(s) URL.' });
  }
  if (input.startsWith('-')) {
    throw new Vid2ContextError('bad-request', `Refusing media input that starts with "-": ${input.slice(0, 80)}`, {
      hint: 'Prefix the file name with ./ so it cannot be read as an option.',
    });
  }
  if (/^https?:\/\//i.test(input)) return input;
  if (/^[a-z][a-z0-9+.-]*:/i.test(input) && !/^[a-z]:[\\/]/i.test(input)) {
    throw new Vid2ContextError('bad-request', `Unsupported media input scheme: ${input.slice(0, 80)}`, {
      hint: 'Pass a local file path or an http(s) URL.',
    });
  }
  return resolve(input);
}

/** True for http(s) inputs. */
export function isUrlInput(input: string): boolean {
  return /^https?:\/\//i.test(input);
}

/**
 * Options that go before `-i` for a URL input: only network protocols, so a
 * remote playlist cannot make ffmpeg read local files.
 */
export function inputGuards(input: string): string[] {
  return isUrlInput(input) ? ['-protocol_whitelist', 'http,https,tcp,tls,crypto'] : [];
}

function failure(label: string, code: number | null, sig: NodeJS.Signals | null, stderr: string): Vid2ContextError {
  const tail = stderr.trim().split('\n').slice(-6).join(' | ').slice(0, 600);
  if (code === null) {
    return new Vid2ContextError('upstream', `${label} was killed by ${sig ?? 'a signal'}${tail ? `: ${tail}` : ''}`, {
      hint: 'ffmpeg crashed. Try again; if it repeats, update ffmpeg or set FFMPEG_PATH to another build.',
    });
  }
  if (UNREADABLE.test(stderr)) {
    return new Vid2ContextError('unavailable', `${label} could not read the media: ${tail}`, {
      hint: 'Check that the path or URL points to a complete audio or video file that ffmpeg can play.',
    });
  }
  return new Vid2ContextError('upstream', `${label} failed with exit code ${code}${tail ? `: ${tail}` : ''}`, {
    hint: 'ffmpeg reported an error. Run the same file through ffmpeg directly to see the full log, or update ffmpeg.',
  });
}

/** Run a binary with an argument array. Rejects with a Vid2ContextError on failure, timeout or abort. */
export function runProcess(bin: string, args: string[], opts: RunOptions): Promise<RunResult> {
  const { label, signal } = opts;
  const timeoutMs = opts.timeoutMs ?? 10 * 60_000;
  const maxStdout = opts.maxStdoutBytes ?? 64 * 1024 * 1024;
  const tailBytes = opts.stderrTailBytes ?? 16 * 1024;
  if (signal?.aborted) return Promise.reject(abortError(signal));

  return new Promise<RunResult>((resolvePromise, reject) => {
    const child = spawn(bin, args, {
      shell: false,
      windowsHide: true,
      stdio: ['ignore', opts.captureStdout ? 'pipe' : 'ignore', 'pipe'],
    });
    let settled = false;
    const out: Buffer[] = [];
    let outBytes = 0;
    let stderrTail = '';
    let partial = '';

    const finish = (err: unknown, result?: RunResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      if (err) reject(err);
      else if (result) resolvePromise(result);
    };
    const kill = () => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    };
    const onAbort = () => {
      kill();
      finish(signal ? abortError(signal) : new DOMException('Aborted', 'AbortError'));
    };
    const timer = setTimeout(() => {
      kill();
      finish(
        new Vid2ContextError('timeout', `${label} took longer than ${Math.round(timeoutMs / 1000)} s and was stopped.`, {
          hint: 'The media may be very long or the network slow. Try a shorter file or a faster connection.',
        }),
      );
    }, timeoutMs);
    signal?.addEventListener('abort', onAbort, { once: true });

    if (child.pid !== undefined) opts.onSpawn?.(child.pid);

    child.stdout?.on('data', (chunk: Buffer) => {
      outBytes += chunk.byteLength;
      if (outBytes > maxStdout) {
        kill();
        finish(
          new Vid2ContextError('too-large', `${label} produced more than ${maxStdout} bytes.`, {
            hint: 'The output is larger than expected; use a shorter input.',
          }),
        );
        return;
      }
      out.push(chunk);
    });
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => {
      stderrTail = (stderrTail + chunk).slice(-tailBytes);
      if (!opts.onStderrLine) return;
      partial += chunk;
      const lines = partial.split(/\r?\n|\r/);
      partial = lines.pop() ?? '';
      for (const line of lines) opts.onStderrLine(line);
    });
    child.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT' || err.code === 'EACCES') {
        finish(
          new Vid2ContextError('unavailable', `${label}: cannot run ${bin} (${err.code}).`, {
            hint: 'Install ffmpeg (https://ffmpeg.org/download.html) or set FFMPEG_PATH and FFPROBE_PATH.',
            cause: err,
          }),
        );
      } else {
        finish(new Vid2ContextError('upstream', `${label}: ${err.message}`, { cause: err }));
      }
    });
    child.on('close', (code, sig) => {
      if (partial && opts.onStderrLine) opts.onStderrLine(partial);
      if (code === 0) finish(null, { stdout: new Uint8Array(Buffer.concat(out)), stderr: stderrTail });
      else finish(failure(label, code, sig, stderrTail));
    });
  });
}

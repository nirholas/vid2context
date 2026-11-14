/** Running external programs (doctor only). Injected through RunDeps so tests can replay captured outputs. */
import { execFile } from 'node:child_process';

export interface ExecResult {
  /** Exit code; null when the program was killed (timeout). */
  code: number | null;
  stdout: string;
  stderr: string;
}

/** Run `cmd args`. Resolves null when the program does not exist or cannot be started. */
export type Exec = (cmd: string, args: string[], opts?: { timeoutMs?: number }) => Promise<ExecResult | null>;

export const nodeExec: Exec = (cmd, args, opts = {}) =>
  new Promise((resolve) => {
    execFile(cmd, args, { timeout: opts.timeoutMs ?? 10_000, maxBuffer: 4 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
      const e = err as (NodeJS.ErrnoException & { code?: string | number }) | null;
      if (e && (e.code === 'ENOENT' || e.code === 'EACCES')) return resolve(null);
      const code = e ? (typeof e.code === 'number' ? e.code : null) : 0;
      resolve({ code, stdout: String(stdout), stderr: String(stderr) });
    });
  });

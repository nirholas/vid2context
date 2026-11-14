/**
 * The only code that writes client config files: a timestamped backup next to
 * the file first, then a temp file in the same directory renamed over the
 * original, so a crash never leaves a half-written config behind.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

export function readIfExists(path: string): string | undefined {
  return existsSync(path) ? readFileSync(path, 'utf8') : undefined;
}

/** `<file>.vid2context-backup-20261114T170500Z`, next to the original. */
export function backupPath(path: string, now: Date): string {
  const stamp = now
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d+Z$/, 'Z');
  return join(dirname(path), `${basename(path)}.vid2context-backup-${stamp}`);
}

/** Copies an existing file to its backup path and returns that path, or undefined when there was no file. */
export function backup(path: string, now: Date): string | undefined {
  if (!existsSync(path)) return undefined;
  let target = backupPath(path, now);
  for (let n = 1; existsSync(target); n++) target = `${backupPath(path, now)}-${n}`;
  copyFileSync(path, target);
  return target;
}

export function writeAtomic(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = join(dirname(path), `.${basename(path)}.vid2context-${process.pid}-${Date.now()}.tmp`);
  const mode = existsSync(path) ? statSync(path).mode : undefined;
  try {
    writeFileSync(tmp, content, mode === undefined ? undefined : { mode });
    renameSync(tmp, path);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
}

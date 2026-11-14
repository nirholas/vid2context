/**
 * Where whisper.cpp lives on this machine: the binary resolution order
 * (WHISPER_CPP_BIN, then PATH, then the managed install) and the local data
 * layout under .vid2context/ (or VID2CONTEXT_HOME).
 */
import { accessSync, constants, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, isAbsolute, join, resolve } from 'node:path';
import process from 'node:process';
import type { Env } from '@vid2context/core';

export const IS_WINDOWS = process.platform === 'win32';

/** Local data root: VID2CONTEXT_HOME, else .vid2context/ in the working directory. */
export function dataHome(env: Env): string {
  const home = env.VID2CONTEXT_HOME?.trim();
  return home ? resolve(expandHome(home)) : resolve(process.cwd(), '.vid2context');
}

export function managedBinDir(env: Env): string {
  return join(dataHome(env), 'bin', 'whisper.cpp');
}

export function modelsDir(env: Env): string {
  return join(dataHome(env), 'models', 'whisper');
}

export function locksDir(env: Env): string {
  return join(dataHome(env), 'locks');
}

export function exeName(name: string, windows = IS_WINDOWS): string {
  return windows ? `${name}.exe` : name;
}

export function expandHome(p: string): string {
  if (p === '~') return homedir();
  if (p.startsWith('~/') || p.startsWith('~\\')) return join(homedir(), p.slice(2));
  return p;
}

export function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function isExecutable(path: string): boolean {
  if (!isFile(path)) return false;
  if (IS_WINDOWS) return true;
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Find an executable on the PATH from `env` (not process.env). */
export function which(name: string, env: Env): string | null {
  const pathVar = env.PATH ?? env.Path ?? '';
  const exts = IS_WINDOWS ? (env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';').filter(Boolean) : [''];
  for (const dir of pathVar.split(delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const candidate = join(dir, name + ext.toLowerCase());
      if (isExecutable(candidate)) return candidate;
      if (ext && isExecutable(join(dir, name + ext))) return join(dir, name + ext);
    }
  }
  return null;
}

export type BinaryName = 'whisper-cli' | 'whisper-server';

export interface ResolvedBinary {
  path: string;
  from: 'WHISPER_CPP_BIN' | 'PATH' | 'managed';
}

/**
 * Resolve a whisper.cpp executable. WHISPER_CPP_BIN names whisper-cli; the
 * server is looked for next to it first. WHISPER_CPP_BIN is returned without
 * a stat so the caller can fail with a precise hint when it is wrong.
 */
export function resolveBinary(env: Env, name: BinaryName = 'whisper-cli'): ResolvedBinary | null {
  const configured = env.WHISPER_CPP_BIN?.trim();
  if (configured) {
    const cli = resolve(expandHome(configured));
    if (name === 'whisper-cli') return { path: cli, from: 'WHISPER_CPP_BIN' };
    const sibling = join(dirname(cli), exeName('whisper-server'));
    if (isExecutable(sibling)) return { path: sibling, from: 'WHISPER_CPP_BIN' };
  }
  const onPath = which(name, env);
  if (onPath) return { path: onPath, from: 'PATH' };
  const managed = join(managedBinDir(env), exeName(name));
  if (isExecutable(managed)) return { path: managed, from: 'managed' };
  return null;
}

/** ffmpeg: FFMPEG_PATH, then PATH, then ~/.local/bin/ffmpeg. */
export function resolveFfmpeg(env: Env): string | null {
  const configured = env.FFMPEG_PATH?.trim();
  if (configured) return resolve(expandHome(configured));
  const onPath = which('ffmpeg', env);
  if (onPath) return onPath;
  const local = join(homedir(), '.local', 'bin', exeName('ffmpeg'));
  return isExecutable(local) ? local : null;
}

export function looksLikePath(value: string): boolean {
  return isAbsolute(value) || value.startsWith('~') || value.startsWith('.') || /[\\/]/.test(value) || value.endsWith('.bin');
}

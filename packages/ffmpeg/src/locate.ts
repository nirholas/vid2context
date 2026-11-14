/**
 * Find ffmpeg and ffprobe. Order:
 *
 *   1. FFMPEG_PATH / FFPROBE_PATH (an explicit path that does not exist is an
 *      error, never silently replaced)
 *   2. PATH
 *   3. ~/.local/bin (where user installs of static builds usually go)
 *   4. the managed copy in <VID2CONTEXT_HOME or ./.vid2context>/bin
 *   5. a managed download, when the caller allows it and
 *      VID2CONTEXT_FFMPEG_DOWNLOAD is not 0 (see download.ts)
 *
 * Results are cached per process, keyed by the env values that affect them.
 */
import { accessSync, constants, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { type Env, Vid2ContextError } from '@vid2context/core';
import { downloadFfmpeg } from './download.ts';
import { managedBinDir } from './paths.ts';
import { type FfCtx, runProcess } from './process.ts';

export type ToolSource = 'env' | 'path' | 'local-bin' | 'managed';

export interface FfmpegTools {
  ffmpeg: string;
  ffprobe: string;
  /** From `ffmpeg -version`, e.g. '7.0.2-static' or 'n8.1-latest'. */
  version: string;
  /** Where ffmpeg was found. */
  source: ToolSource;
}

export interface FoundTools {
  ffmpeg?: string;
  ffprobe?: string;
  source?: ToolSource;
  /** Why nothing usable was found, when that is the case. */
  problem?: string;
}

const EXE = process.platform === 'win32' ? '.exe' : '';

function isExecutable(path: string): boolean {
  try {
    if (!statSync(path).isFile()) return false;
    accessSync(path, process.platform === 'win32' ? constants.F_OK : constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function searchDirs(env: Env): { dir: string; source: ToolSource }[] {
  const pathVar = env.PATH ?? env.Path ?? '';
  const dirs: { dir: string; source: ToolSource }[] = pathVar
    .split(delimiter)
    .filter(Boolean)
    .map((dir) => ({ dir, source: 'path' as const }));
  dirs.push({ dir: join(homedir(), '.local', 'bin'), source: 'local-bin' });
  dirs.push({ dir: managedBinDir(env), source: 'managed' });
  return dirs;
}

/** Synchronous search without downloading. Cheap: a few stat calls. */
export function findTools(env: Env = {}): FoundTools {
  let ffmpeg: string | undefined;
  let source: ToolSource | undefined;
  const envFfmpeg = env.FFMPEG_PATH?.trim();
  const envFfprobe = env.FFPROBE_PATH?.trim();
  if (envFfmpeg) {
    if (!isExecutable(envFfmpeg)) return { problem: `FFMPEG_PATH is set to ${envFfmpeg}, which is not an executable file.` };
    ffmpeg = envFfmpeg;
    source = 'env';
  }
  let ffprobe: string | undefined;
  if (envFfprobe) {
    if (!isExecutable(envFfprobe)) return { problem: `FFPROBE_PATH is set to ${envFfprobe}, which is not an executable file.` };
    ffprobe = envFfprobe;
  }
  // ffprobe usually sits next to an explicitly configured ffmpeg.
  if (ffmpeg && !ffprobe && isExecutable(join(dirname(ffmpeg), `ffprobe${EXE}`)))
    ffprobe = join(dirname(ffmpeg), `ffprobe${EXE}`);
  for (const { dir, source: s } of searchDirs(env)) {
    if (!ffmpeg && isExecutable(join(dir, `ffmpeg${EXE}`))) {
      ffmpeg = join(dir, `ffmpeg${EXE}`);
      source = s;
    }
    if (!ffprobe && isExecutable(join(dir, `ffprobe${EXE}`))) ffprobe = join(dir, `ffprobe${EXE}`);
    if (ffmpeg && ffprobe) break;
  }
  if (!ffmpeg || !ffprobe) {
    return {
      ffmpeg,
      ffprobe,
      source,
      problem: `${ffmpeg ? 'ffprobe' : 'ffmpeg'} was not found on PATH, in ~/.local/bin or in ${managedBinDir(env)}.`,
    };
  }
  return { ffmpeg, ffprobe, source };
}

const cache = new Map<string, Promise<FfmpegTools>>();

function cacheKey(env: Env): string {
  return [env.FFMPEG_PATH, env.FFPROBE_PATH, env.PATH ?? env.Path, env.VID2CONTEXT_HOME, process.cwd()].join('\0');
}

/** Parse the version from the first line of `ffmpeg -version`. */
export function parseVersion(text: string): string {
  return /ffmpeg version (\S+)/.exec(text)?.[1] ?? 'unknown';
}

/** Major version, or undefined for git builds ('N-12345-g...') whose number is unknown. */
export function majorVersion(version: string): number | undefined {
  const m = /^n?(\d+)\./.exec(version);
  return m ? Number(m[1]) : undefined;
}

async function describe(found: Required<Pick<FoundTools, 'ffmpeg' | 'ffprobe' | 'source'>>, ctx: FfCtx): Promise<FfmpegTools> {
  const res = await runProcess(found.ffmpeg, ['-hide_banner', '-version'], {
    label: 'ffmpeg -version',
    captureStdout: true,
    timeoutMs: 20_000,
    signal: ctx.signal,
  });
  return { ...found, version: parseVersion(new TextDecoder().decode(res.stdout)) };
}

export function downloadAllowed(env: Env): boolean {
  const v = env.VID2CONTEXT_FFMPEG_DOWNLOAD?.trim().toLowerCase();
  return !(v === '0' || v === 'false' || v === 'no' || v === 'off');
}

function missing(problem: string, env: Env): Vid2ContextError {
  const explicit = Boolean(env.FFMPEG_PATH?.trim() || env.FFPROBE_PATH?.trim());
  return new Vid2ContextError('unavailable', `ffmpeg is not available: ${problem}`, {
    hint: explicit
      ? 'Fix FFMPEG_PATH and FFPROBE_PATH, or unset them to search PATH.'
      : 'Install ffmpeg (Debian/Ubuntu: apt install ffmpeg, macOS: brew install ffmpeg, Windows: winget install ffmpeg), or set FFMPEG_PATH and FFPROBE_PATH.',
  });
}

/**
 * Locate ffmpeg and ffprobe and report the version. With `download: true`, a
 * missing ffmpeg is downloaded into the managed bin directory (Linux x64 and
 * arm64 only) unless VID2CONTEXT_FFMPEG_DOWNLOAD=0. Throws `unavailable` with
 * an install hint when nothing usable is found.
 */
export function locateFfmpeg(ctx: FfCtx = {}, opts: { download?: boolean } = {}): Promise<FfmpegTools> {
  const env = ctx.env ?? {};
  const key = cacheKey(env);
  const hit = cache.get(key);
  if (hit) return hit;
  const found = findTools(env);
  let pending: Promise<FfmpegTools>;
  if (found.ffmpeg && found.ffprobe && found.source && !found.problem) {
    pending = describe({ ffmpeg: found.ffmpeg, ffprobe: found.ffprobe, source: found.source }, ctx);
  } else {
    const explicit = Boolean(env.FFMPEG_PATH?.trim() || env.FFPROBE_PATH?.trim());
    if (!opts.download || explicit || !downloadAllowed(env)) {
      return Promise.reject(missing(found.problem ?? 'not found', env));
    }
    pending = downloadFfmpeg(ctx).then((d) => describe({ ffmpeg: d.ffmpeg, ffprobe: d.ffprobe, source: 'managed' }, ctx));
  }
  const guarded = pending.catch((err) => {
    cache.delete(key);
    throw err;
  });
  cache.set(key, guarded);
  return guarded;
}

/** Like locateFfmpeg without downloading, but resolves to null instead of throwing when ffmpeg is missing. */
export async function tryLocateFfmpeg(ctx: FfCtx = {}): Promise<FfmpegTools | null> {
  try {
    return await locateFfmpeg(ctx, { download: false });
  } catch (err) {
    if (err instanceof Vid2ContextError && err.code === 'unavailable') return null;
    throw err;
  }
}

/** Forget cached locations (after installing or removing ffmpeg). */
export function clearLocateCache(): void {
  cache.clear();
}

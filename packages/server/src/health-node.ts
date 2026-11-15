/**
 * Node checks for GET /healthz?deep=1 (src/health.ts): free disk space in the
 * data directory, yt-dlp and ffmpeg (found and answering their version
 * command, each under a deadline, the process killed when it overruns), and
 * one request to the keyless network. Nothing is installed or updated here:
 * a probe must be cheap and side-effect free.
 */
import { execFile } from 'node:child_process';
import { accessSync, constants, statSync } from 'node:fs';
import { statfs } from 'node:fs/promises';
import { homedir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { type Ctx, type Env, fetchWithTimeout, keylessAllowed } from '@vid2context/core';
import { type HealthCheck, healthSettings } from './health.ts';

/** The keyless STT and LLM host's model list: answers fast and needs no key. */
export const DEFAULT_PROBE_URL = 'https://oai.endpoints.kepler.ai.cloud.ovh.net/v1/models';

const EXE = process.platform === 'win32' ? '.exe' : '';

function dataHome(env: Env): string {
  return resolve(env.VID2CONTEXT_HOME?.trim() || join(process.cwd(), '.vid2context'));
}

function isExecutable(path: string): boolean {
  try {
    if (!statSync(path).isFile()) return false;
    accessSync(path, process.platform === 'win32' ? constants.F_OK : constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function find(name: string, env: Env, configured: string | undefined, extraDirs: string[]): string | undefined {
  if (configured?.trim()) return isExecutable(configured.trim()) ? configured.trim() : undefined;
  const dirs = [...(env.PATH ?? '').split(delimiter).filter(Boolean), ...extraDirs];
  for (const dir of dirs) {
    const p = join(dir, `${name}${EXE}`);
    if (isExecutable(p)) return p;
  }
  return undefined;
}

/** Run `bin args` and return the first stdout line, or throw; killed after `ms`. */
export function versionOf(bin: string, args: string[], ms: number): Promise<string> {
  return new Promise((ok, fail) => {
    execFile(bin, args, { timeout: ms, killSignal: 'SIGKILL', windowsHide: true, maxBuffer: 1024 * 1024 }, (err, stdout) => {
      if (err) {
        fail(new Error(err.killed ? `did not answer within ${ms} ms` : `version command failed: ${err.message.split('\n')[0]}`));
        return;
      }
      ok(
        stdout
          .split(/\r?\n/)
          .find((l) => l.trim())
          ?.trim() ?? '',
      );
    });
  });
}

function num(raw: string | undefined, fallback: number): number {
  const n = Number(raw?.trim());
  return raw?.trim() && Number.isFinite(n) && n >= 0 ? n : fallback;
}

export async function diskCheck(env: Env): Promise<HealthCheck> {
  const minMb = num(env.VID2CONTEXT_HEALTH_MIN_FREE_MB, 512);
  let dir = dataHome(env);
  try {
    statSync(dir);
  } catch {
    dir = process.cwd();
  }
  const s = await statfs(dir);
  const freeMb = Math.floor((Number(s.bavail) * Number(s.bsize)) / (1024 * 1024));
  if (freeMb < minMb) {
    return {
      id: 'disk',
      status: 'fail',
      detail: `${freeMb} MB free in the data directory, under VID2CONTEXT_HEALTH_MIN_FREE_MB (${minMb})`,
    };
  }
  return { id: 'disk', status: 'ok', detail: `${freeMb} MB free in the data directory` };
}

export async function ytdlpCheck(env: Env, ms: number, now = Date.now()): Promise<HealthCheck> {
  const bin = find('yt-dlp', env, env.YTDLP_PATH, [join(dataHome(env), 'bin')]);
  if (!bin) {
    return {
      id: 'yt-dlp',
      status: env.YTDLP_PATH?.trim() ? 'fail' : 'warn',
      detail: env.YTDLP_PATH?.trim()
        ? 'YTDLP_PATH is not an executable file'
        : 'not installed yet; the managed copy is installed on first use',
    };
  }
  const version = await versionOf(bin, ['--version'], ms);
  const m = /^(\d{4})\.(\d{1,2})\.(\d{1,2})/.exec(version);
  const staleDays = num(env.YTDLP_STALE_DAYS, 60) || 60;
  if (m) {
    const days = Math.floor((now - Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))) / 86_400_000);
    if (days > staleDays)
      return { id: 'yt-dlp', status: 'warn', detail: `${version} is ${days} days old (YTDLP_STALE_DAYS ${staleDays})` };
  }
  return { id: 'yt-dlp', status: 'ok', detail: version };
}

export async function ffmpegCheck(env: Env, ms: number): Promise<HealthCheck> {
  const bin = find('ffmpeg', env, env.FFMPEG_PATH, [join(homedir(), '.local', 'bin'), join(dataHome(env), 'bin')]);
  if (!bin) {
    return {
      id: 'ffmpeg',
      status: 'warn',
      detail: env.FFMPEG_PATH?.trim()
        ? 'FFMPEG_PATH is not an executable file'
        : 'not found: local files, long audio and frames need it',
    };
  }
  const line = await versionOf(bin, ['-version'], ms);
  return { id: 'ffmpeg', status: 'ok', detail: /^ffmpeg version (\S+)/.exec(line)?.[1] ?? line.slice(0, 80) };
}

export async function networkCheck(ctx: Ctx, ms: number): Promise<HealthCheck> {
  const raw = ctx.env.VID2CONTEXT_HEALTH_PROBE_URL?.trim();
  if (raw === '0' || raw === 'off')
    return { id: 'network', status: 'ok', detail: 'probe turned off (VID2CONTEXT_HEALTH_PROBE_URL=0)' };
  if (!raw && !keylessAllowed(ctx.env)) return { id: 'network', status: 'ok', detail: 'keyless rungs are off; not probed' };
  const url = raw || DEFAULT_PROBE_URL;
  const host = new URL(url).host;
  const res = await fetchWithTimeout(ctx, url, { headers: { accept: 'application/json' } }, ms);
  await res.body?.cancel();
  if (res.status >= 500) return { id: 'network', status: 'warn', detail: `${host} answered HTTP ${res.status}` };
  return { id: 'network', status: 'ok', detail: `${host} answered HTTP ${res.status}` };
}

function settle(id: string, p: Promise<HealthCheck>): Promise<HealthCheck> {
  return p.catch((err: unknown) => ({ id, status: 'fail' as const, detail: err instanceof Error ? err.message : String(err) }));
}

/** Every Node check, in parallel, each bounded by VID2CONTEXT_HEALTH_TIMEOUT_MS. */
export async function nodeHealthChecks(ctx: Ctx): Promise<HealthCheck[]> {
  const { timeoutMs } = healthSettings(ctx.env);
  return Promise.all([
    settle('disk', diskCheck(ctx.env)),
    settle('yt-dlp', ytdlpCheck(ctx.env, timeoutMs)),
    settle('ffmpeg', ffmpegCheck(ctx.env, timeoutMs)),
    settle('network', networkCheck(ctx, timeoutMs)),
  ]);
}

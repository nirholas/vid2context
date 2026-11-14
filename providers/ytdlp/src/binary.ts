/**
 * Finds, installs, verifies and updates the yt-dlp binary.
 *
 * Resolution order: YTDLP_PATH, then yt-dlp on PATH, then a managed copy in
 * <home>/bin/ where <home> is VID2CONTEXT_HOME or ./.vid2context. When none
 * exists, the official release asset for this platform is downloaded from
 * GitHub, its SHA-256 checked against the release's SHA2-256SUMS, written to a
 * temp file and renamed into place. A lock file in <home>/locks/ytdlp keeps
 * parallel processes from downloading twice. The managed copy checks for a
 * new release at most once a week (YTDLP_AUTO_UPDATE=0 turns that off); a
 * binary the user supplied is never touched.
 */
import { createHash } from 'node:crypto';
import { accessSync, constants, existsSync, statSync } from 'node:fs';
import { chmod, mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir, hostname } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { type Ctx, type Env, fetchWithTimeout, Vid2ContextError } from '@vid2context/core';
import { run } from './process.ts';

export const RELEASES = 'https://github.com/yt-dlp/yt-dlp/releases';
export const RELEASES_API = 'https://api.github.com/repos/yt-dlp/yt-dlp/releases/latest';
const WEEK_MS = 7 * 24 * 3600 * 1000;

export interface JsRuntime {
  name: 'deno' | 'node';
  /** Absolute path when found on PATH, else the running Node binary. */
  path: string;
}

export interface YtDlpInfo {
  path: string;
  version: string;
  /** True when vid2context installed and updates this copy. */
  managed: boolean;
  jsRuntime: JsRuntime;
  /** ffmpeg used for audio extraction and subtitle conversion, when found. */
  ffmpeg?: string;
}

export interface ManagedMeta {
  version: string;
  asset: string;
  sha256: string;
  installedAt: string;
  checkedAt: string;
}

/** Local data directory: VID2CONTEXT_HOME, else ./.vid2context. */
export function dataHome(env: Env): string {
  return env.VID2CONTEXT_HOME || join(process.cwd(), '.vid2context');
}

const exe = (name: string) => (process.platform === 'win32' ? `${name}.exe` : name);

export function managedPath(env: Env): string {
  return join(dataHome(env), 'bin', exe('yt-dlp'));
}

const metaPath = (env: Env) => join(dataHome(env), 'bin', 'yt-dlp.json');
const lockPath = (env: Env) => join(dataHome(env), 'locks', 'ytdlp');

function isExecutable(path: string): boolean {
  try {
    if (!statSync(path).isFile()) return false;
    accessSync(path, process.platform === 'win32' ? constants.F_OK : constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Look a command up on the PATH from env. */
export function findOnPath(name: string, env: Env): string | undefined {
  const dirs = (env.PATH ?? env.Path ?? '').split(delimiter).filter(Boolean);
  const exts = process.platform === 'win32' ? (env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';') : [''];
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = join(dir, name + ext);
      if (isExecutable(candidate)) return candidate;
    }
  }
  return undefined;
}

/** The release asset for this machine, or null where yt-dlp ships no standalone binary. */
export function assetName(platform: string = process.platform, arch: string = process.arch): string | null {
  if (platform === 'linux' && arch === 'x64') return 'yt-dlp_linux';
  if (platform === 'linux' && arch === 'arm64') return 'yt-dlp_linux_aarch64';
  if (platform === 'darwin') return 'yt-dlp_macos';
  if (platform === 'win32' && arch === 'x64') return 'yt-dlp.exe';
  if (platform === 'win32' && arch === 'arm64') return 'yt-dlp_arm64.exe';
  return null;
}

/** Parse a SHA2-256SUMS file into asset name -> lowercase hex digest. */
export function parseSums(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const m = /^([0-9a-fA-F]{64})\s+\*?(.+?)\s*$/.exec(line);
    if (m?.[1] && m[2]) out.set(m[2], m[1].toLowerCase());
  }
  return out;
}

/** The tag of the latest release: the redirect target of releases/latest, else the GitHub API. */
export async function latestTag(ctx: Ctx): Promise<string> {
  try {
    const res = await fetchWithTimeout(ctx, `${RELEASES}/latest`, { method: 'HEAD', redirect: 'manual' }, 20_000);
    const tag = /\/releases\/tag\/([^/?#]+)/.exec(res.headers.get('location') ?? '')?.[1];
    if (tag) return decodeURIComponent(tag);
  } catch (err) {
    ctx.log.debug('yt-dlp: releases/latest redirect failed, trying the API', { error: String(err) });
  }
  const res = await fetchWithTimeout(ctx, RELEASES_API, { headers: { accept: 'application/vnd.github+json' } }, 20_000);
  if (!res.ok) {
    throw new Vid2ContextError('upstream', `GitHub releases API: HTTP ${res.status}`, {
      hint: 'GitHub could not be reached. Install yt-dlp yourself and set YTDLP_PATH, or retry later.',
      status: res.status,
    });
  }
  const body = (await res.json()) as { tag_name?: string };
  if (!body.tag_name) throw new Vid2ContextError('upstream', 'GitHub releases API: no tag_name in the response.');
  return body.tag_name;
}

async function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(t);
        reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
      },
      { once: true },
    );
  });
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Hold an exclusive lock file while `fn` runs. The lock is created with
 * O_EXCL; a lock older than `staleMs`, or one whose process on this host is
 * gone, is removed and retaken.
 */
export async function withLock<T>(
  file: string,
  fn: () => Promise<T>,
  ctx: Ctx,
  opts: { staleMs?: number; waitMs?: number } = {},
): Promise<T> {
  const staleMs = opts.staleMs ?? 10 * 60_000;
  const waitMs = opts.waitMs ?? 15 * 60_000;
  await mkdir(dirname(file), { recursive: true });
  const started = Date.now();
  for (;;) {
    try {
      const fd = await open(file, 'wx');
      await fd.writeFile(JSON.stringify({ pid: process.pid, host: hostname(), at: Date.now() }));
      await fd.close();
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }
    let stale = false;
    try {
      const raw = await readFile(file, 'utf8');
      const owner = JSON.parse(raw) as { pid?: number; host?: string; at?: number };
      const age = Date.now() - (owner.at ?? statSync(file).mtimeMs);
      stale = age > staleMs || (owner.host === hostname() && typeof owner.pid === 'number' && !pidAlive(owner.pid));
    } catch {
      // Unreadable or half-written: stale only when old.
      try {
        stale = Date.now() - statSync(file).mtimeMs > staleMs;
      } catch {
        stale = false;
      }
    }
    if (stale) {
      ctx.log.warn('yt-dlp: removing a stale install lock', { file });
      await rm(file, { force: true });
      continue;
    }
    if (Date.now() - started > waitMs) {
      throw new Vid2ContextError('timeout', `Waited too long for the yt-dlp install lock at ${file}.`, {
        hint: 'Another process is installing yt-dlp. If none is, delete the lock file and retry.',
      });
    }
    await sleep(250 + Math.random() * 250, ctx.signal);
  }
  try {
    return await fn();
  } finally {
    await rm(file, { force: true });
  }
}

async function readMeta(env: Env): Promise<ManagedMeta | null> {
  try {
    return JSON.parse(await readFile(metaPath(env), 'utf8')) as ManagedMeta;
  } catch {
    return null;
  }
}

async function writeMeta(env: Env, meta: ManagedMeta): Promise<void> {
  const file = metaPath(env);
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, `${JSON.stringify(meta, null, 2)}\n`);
  await rename(tmp, file);
}

/** `yt-dlp --version`. */
export async function readVersion(bin: string, ctx: Ctx): Promise<string> {
  const res = await run(bin, ['--version'], ctx, { timeoutMs: 30_000, label: 'yt-dlp --version' });
  const version = res.stdout.trim().split(/\s+/)[0];
  if (res.code !== 0 || !version) {
    throw new Vid2ContextError('no-provider', `${bin} --version failed (exit ${res.code}): ${res.stderr.trim().slice(0, 300)}`, {
      hint: 'The yt-dlp binary is broken. Delete it (or fix YTDLP_PATH) and run `npx tsx providers/ytdlp/src/setup.ts`.',
    });
  }
  return version;
}

async function download(ctx: Ctx, url: string): Promise<Uint8Array> {
  const res = await fetchWithTimeout(ctx, url, {}, 10 * 60_000);
  if (!res.ok) {
    throw new Vid2ContextError('upstream', `Downloading ${url}: HTTP ${res.status}`, {
      hint: 'GitHub could not be reached. Install yt-dlp yourself and set YTDLP_PATH, or retry later.',
      status: res.status,
    });
  }
  return new Uint8Array(await res.arrayBuffer());
}

/**
 * Download the release asset for `tag` (or the latest release), verify it
 * against SHA2-256SUMS, and atomically put it at the managed path. Call with
 * the install lock held.
 */
export async function installManaged(ctx: Ctx, tag?: string): Promise<ManagedMeta> {
  const asset = assetName();
  if (!asset) {
    throw new Vid2ContextError('no-provider', `yt-dlp ships no standalone binary for ${process.platform}/${process.arch}.`, {
      hint: 'Install yt-dlp with pip (python3 -m pip install -U yt-dlp) and put it on PATH, or set YTDLP_PATH.',
    });
  }
  const base = tag ? `${RELEASES}/download/${encodeURIComponent(tag)}` : `${RELEASES}/latest/download`;
  const sums = parseSums(new TextDecoder().decode(await download(ctx, `${base}/SHA2-256SUMS`)));
  const expected = sums.get(asset);
  if (!expected) {
    throw new Vid2ContextError('upstream', `SHA2-256SUMS for yt-dlp ${tag ?? 'latest'} lists no ${asset}.`, {
      hint: 'Install yt-dlp yourself and set YTDLP_PATH.',
    });
  }
  ctx.log.info('yt-dlp: downloading', { asset, tag: tag ?? 'latest' });
  const bytes = await download(ctx, `${base}/${asset}`);
  const actual = createHash('sha256').update(bytes).digest('hex');
  if (actual !== expected) {
    throw new Vid2ContextError('upstream', `yt-dlp ${asset} failed checksum verification (expected ${expected}, got ${actual}).`, {
      hint: 'The download was corrupted or tampered with. Retry; if it keeps failing, install yt-dlp yourself and set YTDLP_PATH.',
    });
  }
  const target = managedPath(ctx.env);
  await mkdir(dirname(target), { recursive: true });
  const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
  try {
    await writeFile(tmp, bytes, { mode: 0o755 });
    await chmod(tmp, 0o755);
    const version = await readVersion(tmp, ctx);
    await rename(tmp, target);
    const now = new Date().toISOString();
    const meta: ManagedMeta = { version, asset, sha256: actual, installedAt: now, checkedAt: now };
    await writeMeta(ctx.env, meta);
    ctx.log.info('yt-dlp: installed', { version, path: target });
    return meta;
  } finally {
    await rm(tmp, { force: true });
  }
}

/** Weekly update check for the managed copy. Failures are logged and the current binary kept. */
async function maybeUpdate(ctx: Ctx, meta: ManagedMeta | null): Promise<void> {
  if (ctx.env.YTDLP_AUTO_UPDATE === '0') return;
  if (meta && Date.now() - Date.parse(meta.checkedAt) < WEEK_MS) return;
  try {
    await withLock(
      lockPath(ctx.env),
      async () => {
        const current = await readMeta(ctx.env);
        if (current && Date.now() - Date.parse(current.checkedAt) < WEEK_MS) return;
        const tag = await latestTag(ctx);
        const version = current?.version ?? (await readVersion(managedPath(ctx.env), ctx));
        if (tag === version) {
          const base = current ?? { version, asset: assetName() ?? '', sha256: '', installedAt: new Date().toISOString() };
          await writeMeta(ctx.env, { ...base, checkedAt: new Date().toISOString() });
          return;
        }
        ctx.log.info('yt-dlp: updating', { from: version, to: tag });
        await installManaged(ctx, tag);
      },
      ctx,
    );
  } catch (err) {
    ctx.log.warn('yt-dlp: update check failed; keeping the installed version', { error: String(err) });
  }
}

/** deno on PATH (yt-dlp's default for YouTube), else Node. */
export function detectJsRuntime(env: Env): JsRuntime {
  const deno = findOnPath('deno', env);
  if (deno) return { name: 'deno', path: deno };
  return { name: 'node', path: findOnPath('node', env) ?? process.execPath };
}

/** FFMPEG_PATH, ffmpeg on PATH, ~/.local/bin/ffmpeg, then a managed copy in <home>/bin. */
export function findFfmpeg(env: Env): string | undefined {
  if (env.FFMPEG_PATH) return env.FFMPEG_PATH;
  const onPath = findOnPath('ffmpeg', env);
  if (onPath) return onPath;
  for (const candidate of [join(homedir(), '.local', 'bin', exe('ffmpeg')), join(dataHome(env), 'bin', exe('ffmpeg'))]) {
    if (isExecutable(candidate)) return candidate;
  }
  return undefined;
}

/** How long a resolved binary is trusted before resolving again (which also reruns the weekly update check). */
const RESOLVE_TTL_MS = 24 * 3600 * 1000;
const resolved = new Map<string, { at: number; info: Promise<YtDlpInfo> }>();

async function resolveBinary(ctx: Ctx): Promise<YtDlpInfo> {
  const env = ctx.env;
  const extras = { jsRuntime: detectJsRuntime(env), ffmpeg: findFfmpeg(env) };
  if (env.YTDLP_PATH) {
    if (!existsSync(env.YTDLP_PATH)) {
      throw new Vid2ContextError('no-provider', `YTDLP_PATH points to ${env.YTDLP_PATH}, which does not exist.`, {
        hint: 'Fix YTDLP_PATH, or unset it to let vid2context install and manage yt-dlp.',
      });
    }
    return { path: env.YTDLP_PATH, version: await readVersion(env.YTDLP_PATH, ctx), managed: false, ...extras };
  }
  const onPath = findOnPath('yt-dlp', env);
  if (onPath) return { path: onPath, version: await readVersion(onPath, ctx), managed: false, ...extras };

  const target = managedPath(env);
  if (!isExecutable(target)) {
    await withLock(
      lockPath(env),
      async () => {
        if (!isExecutable(target)) {
          let tag: string | undefined;
          try {
            tag = await latestTag(ctx);
          } catch (err) {
            ctx.log.debug('yt-dlp: could not read the latest tag; using releases/latest/download', { error: String(err) });
          }
          await installManaged(ctx, tag);
        }
      },
      ctx,
    );
  } else {
    await maybeUpdate(ctx, await readMeta(env));
  }
  const meta = await readMeta(env);
  return { path: target, version: meta?.version ?? (await readVersion(target, ctx)), managed: true, ...extras };
}

/**
 * Find or install yt-dlp and report what will be used. Memoized per process
 * (and per YTDLP_PATH, PATH and home), so callers can use it on every request.
 */
export function ensureYtDlp(ctx: Ctx): Promise<YtDlpInfo> {
  const key = [ctx.env.YTDLP_PATH ?? '', ctx.env.PATH ?? '', dataHome(ctx.env), ctx.env.FFMPEG_PATH ?? ''].join('\0');
  const hit = resolved.get(key);
  if (hit && Date.now() - hit.at < RESOLVE_TTL_MS) return hit.info;
  const info = resolveBinary(ctx);
  const entry = { at: Date.now(), info };
  resolved.set(key, entry);
  info.catch(() => {
    if (resolved.get(key) === entry) resolved.delete(key);
  });
  return info;
}

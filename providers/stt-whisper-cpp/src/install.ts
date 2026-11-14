/**
 * Managed whisper.cpp install in .vid2context/bin/whisper.cpp/.
 *
 * ggml-org/whisper.cpp tags releases as vX.Y.Z with no files attached; the
 * binaries live on the matching nightly release (bNNNN, same commit), which
 * the version release links as "Nightly build". Prebuilt CPU binaries exist
 * for Linux x64 and arm64 and for Windows (CPU and CUDA). Everything else
 * (macOS with Metal, Linux with CUDA or Vulkan) is built from the release
 * tag's source with CMake. build.json records what was installed and how.
 */
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { dirname, join } from 'node:path';
import process from 'node:process';
import { type Ctx, errorFromResponse, fetchWithTimeout, Vid2ContextError } from '@vid2context/core';
import { run, SpawnError } from './exec.ts';
import type { Hardware } from './hardware.ts';
import { withLock } from './lock.ts';
import { downloadVerified } from './models.ts';
import { exeName, managedBinDir, which } from './paths.ts';

export const GITHUB_REPO = 'ggml-org/whisper.cpp';
const API = `https://api.github.com/repos/${GITHUB_REPO}`;

export type Backend = 'cpu' | 'cuda' | 'metal' | 'vulkan';

export interface GhAsset {
  name: string;
  size: number;
  digest?: string | null;
  browser_download_url: string;
}

export interface GhRelease {
  tag_name: string;
  target_commitish: string;
  body?: string | null;
  assets: GhAsset[];
}

export interface BuildInfo {
  version: string;
  tag: string;
  commit?: string;
  source: 'prebuilt' | 'source';
  backend: Backend;
  /** Prebuilt archive name and sha256, or the CMake flags of a source build. */
  asset?: string;
  sha256?: string;
  flags: string[];
  platform: string;
  arch: string;
  installedAt: string;
}

export type InstallPlan =
  | { kind: 'prebuilt'; asset: RegExp; backend: Backend; notes: string[] }
  | { kind: 'source'; backend: Backend; flags: string[]; notes: string[] };

export interface Toolchain {
  cmake: boolean;
  nvcc: boolean;
  /** Vulkan shader compiler, needed for a Vulkan build. */
  glslc: boolean;
}

export interface PlanOptions {
  forceCpu?: boolean;
  fromSource?: boolean;
}

/** Decide between a prebuilt archive and a source build for this machine. Pure. */
export function planInstall(platform: string, arch: string, hw: Hardware, tools: Toolchain, opts: PlanOptions = {}): InstallPlan {
  const notes: string[] = [];
  const nvidia = !opts.forceCpu && hw.gpu.vendor === 'nvidia';
  if (platform === 'darwin') {
    const metal = !opts.forceCpu && arch === 'arm64';
    return { kind: 'source', backend: metal ? 'metal' : 'cpu', flags: metal ? [] : ['-DGGML_METAL=OFF'], notes };
  }
  if (platform === 'win32' && !opts.fromSource) {
    if (arch === 'arm64') return { kind: 'prebuilt', asset: /^whisper-bin-win-cpu-arm64\.zip$/, backend: 'cpu', notes };
    if (nvidia)
      return { kind: 'prebuilt', asset: /^whisper-(bin-win-cuda|cublas)-12[\d.]*-(bin-)?x64\.zip$/, backend: 'cuda', notes };
    return { kind: 'prebuilt', asset: /^whisper-bin-x64\.zip$/, backend: 'cpu', notes };
  }
  if (nvidia) {
    if (tools.nvcc) return { kind: 'source', backend: 'cuda', flags: ['-DGGML_CUDA=1'], notes };
    notes.push(
      'An NVIDIA GPU was found but nvcc is not on PATH: installing a CPU build. Install the CUDA toolkit and rerun setup with --force to build with CUDA.',
    );
  } else if (!opts.forceCpu && hw.gpu.vulkan && tools.glslc && hw.gpu.vendor !== 'none') {
    return { kind: 'source', backend: 'vulkan', flags: ['-DGGML_VULKAN=1'], notes };
  }
  if (platform === 'linux' && (arch === 'x64' || arch === 'arm64') && !opts.fromSource) {
    return { kind: 'prebuilt', asset: new RegExp(`^whisper-bin-ubuntu-${arch}\\.tar\\.gz$`), backend: 'cpu', notes };
  }
  return { kind: 'source', backend: 'cpu', flags: [], notes };
}

/** The nightly tag a version release links to ("**Nightly build:** [b5454](...)"). */
export function nightlyTagOf(body: string | null | undefined): string | null {
  return /Nightly build:\**\s*\[(b\d+)\]/i.exec(body ?? '')?.[1] ?? null;
}

async function ghJson(ctx: Ctx, path: string): Promise<GhRelease> {
  const res = await fetchWithTimeout(
    ctx,
    `${API}${path}`,
    { headers: { accept: 'application/vnd.github+json', 'user-agent': 'vid2context' } },
    30_000,
  );
  if (!res.ok) throw await errorFromResponse(res, `GitHub ${GITHUB_REPO}${path}`);
  return (await res.json()) as GhRelease;
}

export interface ReleaseInfo {
  /** The version tag (v1.9.5). */
  tag: string;
  commit: string;
  /** The release that carries the prebuilt files: the version release itself or its nightly twin. */
  assets: GhAsset[];
  assetsTag: string;
}

/** Find the latest release and the release holding its prebuilt binaries. */
export async function latestRelease(ctx: Ctx): Promise<ReleaseInfo> {
  const latest = await ghJson(ctx, '/releases/latest');
  const base = { tag: latest.tag_name, commit: latest.target_commitish };
  if (latest.assets.length > 0) return { ...base, assets: latest.assets, assetsTag: latest.tag_name };
  const nightly = nightlyTagOf(latest.body);
  if (!nightly) return { ...base, assets: [], assetsTag: latest.tag_name };
  const twin = await ghJson(ctx, `/releases/tags/${nightly}`);
  if (twin.target_commitish !== latest.target_commitish) {
    ctx.log.warn('the nightly release is not on the same commit as the version release', { version: latest.tag_name, nightly });
  }
  return { ...base, assets: twin.assets, assetsTag: twin.tag_name };
}

export function pickAsset(assets: GhAsset[], pattern: RegExp): GhAsset | null {
  return assets.find((a) => pattern.test(a.name)) ?? null;
}

export function readBuildInfo(dir: string): BuildInfo | null {
  try {
    return JSON.parse(readFileSync(join(dir, 'build.json'), 'utf8')) as BuildInfo;
  } catch {
    return null;
  }
}

function findFile(root: string, name: string, depth = 6): string | null {
  if (depth < 0 || !existsSync(root)) return null;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const p = join(root, entry.name);
    if (entry.isFile() && entry.name === name) return p;
  }
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      const found = findFile(join(root, entry.name), name, depth - 1);
      if (found) return found;
    }
  }
  return null;
}

async function mustRun(
  file: string,
  args: string[],
  ctx: Ctx,
  what: string,
  hint: string,
  opts: { cwd?: string; timeoutMs?: number } = {},
) {
  let r: Awaited<ReturnType<typeof run>>;
  try {
    r = await run(file, args, {
      cwd: opts.cwd,
      timeoutMs: opts.timeoutMs ?? 10 * 60_000,
      signal: ctx.signal,
      env: ctx.env,
      onStderr: (d) => ctx.log.debug(d.trimEnd()),
    });
  } catch (err) {
    if (err instanceof SpawnError)
      throw new Vid2ContextError('unavailable', `${what}: cannot run ${file} (${err.errno}).`, { hint, cause: err });
    throw err;
  }
  if (r.timedOut) throw new Vid2ContextError('timeout', `${what} timed out.`, { hint });
  if (r.code !== 0) {
    const out = `${r.stdout}\n${r.stderr}`.trim().slice(-1500);
    throw new Vid2ContextError('unavailable', `${what} failed (exit ${r.code}):\n${out}`, { hint });
  }
  return r;
}

export function detectToolchain(env: Ctx['env']): Toolchain {
  return { cmake: Boolean(which('cmake', env)), nvcc: Boolean(which('nvcc', env)), glslc: Boolean(which('glslc', env)) };
}

async function installPrebuilt(rel: ReleaseInfo, plan: Extract<InstallPlan, { kind: 'prebuilt' }>, staging: string, ctx: Ctx) {
  const asset = pickAsset(rel.assets, plan.asset);
  if (!asset) return null;
  const archive = join(staging, asset.name);
  const sha256 = asset.digest?.startsWith('sha256:') ? asset.digest.slice(7) : undefined;
  if (sha256) {
    await downloadVerified(asset.browser_download_url, archive, { sha256, size: asset.size }, ctx, asset.name);
  } else {
    ctx.log.warn('GitHub published no digest for this archive; installing it unverified', { asset: asset.name });
    const res = await fetchWithTimeout(ctx, asset.browser_download_url, { redirect: 'follow' }, 60 * 60_000);
    if (!res.ok) throw await errorFromResponse(res, `Download of ${asset.name}`);
    writeFileSync(archive, new Uint8Array(await res.arrayBuffer()));
  }
  const extract = join(staging, 'extract');
  mkdirSync(extract, { recursive: true });
  // bsdtar on macOS and Windows 10+ also extracts zip archives.
  await mustRun(
    'tar',
    ['-xf', archive, '-C', extract],
    ctx,
    `Extracting ${asset.name}`,
    'Install tar (bsdtar on Windows 10 or newer ships it).',
  );
  const cli = findFile(extract, exeName('whisper-cli'));
  if (!cli)
    throw new Vid2ContextError('upstream', `${asset.name} does not contain whisper-cli.`, {
      hint: 'Rerun setup with --from-source to build it instead.',
    });
  return { dir: dirname(cli), asset: asset.name, sha256 };
}

async function buildFromSource(rel: ReleaseInfo, plan: Extract<InstallPlan, { kind: 'source' }>, staging: string, ctx: Ctx) {
  const tools = detectToolchain(ctx.env);
  if (!tools.cmake) {
    throw new Vid2ContextError('unavailable', 'Building whisper.cpp needs CMake, which is not on PATH.', {
      hint: 'Install CMake 3.14 or newer and a C++ compiler (macOS: xcode-select --install and brew install cmake; Debian/Ubuntu: apt install cmake build-essential; or pip install cmake), then rerun setup.',
    });
  }
  const tarball = join(staging, `${rel.tag}.tar.gz`);
  const res = await fetchWithTimeout(
    ctx,
    `https://github.com/${GITHUB_REPO}/archive/refs/tags/${rel.tag}.tar.gz`,
    { redirect: 'follow' },
    30 * 60_000,
  );
  if (!res.ok) throw await errorFromResponse(res, `Download of whisper.cpp ${rel.tag} source`);
  writeFileSync(tarball, new Uint8Array(await res.arrayBuffer()));
  const src = join(staging, 'src');
  mkdirSync(src, { recursive: true });
  await mustRun('tar', ['-xzf', tarball, '-C', src, '--strip-components=1'], ctx, 'Extracting the source', 'Install tar.');
  const build = join(src, 'build');
  const compilerHint =
    'Install a C++ compiler (macOS: xcode-select --install; Debian/Ubuntu: apt install build-essential; Windows: Visual Studio Build Tools). For CUDA builds, the CUDA toolkit must match your driver.';
  const flags = [
    '-DCMAKE_BUILD_TYPE=Release',
    '-DBUILD_SHARED_LIBS=OFF',
    '-DWHISPER_BUILD_TESTS=OFF',
    '-DWHISPER_SDL2=OFF',
    ...plan.flags,
  ];
  ctx.log.info(`configuring whisper.cpp ${rel.tag} (${plan.backend})`);
  await mustRun('cmake', ['-S', src, '-B', build, ...flags], ctx, 'CMake configure', compilerHint);
  ctx.log.info('building whisper-cli and whisper-server; this takes a few minutes');
  const jobs = String(Math.max(1, availableParallelism()));
  await mustRun(
    'cmake',
    ['--build', build, '--config', 'Release', '-j', jobs, '--target', 'whisper-cli', 'whisper-server'],
    ctx,
    'whisper.cpp build',
    compilerHint,
    {
      timeoutMs: 90 * 60_000,
    },
  );
  const cli = findFile(build, exeName('whisper-cli'));
  if (!cli)
    throw new Vid2ContextError('upstream', 'The build finished but whisper-cli was not produced.', { hint: compilerHint });
  return { dir: dirname(cli), flags };
}

export interface InstallResult {
  dir: string;
  cli: string;
  server?: string;
  build: BuildInfo;
  reused: boolean;
  notes: string[];
}

export interface InstallOptions extends PlanOptions {
  hardware: Hardware;
  /** Reinstall even when a managed build is present. */
  force?: boolean;
}

/** Install whisper.cpp into the managed directory, under a lock. Reuses an existing install unless `force`. */
export async function installWhisperCpp(opts: InstallOptions, ctx: Ctx): Promise<InstallResult> {
  const dir = managedBinDir(ctx.env);
  const cliPath = join(dir, exeName('whisper-cli'));
  const serverPath = join(dir, exeName('whisper-server'));
  const result = (build: BuildInfo, reused: boolean, notes: string[]): InstallResult => ({
    dir,
    cli: cliPath,
    server: existsSync(serverPath) ? serverPath : undefined,
    build,
    reused,
    notes,
  });
  return withLock(
    ctx.env,
    'whisper-cpp-install',
    async () => {
      const existing = readBuildInfo(dir);
      if (existing && existsSync(cliPath) && !opts.force) return result(existing, true, []);

      const plan = planInstall(process.platform, process.arch, opts.hardware, detectToolchain(ctx.env), opts);
      for (const n of plan.notes) ctx.log.warn(n);
      const rel = await latestRelease(ctx);
      const root = dirname(dir);
      mkdirSync(root, { recursive: true });
      const staging = join(root, `.whisper.cpp-staging-${process.pid}`);
      rmSync(staging, { recursive: true, force: true });
      mkdirSync(staging, { recursive: true });
      try {
        let built: {
          dir: string;
          asset?: string;
          sha256?: string;
          flags: string[];
          backend: Backend;
          source: BuildInfo['source'];
        } | null = null;
        if (plan.kind === 'prebuilt') {
          ctx.log.info(`installing prebuilt whisper.cpp ${rel.tag} (${rel.assetsTag})`);
          const p = await installPrebuilt(rel, plan, staging, ctx);
          if (p) built = { ...p, flags: [], backend: plan.backend, source: 'prebuilt' };
          else ctx.log.warn(`no prebuilt archive matches ${plan.asset} in ${rel.assetsTag}; building from source`);
        }
        if (!built) {
          const sourcePlan =
            plan.kind === 'source' ? plan : { kind: 'source' as const, backend: 'cpu' as const, flags: [], notes: [] };
          const s = await buildFromSource(rel, sourcePlan, staging, ctx);
          built = { dir: s.dir, flags: s.flags, backend: sourcePlan.backend, source: 'source' };
        }
        const out = join(staging, 'out');
        mkdirSync(out, { recursive: true });
        if (built.source === 'prebuilt') {
          cpSync(built.dir, out, { recursive: true, verbatimSymlinks: true });
        } else {
          for (const name of ['whisper-cli', 'whisper-server']) {
            const f = join(built.dir, exeName(name));
            if (existsSync(f)) cpSync(f, join(out, exeName(name)));
          }
        }
        const build: BuildInfo = {
          version: rel.tag.replace(/^v/, ''),
          tag: rel.tag,
          commit: rel.commit,
          source: built.source,
          backend: built.backend,
          asset: built.asset,
          sha256: built.sha256,
          flags: built.flags,
          platform: process.platform,
          arch: process.arch,
          installedAt: new Date().toISOString(),
        };
        writeFileSync(join(out, 'build.json'), `${JSON.stringify(build, null, 2)}\n`);
        const old = `${dir}.old-${process.pid}`;
        if (existsSync(dir)) renameSync(dir, old);
        renameSync(out, dir);
        rmSync(old, { recursive: true, force: true });
        return result(build, false, plan.notes);
      } finally {
        rmSync(staging, { recursive: true, force: true });
      }
    },
    { signal: ctx.signal, onWait: () => ctx.log.info('waiting for another process installing whisper.cpp') },
  );
}

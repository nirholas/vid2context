/** Gathers what the doctor checks look at: binaries, the data directory, keys, and two network probes. */
import { accessSync, constants, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { type Ctx, type Env, fetchWithTimeout, keylessAllowed, type Registry } from '@vid2context/core';
import type { Exec } from '../exec.ts';
import {
  type Check,
  checkDataDir,
  checkGpu,
  checkKeyless,
  checkKeys,
  checkNode,
  checkTool,
  checkYouTube,
  type HttpObservation,
  PROBE_VIDEO,
  TOOLS,
  type ToolObservation,
  type YouTubeObservation,
} from './checks.ts';

export const OVH_MODELS_URL = 'https://oai.endpoints.kepler.ai.cloud.ovh.net/v1/models';

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

/** The data directory: VID2CONTEXT_HOME, else ./.vid2context. */
export function dataDir(env: Env, cwd: string): string {
  const home = env.VID2CONTEXT_HOME?.trim();
  return home ? resolve(cwd, home) : resolve(cwd, '.vid2context');
}

/** Find a binary: the env var path, then PATH, then ~/.local/bin, then <data dir>/bin. */
export function findBinary(name: string, env: Env, cwd: string, envVar?: string): ToolObservation {
  const configured = envVar ? env[envVar]?.trim() : undefined;
  if (configured) {
    return isExecutable(configured) ? { path: configured } : { problem: `${envVar} is set to ${configured}, which is not an executable file.` };
  }
  const dirs = [
    ...(env.PATH ?? env.Path ?? '').split(delimiter).filter(Boolean),
    join(homedir(), '.local', 'bin'),
    join(dataDir(env, cwd), 'bin'),
  ];
  for (const dir of dirs) {
    const p = join(dir, `${name}${EXE}`);
    if (isExecutable(p)) return { path: p };
  }
  return {};
}

async function observeTool(tool: (typeof TOOLS)[keyof typeof TOOLS], env: Env, cwd: string, exec: Exec): Promise<ToolObservation> {
  const found = findBinary(tool.binary, env, cwd, tool.envVar);
  if (!found.path) return found;
  const res = await exec(found.path, tool.args, { timeoutMs: 15_000 });
  return { ...found, output: res && res.code === 0 ? res.stdout : undefined };
}

function probeDataDir(dir: string): string | undefined {
  try {
    mkdirSync(dir, { recursive: true });
    const probe = join(dir, `.doctor-${process.pid}`);
    writeFileSync(probe, 'ok');
    rmSync(probe);
    return undefined;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

/** Every env var name a rung requires, and the ones that are set. Names only. */
export function keyNames(registry: Registry, env: Env): { known: string[]; set: string[] } {
  const known = new Set<string>();
  for (const rungs of [registry.sttRungs(env), registry.llmRungs(env), registry.embedRungs(env), registry.videoRungs(env), registry.visualRungs(env)]) {
    for (const r of rungs) for (const n of r.requires) known.add(n);
  }
  const all = [...known].sort();
  return { known: all, set: all.filter((n) => Boolean(env[n])) };
}

export async function probeKeyless(ctx: Ctx): Promise<HttpObservation> {
  try {
    const res = await fetchWithTimeout(ctx, OVH_MODELS_URL, { headers: { accept: 'application/json' } }, 10_000);
    return { status: res.status, body: await res.text() };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

/** Ask the captions provider directly, so a block surfaces as its own error rather than inside "no transcript". */
export async function probeYouTube(registry: Registry, ctx: Ctx): Promise<YouTubeObservation> {
  let ref: ReturnType<Registry['resolve']>['ref'];
  try {
    ref = registry.resolve(PROBE_VIDEO).ref;
  } catch {
    return { notInstalled: true };
  }
  const provider = registry.captions().find((p) => p.supports(ref));
  if (ref.platform !== 'youtube' || !provider) return { notInstalled: true };
  try {
    const t = await provider.getCaptions(ref, { language: 'en' }, ctx);
    if (!t) return { error: new Error(`${PROBE_VIDEO} returned no caption tracks, which it always has`) };
    return { segments: t.segments.length, origin: t.origin };
  } catch (err) {
    return { error: err };
  }
}

export async function runDoctor(opts: { registry: Registry; ctx: Ctx; exec: Exec; cwd: string; nodeVersion: string }): Promise<Check[]> {
  const { registry, ctx, exec, cwd } = opts;
  const env = ctx.env;
  const dir = dataDir(env, cwd);
  const keys = keyNames(registry, env);
  const [ffmpeg, ffprobe, ytdlp, deno, gpu, keyless, youtube] = await Promise.all([
    observeTool(TOOLS.ffmpeg, env, cwd, exec),
    observeTool(TOOLS.ffprobe, env, cwd, exec),
    observeTool(TOOLS.ytdlp, env, cwd, exec),
    observeTool(TOOLS.deno, env, cwd, exec),
    exec('nvidia-smi', ['--query-gpu=name,memory.total,driver_version', '--format=csv,noheader'], { timeoutMs: 15_000 }),
    keylessAllowed(env) ? probeKeyless(ctx) : Promise.resolve({}),
    probeYouTube(registry, ctx),
  ]);
  return [
    checkNode(opts.nodeVersion),
    checkTool(TOOLS.ffmpeg, ffmpeg),
    checkTool(TOOLS.ffprobe, ffprobe),
    checkTool(TOOLS.ytdlp, ytdlp),
    checkTool(TOOLS.deno, deno),
    checkGpu(gpu && gpu.code === 0 ? gpu.stdout : null),
    checkDataDir(dir, probeDataDir(dir)),
    checkKeys(keys.set, keys.known),
    checkKeyless(keyless, keylessAllowed(env)),
    checkYouTube(youtube),
  ];
}

export function renderChecks(checks: Check[]): string {
  const width = Math.max(...checks.map((c) => c.label.length));
  const lines = checks.flatMap((c) => [
    `${c.status.padEnd(4)}  ${c.label.padEnd(width)}  ${c.detail}`,
    ...(c.fix && c.status !== 'ok' ? [`${' '.repeat(6 + width)}  fix: ${c.fix}`] : []),
  ]);
  const fails = checks.filter((c) => c.status === 'fail').length;
  const warns = checks.filter((c) => c.status === 'warn').length;
  return `${lines.join('\n')}\n\n${checks.length} checks: ${checks.length - fails - warns} ok, ${warns} warn, ${fails} fail\n`;
}

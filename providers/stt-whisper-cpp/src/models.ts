/**
 * whisper.cpp ggml models from the official Hugging Face repository
 * (ggerganov/whisper.cpp): catalog, name resolution, a hardware-based
 * recommendation, and a resumable download verified against the sha256 the
 * repository publishes (the Git LFS oid in its tree API).
 */
import { createHash } from 'node:crypto';
import { createReadStream, mkdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { type Ctx, type Env, errorFromResponse, fetchWithTimeout, Vid2ContextError } from '@vid2context/core';
import type { Hardware } from './hardware.ts';
import { withLock } from './lock.ts';
import { expandHome, isFile, looksLikePath, modelsDir } from './paths.ts';

export const HF_REPO = 'ggerganov/whisper.cpp';
export const HF_BASE = 'https://huggingface.co';

/** File sizes in bytes from the repository's tree on 2026-11-14 (test/fixtures/hf-tree-main.json). For display; downloads check the live index. */
export const MODEL_SIZES: Record<string, number> = {
  tiny: 77691713,
  'tiny-q5_1': 32152673,
  'tiny-q8_0': 43537433,
  'tiny.en': 77704715,
  'tiny.en-q5_1': 32166155,
  'tiny.en-q8_0': 43550795,
  base: 147951465,
  'base-q5_1': 59707625,
  'base-q8_0': 81768585,
  'base.en': 147964211,
  'base.en-q5_1': 59721011,
  'base.en-q8_0': 81781811,
  small: 487601967,
  'small-q5_1': 190085487,
  'small-q8_0': 264464607,
  'small.en': 487614201,
  'small.en-q5_1': 190098681,
  'small.en-q8_0': 264477561,
  medium: 1533763059,
  'medium-q5_0': 539212467,
  'medium-q8_0': 823369779,
  'medium.en': 1533774781,
  'medium.en-q5_0': 539225533,
  'medium.en-q8_0': 823382461,
  'large-v3-turbo': 1624555275,
  'large-v3-turbo-q5_0': 574041195,
  'large-v3-turbo-q8_0': 874188075,
  'large-v3': 3095033483,
  'large-v3-q5_0': 1081140203,
};

export const MODEL_NAMES = Object.keys(MODEL_SIZES);

export function modelFileName(name: string): string {
  return `ggml-${name}.bin`;
}

/** True for English-only models (`base.en`, `small.en-q5_1`). They cannot detect language or translate. */
export function isEnglishOnly(name: string): boolean {
  return /\.en(-|$)/.test(name);
}

/** 1 (rough) to 5 (best), for the chain's quality policy. */
export function qualityOf(name: string): number {
  if (name.startsWith('large-v3-turbo')) return 4;
  if (name.startsWith('large')) return 5;
  if (name.startsWith('medium')) return 4;
  if (name.startsWith('small')) return 3;
  if (name.startsWith('base')) return 2;
  if (name.startsWith('tiny')) return 1;
  return 3;
}

/**
 * The model name for rung ids, from WHISPER_CPP_MODEL. Pure string work (no
 * filesystem): a path becomes its file name without `ggml-` and `.bin`.
 */
export function modelNameOf(value: string): string {
  const v = value.trim();
  if (!looksLikePath(v)) return v;
  return basename(v)
    .replace(/^ggml-/, '')
    .replace(/\.bin$/, '');
}

export interface ResolvedModel {
  name: string;
  path: string;
  /** True when the name is in the official catalog, so setup can download it. */
  known: boolean;
}

/** Resolve WHISPER_CPP_MODEL (a catalog name or a path) to a file path. Does not touch the filesystem. */
export function resolveModel(value: string, env: Env): ResolvedModel {
  const v = value.trim();
  if (looksLikePath(v)) {
    const path = resolve(expandHome(v));
    const name = modelNameOf(v);
    return { name, path, known: false };
  }
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(v)) {
    throw new Vid2ContextError('bad-request', `Invalid whisper.cpp model name: ${v}`, {
      hint: `Use a model name such as base.en or large-v3-turbo-q5_0, or an absolute path to a ggml .bin file. Known names: ${MODEL_NAMES.join(', ')}.`,
    });
  }
  return { name: v, path: join(modelsDir(env), modelFileName(v)), known: v in MODEL_SIZES };
}

/**
 * Pick a model for the hardware. NVIDIA with 6 GB or more VRAM, or Apple
 * Silicon: large-v3-turbo. CPU only: small on 8 or more cores with 8 GB of
 * memory, else base. English-only variants when the language is English.
 */
export function recommendModel(hw: Hardware, opts: { language?: string; forceCpu?: boolean } = {}): string {
  const english = opts.language?.toLowerCase().startsWith('en') ?? false;
  const gpu = !opts.forceCpu && hw.gpu;
  if (gpu && ((gpu.vendor === 'nvidia' && (gpu.vramMb ?? 0) >= 6000) || (gpu.vendor === 'apple' && gpu.metal))) {
    return 'large-v3-turbo';
  }
  const family = gpu && gpu.vendor === 'nvidia' ? 'small' : hw.cpuCores >= 8 && hw.memoryMb >= 8000 ? 'small' : 'base';
  return english ? `${family}.en` : family;
}

export interface ModelIndexEntry {
  size: number;
  sha256: string;
}

interface TreeEntry {
  type?: string;
  path?: string;
  size?: number;
  lfs?: { oid?: string; size?: number };
}

/** Parse the Hugging Face tree API into file name -> size and sha256. */
export function parseModelIndex(tree: unknown): Map<string, ModelIndexEntry> {
  const out = new Map<string, ModelIndexEntry>();
  if (!Array.isArray(tree)) return out;
  for (const e of tree as TreeEntry[]) {
    const oid = e.lfs?.oid;
    if (!e.path || !oid || !/^[0-9a-f]{64}$/.test(oid)) continue;
    out.set(e.path, { size: e.lfs?.size ?? e.size ?? 0, sha256: oid });
  }
  return out;
}

export async function fetchModelIndex(ctx: Ctx): Promise<Map<string, ModelIndexEntry>> {
  const url = `${HF_BASE}/api/models/${HF_REPO}/tree/main`;
  let res: Response;
  try {
    res = await fetchWithTimeout(ctx, url, {}, 30_000);
  } catch (err) {
    throw new Vid2ContextError(
      'unavailable',
      `Could not reach Hugging Face to list whisper.cpp models: ${(err as Error).message}`,
      {
        hint: 'Check the network connection, or download the model yourself and set WHISPER_CPP_MODEL to its absolute path.',
        cause: err,
      },
    );
  }
  if (!res.ok) throw await errorFromResponse(res, 'Hugging Face model index');
  return parseModelIndex(await res.json());
}

async function sha256OfFile(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

function sizeOf(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

/**
 * Download `url` to `dest`, resuming `<dest>.part` with an HTTP Range request,
 * and rename into place only after the size and sha256 match. A mismatch
 * deletes the partial file, so a bad or half-written file is never left at `dest`.
 */
export async function downloadVerified(
  url: string,
  dest: string,
  expected: { sha256: string; size?: number },
  ctx: Ctx,
  label = basename(dest),
): Promise<void> {
  const part = `${dest}.part`;
  let have = sizeOf(part);
  if (expected.size && have > expected.size) {
    rmSync(part, { force: true });
    have = 0;
  }
  const headers: Record<string, string> = have > 0 ? { range: `bytes=${have}-` } : {};
  const res = await fetchWithTimeout(ctx, url, { headers, redirect: 'follow' }, 6 * 60 * 60 * 1000);
  if (res.status === 416 && have > 0) {
    await res.body?.cancel();
  } else {
    if (!res.ok) throw await errorFromResponse(res, `Download of ${label}`);
    const resumed = res.status === 206;
    if (!resumed) have = 0;
    const hash = createHash('sha256');
    if (resumed) {
      for await (const chunk of createReadStream(part)) hash.update(chunk as Buffer);
    }
    const total = expected.size ?? have + Number(res.headers.get('content-length') ?? 0);
    const fh = await open(part, resumed ? 'a' : 'w');
    let written = have;
    let nextLog = 0.1;
    try {
      if (!res.body) throw new Vid2ContextError('upstream', `Download of ${label} returned no body.`);
      for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
        hash.update(chunk);
        await fh.write(chunk);
        written += chunk.byteLength;
        if (total > 0 && written / total >= nextLog) {
          ctx.log.info(`downloading ${label}: ${Math.floor((written / total) * 100)}%`);
          nextLog += 0.1;
        }
      }
    } finally {
      await fh.close();
    }
    return finish(part, dest, hash.digest('hex'), expected, label);
  }
  // 416: the partial file already holds every byte; verify it as it is.
  return finish(part, dest, await sha256OfFile(part), expected, label);
}

function finish(part: string, dest: string, digest: string, expected: { sha256: string; size?: number }, label: string): void {
  const size = sizeOf(part);
  if (digest !== expected.sha256 || (expected.size !== undefined && size !== expected.size)) {
    rmSync(part, { force: true });
    throw new Vid2ContextError(
      'upstream',
      `Checksum mismatch for ${label}: expected sha256 ${expected.sha256}, got ${digest} (${size} bytes).`,
      {
        hint: 'The partial file was deleted. Run setup again to download it fresh.',
      },
    );
  }
  renameSync(part, dest);
}

export interface DownloadedModel {
  name: string;
  path: string;
  sizeBytes: number;
  sha256?: string;
  /** True when a verified file was already in place. */
  reused: boolean;
}

/** Download a catalog model into .vid2context/models/whisper/, verified, resumable and locked. */
export async function downloadModel(name: string, ctx: Ctx, opts: { force?: boolean } = {}): Promise<DownloadedModel> {
  const resolved = resolveModel(name, ctx.env);
  if (looksLikePath(name)) {
    if (!isFile(resolved.path)) {
      throw new Vid2ContextError('not-found', `Model file not found: ${resolved.path}`, {
        hint: 'Check the path, or pass a catalog name to download one.',
      });
    }
    return { name: resolved.name, path: resolved.path, sizeBytes: sizeOf(resolved.path), reused: true };
  }
  if (!resolved.known) {
    throw new Vid2ContextError('bad-request', `Unknown whisper.cpp model: ${name}`, {
      hint: `Pick one of: ${MODEL_NAMES.join(', ')}.`,
    });
  }
  const file = modelFileName(resolved.name);
  mkdirSync(modelsDir(ctx.env), { recursive: true });
  return withLock(
    ctx.env,
    `whisper-model-${resolved.name}`,
    async () => {
      let index: Map<string, ModelIndexEntry> | null = null;
      try {
        index = await fetchModelIndex(ctx);
      } catch (err) {
        if (isFile(resolved.path) && !opts.force) {
          ctx.log.warn('could not reach Hugging Face; using the model already on disk', { model: resolved.name });
          return { name: resolved.name, path: resolved.path, sizeBytes: sizeOf(resolved.path), reused: true };
        }
        throw err;
      }
      const entry = index.get(file);
      if (!entry) {
        throw new Vid2ContextError('not-found', `${file} is not in ${HF_REPO} any more.`, {
          hint: 'Pick another model name, or download a ggml file and set WHISPER_CPP_MODEL to its path.',
        });
      }
      if (!opts.force && isFile(resolved.path) && sizeOf(resolved.path) === entry.size) {
        return { name: resolved.name, path: resolved.path, sizeBytes: entry.size, sha256: entry.sha256, reused: true };
      }
      if (opts.force) rmSync(resolved.path, { force: true });
      const url = `${HF_BASE}/${HF_REPO}/resolve/main/${file}`;
      ctx.log.info(`downloading ${file} (${Math.round(entry.size / 1e6)} MB) from Hugging Face`);
      await downloadVerified(url, resolved.path, entry, ctx, file);
      return { name: resolved.name, path: resolved.path, sizeBytes: entry.size, sha256: entry.sha256, reused: false };
    },
    { signal: ctx.signal, onWait: () => ctx.log.info(`waiting for another process downloading ${file}`) },
  );
}

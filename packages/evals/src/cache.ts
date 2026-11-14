/**
 * On-disk cache for evaluation runs: downloaded audio and references fetched
 * without `--record`. Lives under `<data dir>/cache/evals/`, where the data
 * dir is VID2CONTEXT_HOME or `.vid2context` in the working directory
 * (SHARED-CONTRACTS section 9). Reruns read from here, so each video's audio
 * is downloaded once.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { AudioInput, Env } from '@vid2context/core';

export type AudioBytes = Extract<AudioInput, { kind: 'bytes' }>;

export function evalsCacheDir(env: Env, cwd: string = process.cwd()): string {
  const home = env.VID2CONTEXT_HOME ? resolve(cwd, env.VID2CONTEXT_HOME) : resolve(cwd, '.vid2context');
  return join(home, 'cache', 'evals');
}

interface AudioMeta {
  mimeType: string;
  filename: string;
  durationSec?: number;
  source: string;
}

const safe = (videoId: string): string => videoId.replace(/[^A-Za-z0-9_.-]/g, '-');

export function readCachedAudio(dir: string, videoId: string): (AudioBytes & { source: string }) | null {
  const base = join(dir, 'audio', safe(videoId));
  if (!existsSync(`${base}.json`) || !existsSync(`${base}.bin`)) return null;
  const meta = JSON.parse(readFileSync(`${base}.json`, 'utf8')) as AudioMeta;
  return { kind: 'bytes', data: new Uint8Array(readFileSync(`${base}.bin`)), ...meta };
}

export function writeCachedAudio(dir: string, videoId: string, audio: AudioBytes, source: string): void {
  mkdirSync(join(dir, 'audio'), { recursive: true });
  const base = join(dir, 'audio', safe(videoId));
  writeFileSync(`${base}.bin`, audio.data);
  const meta: AudioMeta = { mimeType: audio.mimeType, filename: audio.filename, durationSec: audio.durationSec, source };
  writeFileSync(`${base}.json`, `${JSON.stringify(meta, null, 2)}\n`);
}

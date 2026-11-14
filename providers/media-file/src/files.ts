/**
 * File helpers shared by the media-file source and captions providers:
 * path matching, the ref id and ffprobe when it is installed.
 */
import { createHash } from 'node:crypto';
import { statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, extname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { type Ctx, Vid2ContextError, type VideoRef } from '@vid2context/core';
import { type ProbeResult, probe, tryLocateFfmpeg } from '@vid2context/ffmpeg';

export const MIME_BY_EXT: Record<string, string> = {
  '.mp3': 'audio/mpeg',
  '.mpga': 'audio/mpeg',
  '.mpeg': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.wav': 'audio/wav',
  '.flac': 'audio/flac',
  '.ogg': 'audio/ogg',
  '.oga': 'audio/ogg',
  '.opus': 'audio/opus',
  '.weba': 'audio/webm',
  '.webm': 'video/webm',
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.mov': 'video/quicktime',
  '.mkv': 'video/x-matroska',
  '.avi': 'video/x-msvideo',
};

/** Audio formats speech-to-text endpoints accept directly (OpenAI, Groq, OVH). */
export const STT_READY_EXT = new Set(['.mp3', '.mpga', '.mpeg', '.m4a', '.wav', '.flac', '.ogg', '.oga', '.opus', '.weba']);

/** Audio files up to this size go to speech-to-text untouched: the common 25 MB upload limit. */
export const PASSTHROUGH_MAX_BYTES = 25 * 1024 * 1024;

function toPath(input: string): string | null {
  if (/^file:\/\//i.test(input)) {
    try {
      return fileURLToPath(input);
    } catch {
      return null;
    }
  }
  if (input.startsWith('~/')) return resolve(homedir(), input.slice(2));
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(input)) return null;
  const pathLike = isAbsolute(input) || /^\.{1,2}[\\/]/.test(input) || /^[a-z]:[\\/]/i.test(input);
  const hasMediaExt = extname(input).toLowerCase() in MIME_BY_EXT;
  if (!pathLike && !hasMediaExt) return null;
  return resolve(input);
}

function fileStat(path: string): { size: number; mtimeMs: number } | null {
  try {
    const st = statSync(path);
    return st.isFile() ? { size: st.size, mtimeMs: st.mtimeMs } : null;
  } catch {
    return null;
  }
}

export function fileId(path: string, size: number, mtimeMs: number): string {
  return createHash('sha256').update(`${path}\n${size}\n${mtimeMs}`).digest('hex').slice(0, 32);
}

/** Recognise a local media file. Synchronous; touches only the filesystem. */
export function matchFile(raw: string): VideoRef | null {
  const input = raw.trim();
  const path = toPath(input);
  if (!path) return null;
  const st = fileStat(path);
  const hasMediaExt = extname(path).toLowerCase() in MIME_BY_EXT;
  if (!st && !hasMediaExt) return null;
  const nativeId = st ? fileId(path, st.size, st.mtimeMs) : fileId(path, -1, -1);
  return { input, platform: 'file', kind: 'video', id: `file:${nativeId}`, nativeId, url: pathToFileURL(path).href };
}

/** Absolute path of a file ref; throws not-found when the file is gone. */
export function pathOf(ref: VideoRef): string {
  if (!ref.url) throw new Vid2ContextError('bad-request', `File ref ${ref.id} has no path.`);
  const path = fileURLToPath(ref.url);
  if (!fileStat(path)) {
    throw new Vid2ContextError('not-found', `File not found: ${path}`, {
      hint: 'Check the path; relative paths resolve from the current directory.',
    });
  }
  return path;
}

/** ffprobe a file when ffmpeg is installed (never downloads); null when it is missing or the probe fails. */
export async function probeIfAvailable(path: string, ctx: Ctx): Promise<ProbeResult | null> {
  if (!(await tryLocateFfmpeg(ctx))) return null;
  try {
    return await probe(path, ctx);
  } catch (err) {
    ctx.log.warn('ffprobe failed; using filesystem metadata', { path, error: err instanceof Error ? err.message : String(err) });
    return null;
  }
}

export function isoDate(tag: string | undefined): string | undefined {
  return /^\d{4}(-\d{2}(-\d{2})?)?/.exec(tag?.trim() ?? '')?.[0];
}

export function stemOf(path: string): string {
  const name = basename(path);
  return name.slice(0, name.length - extname(name).length) || name;
}

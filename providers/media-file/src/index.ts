/**
 * Local media files. Node only (reads the filesystem).
 *
 * Matches absolute and relative paths, ~/ paths and file:// URLs. A bare name
 * only matches when it has a media extension, so it never shadows a YouTube
 * id. The ref id is a sha256 of the absolute path, size and mtime, so editing
 * or replacing the file produces a new id and never serves a stale cache.
 */
import { createHash } from 'node:crypto';
import { statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, extname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { defineProvider, type SourceProvider, Vid2ContextError, type VideoRef } from '@vid2context/core';

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

function pathOf(ref: VideoRef): string {
  if (!ref.url) throw new Vid2ContextError('bad-request', `File ref ${ref.id} has no path.`);
  const path = fileURLToPath(ref.url);
  if (!fileStat(path)) {
    throw new Vid2ContextError('not-found', `File not found: ${path}`, {
      hint: 'Check the path; relative paths resolve from the current directory.',
    });
  }
  return path;
}

export const mediaFile: SourceProvider = defineProvider({
  id: 'media-file',
  kind: 'source',
  name: 'Local media file',
  runtimes: ['node'],
  match: matchFile,
  async getMetadata(ref) {
    const path = pathOf(ref);
    const st = statSync(path);
    const name = basename(path);
    return {
      ref,
      title: name.slice(0, name.length - extname(name).length) || name,
      chapters: [],
      extra: { path, sizeBytes: st.size, modifiedAt: st.mtime.toISOString() },
    };
  },
  canProvideAudio: (ref) => ref.platform === 'file',
  async getAudio(ref) {
    const path = pathOf(ref);
    const data = new Uint8Array(await readFile(path));
    return {
      kind: 'bytes',
      data,
      mimeType: MIME_BY_EXT[extname(path).toLowerCase()] ?? 'application/octet-stream',
      filename: basename(path),
    };
  },
});

export default mediaFile;

/**
 * File names and moves for finished downloads. Names come from the video
 * title, made safe for every filesystem with core's safeFilename; existing
 * files are never replaced unless asked.
 */
import { constants } from 'node:fs';
import { access, copyFile, mkdir, rename, rm } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { safeFilename } from '@vid2context/core';

/** "1m05s", "1h02m03s": readable in a file name and safe on Windows (no colons). */
export function stamp(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = String(s % 60).padStart(2, '0');
  return h > 0 ? `${h}h${String(m).padStart(2, '0')}m${r}s` : `${m}m${r}s`;
}

export interface NameParts {
  title: string;
  /** The site's id, added as " [id]" like yt-dlp does, so two videos with one title do not collide. */
  id?: string;
  ext: string;
  section?: { fromSec: number; toSec?: number; chapter?: string };
}

export function outputName(parts: NameParts): string {
  let stem = parts.title.trim() || 'video';
  if (parts.section?.chapter) stem += ` - ${parts.section.chapter}`;
  else if (parts.section) {
    stem += ` (${stamp(parts.section.fromSec)}-${parts.section.toSec === undefined ? 'end' : stamp(parts.section.toSec)})`;
  }
  const id = parts.id && !stem.includes(parts.id) ? ` [${parts.id}]` : '';
  // Keep room for the id and extension inside a 180-character name.
  const safeStem = safeFilename(stem, 180 - id.length - parts.ext.length - 1);
  return `${safeStem}${id}.${parts.ext}`;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

/** "name.mp4", then "name (2).mp4", "name (3).mp4", ... */
export async function freeName(dir: string, name: string): Promise<string> {
  if (!(await exists(join(dir, name)))) return name;
  const ext = extname(name);
  const stem = name.slice(0, name.length - ext.length);
  for (let i = 2; i < 10_000; i++) {
    const candidate = `${stem} (${i})${ext}`;
    if (!(await exists(join(dir, candidate)))) return candidate;
  }
  return `${stem} (${Date.now()})${ext}`;
}

/** Move a file into `dir` under `name`; copies when the temp dir is on another device. Returns the final path. */
export async function moveInto(src: string, dir: string, name: string, overwrite = false): Promise<string> {
  await mkdir(dir, { recursive: true });
  const finalName = overwrite ? name : await freeName(dir, name);
  const dest = join(dir, finalName);
  try {
    await rename(src, dest);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err;
    await copyFile(src, dest);
    await rm(src, { force: true });
  }
  return dest;
}

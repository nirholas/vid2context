/**
 * Disk-space preflight: refuse a download before it starts when the folders
 * it writes to cannot hold the estimated file plus the configured headroom
 * (VID2CONTEXT_DOWNLOAD_MIN_FREE_MB). A full disk mid-download leaves a
 * broken file and can take the rest of the machine down with it.
 */
import { mkdir, statfs } from 'node:fs/promises';
import { dirname } from 'node:path';
import { Vid2ContextError } from '@vid2context/core';
import { mb } from '../summary.ts';

/** Free bytes for unprivileged users on the filesystem holding `dir` (or its nearest existing parent). */
export async function freeBytes(dir: string): Promise<number | undefined> {
  let p = dir;
  for (let i = 0; i < 64; i++) {
    try {
      const s = await statfs(p);
      return Number(s.bavail) * Number(s.bsize);
    } catch {
      const up = dirname(p);
      if (up === p) return undefined;
      p = up;
    }
  }
  return undefined;
}

export interface DiskNeed {
  /** Folder written to. */
  dir: string;
  /** Bytes the download needs there. */
  bytes: number;
  /** What the folder is, for the message: "the download folder", "the temp folder". */
  label: string;
}

/**
 * Throw `too-large` when any folder lacks `bytes + minFreeMb`. Needs on the
 * same filesystem are added up. Folders whose free space cannot be read pass.
 */
export async function preflightDisk(needs: DiskNeed[], minFreeMb: number): Promise<void> {
  const byDevice = new Map<number, { free: number; bytes: number; labels: string[] }>();
  for (const need of needs) {
    if (!(need.bytes > 0)) continue;
    await mkdir(need.dir, { recursive: true }).catch(() => undefined);
    const free = await freeBytes(need.dir);
    if (free === undefined) continue;
    // statfs gives no device id; equal free counts read at the same moment mean the same filesystem.
    const key = free;
    const entry = byDevice.get(key) ?? { free, bytes: 0, labels: [] };
    entry.bytes += need.bytes;
    entry.labels.push(need.label);
    byDevice.set(key, entry);
  }
  const headroom = minFreeMb * 1048576;
  for (const e of byDevice.values()) {
    if (e.free < e.bytes + headroom) {
      throw new Vid2ContextError(
        'too-large',
        `Not enough disk space: ${e.labels.join(' and ')} need about ${mb(e.bytes)} plus ${mb(headroom)} headroom, and ${mb(e.free)} is free.`,
        {
          hint: 'Free some space, pick a lower quality or a shorter part, save to another disk (--dir), or lower VID2CONTEXT_DOWNLOAD_MIN_FREE_MB.',
        },
      );
    }
  }
}

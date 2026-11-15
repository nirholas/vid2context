/**
 * Saving small results (caption files, frame grabs): one piece is written as
 * itself, several become one .zip (core's zip writer, deflated). Names never
 * replace an existing file unless asked.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { zipToBytes } from '@vid2context/core';
import { freeName } from './files.ts';

export interface Piece {
  /** File name, also its name inside a .zip. */
  name: string;
  data: Uint8Array;
  mimeType: string;
}

export interface Saved {
  path: string;
  filename: string;
  bytes: number;
  mimeType: string;
  /** Extension of what was written. */
  format: string;
  entries?: { name: string; bytes: number }[];
}

export async function savePieces(
  pieces: Piece[],
  opts: { dir: string; overwrite?: boolean; zipName: string; forceZip?: boolean },
): Promise<Saved> {
  await mkdir(opts.dir, { recursive: true });
  const single = pieces.length === 1 && !opts.forceZip ? pieces[0] : undefined;
  if (single) {
    const name = opts.overwrite ? single.name : await freeName(opts.dir, single.name);
    const path = join(opts.dir, name);
    await writeFile(path, single.data);
    return {
      path,
      filename: name,
      bytes: single.data.length,
      mimeType: single.mimeType,
      format: name.split('.').pop() ?? '',
    };
  }
  // Two pieces with one name (two tracks in one language) get " (2)" inside the archive.
  const seen = new Set<string>();
  const entries = pieces.map((p) => {
    let name = p.name;
    for (let i = 2; seen.has(name); i++) name = p.name.replace(/(\.[^.]+)?$/, (ext) => ` (${i})${ext}`);
    seen.add(name);
    return { path: name, data: p.data };
  });
  const data = await zipToBytes(entries);
  const name = opts.overwrite ? opts.zipName : await freeName(opts.dir, opts.zipName);
  const path = join(opts.dir, name);
  await writeFile(path, data);
  return {
    path,
    filename: name,
    bytes: data.length,
    mimeType: 'application/zip',
    format: 'zip',
    entries: entries.map((e) => ({ name: e.path, bytes: e.data.length })),
  };
}

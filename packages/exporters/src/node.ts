/**
 * Node writer for Obsidian exports. The only file in this package that touches
 * the filesystem. Safety rules:
 *
 * - Every path is resolved against the vault and must stay inside it: absolute
 *   paths, `..` segments, hidden segments (`.obsidian/`, `.git/`) and symlinks
 *   that lead outside the vault are refused.
 * - A note that already exists is replaced only when its `vid2context-id`
 *   property matches the new note's (vid2context wrote it for the same video
 *   or collection). Any other existing note, including the user's own notes
 *   without that property, is left alone unless `overwrite: true`.
 * - Every check runs before the first write, so a refused export writes nothing.
 */
import { lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { Vid2ContextError } from '@vid2context/core';
import { noteId, type ObsidianFile } from './obsidian.ts';

export interface WriteObsidianOptions {
  /** Replace existing notes even when their `vid2context-id` differs or is missing. Default false. */
  overwrite?: boolean;
}

export interface WrittenNote {
  /** Absolute path on disk. */
  path: string;
  status: 'created' | 'updated';
}

function refuse(message: string, hint: string): Vid2ContextError {
  return new Vid2ContextError('bad-request', message, { hint });
}

function inside(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel !== '' && !rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel);
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}

/** realpath of the nearest existing ancestor (or the path itself), so symlinked folders are followed before writing. */
async function nearestReal(path: string): Promise<string> {
  let current = path;
  for (;;) {
    try {
      return await realpath(current);
    } catch {
      const parent = dirname(current);
      if (parent === current) return current;
      current = parent;
    }
  }
}

function checkRelative(path: string): void {
  if (typeof path !== 'string' || path.length === 0 || path.includes('\u0000')) {
    throw refuse('An export file has an empty or invalid path.', 'Render the files with renderObsidian and pass them unchanged.');
  }
  if (isAbsolute(path) || /^[a-zA-Z]:/.test(path) || path.startsWith('/') || path.startsWith('\\')) {
    throw refuse(`Refusing to write an absolute path: ${path}`, 'Export file paths must be relative to the vault folder.');
  }
  const segments = path.split(/[/\\]+/);
  if (segments.some((s) => s === '..' || s === '.' || s.startsWith('.'))) {
    throw refuse(
      `Refusing to write outside the vault or into a hidden folder: ${path}`,
      'Paths may not contain ".." or segments that start with a dot (such as .obsidian).',
    );
  }
  if (!path.toLowerCase().endsWith('.md')) {
    throw refuse(`Refusing to write a non-note file: ${path}`, 'The Obsidian writer only writes Markdown notes (.md).');
  }
}

/** Write rendered notes into `vaultPath` (created if missing). Returns what was written, in input order. */
export async function writeObsidian(
  files: ObsidianFile[],
  vaultPath: string,
  opts: WriteObsidianOptions = {},
): Promise<WrittenNote[]> {
  if (!vaultPath)
    throw refuse('No vault path given.', 'Pass the folder of your Obsidian vault (or any folder to write notes into).');
  await mkdir(resolve(vaultPath), { recursive: true });
  const vault = await realpath(resolve(vaultPath));

  const plan: { target: string; content: string; status: WrittenNote['status'] }[] = [];
  const seen = new Set<string>();
  const conflicts: string[] = [];
  for (const file of files) {
    checkRelative(file.path);
    const target = resolve(vault, file.path);
    if (!inside(vault, target)) {
      throw refuse(`Refusing to write outside the vault: ${file.path}`, 'Export file paths must stay inside the vault folder.');
    }
    const key = target.toLowerCase();
    if (seen.has(key))
      throw refuse(
        `Two export files map to the same note: ${file.path}`,
        'Render the files with renderObsidian, which dedupes names.',
      );
    seen.add(key);
    const realParent = await nearestReal(dirname(target));
    if (realParent !== vault && !inside(vault, realParent)) {
      throw refuse(
        `Refusing to write through a link that leaves the vault: ${file.path}`,
        'Remove the symlink or choose another folder.',
      );
    }
    let status: WrittenNote['status'] = 'created';
    if (await exists(target)) {
      const info = await lstat(target);
      if (info.isSymbolicLink() || !info.isFile()) {
        throw refuse(
          `Refusing to replace something that is not a plain note: ${file.path}`,
          'Move it away or choose another folder.',
        );
      }
      const current = noteId(await readFile(target, 'utf8'));
      const next = noteId(file.content);
      if ((current === undefined || current !== next) && !opts.overwrite) conflicts.push(file.path);
      status = 'updated';
    }
    plan.push({ target, content: file.content, status });
  }
  if (conflicts.length > 0) {
    throw new Vid2ContextError(
      'bad-request',
      `These notes already exist and were not written by vid2context for the same video: ${conflicts.join(', ')}`,
      { hint: 'Nothing was written. Choose another folder, move those notes, or pass overwrite: true to replace them.' },
    );
  }

  const written: WrittenNote[] = [];
  for (const item of plan) {
    const dir = dirname(item.target);
    await mkdir(dir, { recursive: true });
    const realDir = await realpath(dir);
    if (realDir !== vault && !inside(vault, realDir)) {
      throw refuse(
        `Refusing to write through a link that leaves the vault: ${item.target}`,
        'Remove the symlink or choose another folder.',
      );
    }
    await writeFile(item.target, item.content, 'utf8');
    written.push({ path: item.target, status: item.status });
  }
  return written;
}

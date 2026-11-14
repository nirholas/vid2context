/**
 * The repo root, found by walking up from the working directory, so the build
 * works whether Astro runs from site/ (npm --prefix site) or from the root.
 */
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

function findRoot(): string {
  let dir = resolve(process.cwd());
  for (;;) {
    if (existsSync(join(dir, 'AGENTS.md')) && existsSync(join(dir, 'packages')) && existsSync(join(dir, 'site'))) return dir;
    const up = dirname(dir);
    if (up === dir) throw new Error(`Could not find the vid2context repo root above ${process.cwd()}.`);
    dir = up;
  }
}

export const REPO_ROOT = findRoot();
export const repoPath = (...parts: string[]) => join(REPO_ROOT, ...parts);

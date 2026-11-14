// Builds the n8n package the way the n8n starter lays it out: TypeScript from
// src/ compiled to CommonJS in dist/ (n8n loads community nodes with require),
// plus the icons and other static files next to the compiled nodes.
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, readdirSync, rmSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = join(root, 'src');
const dist = join(root, 'dist');

// TypeScript is installed once at the workspace root; look upwards for it.
function findTsc(dir) {
  const candidate = join(dir, 'node_modules', 'typescript', 'bin', 'tsc');
  if (existsSync(candidate)) return candidate;
  const parent = dirname(dir);
  if (parent === dir) throw new Error('TypeScript not found: run npm install at the repository root first.');
  return findTsc(parent);
}

rmSync(dist, { recursive: true, force: true });
execFileSync(process.execPath, [findTsc(root), '-p', join(root, 'tsconfig.build.json')], { stdio: 'inherit' });

function copyStatic(dir) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) copyStatic(path);
    else if (/\.(svg|png|json)$/.test(name)) cpSync(path, join(dist, relative(src, path)));
  }
}
copyStatic(src);
console.error(`built ${relative(process.cwd(), dist) || 'dist'}`);

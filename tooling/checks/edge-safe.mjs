/**
 * edge-safe: code that runs on Cloudflare Workers or in the browser must not
 * import Node built-ins.
 *
 * - `packages/core/src` stays runtime-neutral, so every file there is checked.
 * - For each provider declaring the `workers` or `browser` runtime, the check
 *   follows what actually ships to those runtimes: it starts at the package's
 *   edge entry points and walks relative imports. Entry points are the
 *   targets of `workerd`, `worker`, `workers`, `browser` and `edge-light`
 *   conditions, plus plain exports with no conditions. Targets of `node` and
 *   `default` next to an edge condition, and subpaths named `./node`, are the
 *   package's Node build and are not walked.
 *
 * Type-only imports are erased at build time and pass.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { dirname, join, normalize } from 'node:path';
import { CODE_EXT, cli, isMain, position, ROOT, stripCode } from './lib.mjs';

const EDGE_RUNTIMES = ['workers', 'browser'];
const EDGE_CONDITIONS = new Set(['workers', 'worker', 'workerd', 'browser', 'edge-light']);
const BUILTINS = new Set(builtinModules.filter((m) => !m.startsWith('_')).map((m) => m.split('/')[0]));

const IMPORT_SPECIFIER = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\brequire\s*\(\s*)(['"])([^'"\n]+)\1/g;
/** True when the import or export statement that ends at `index` is type-only. */
function typeOnly(code, index) {
  const start = Math.max(code.lastIndexOf('import', index), code.lastIndexOf('export', index));
  return start !== -1 && /^(?:import|export)\s+type\b/.test(code.slice(start, index));
}

/** Package-relative entry files that ship to edge runtimes, from an `exports` field. */
export function edgeEntries(exportsField) {
  const out = new Set();
  const add = (target) => {
    if (typeof target === 'string' && CODE_EXT.test(target)) out.add(normalize(target));
  };
  const visit = (entry, subpath) => {
    if (/^\.\/node(?:\/|$)/.test(subpath)) return;
    if (typeof entry === 'string') return add(entry);
    if (!entry || typeof entry !== 'object') return;
    const keys = Object.keys(entry);
    if (keys.every((k) => k.startsWith('.'))) {
      for (const k of keys) visit(entry[k], k);
      return;
    }
    if (keys.some((k) => EDGE_CONDITIONS.has(k))) {
      for (const k of keys) if (EDGE_CONDITIONS.has(k)) visit(entry[k], subpath);
    } else {
      for (const k of keys) if (k !== 'node' && k !== 'types') visit(entry[k], subpath);
    }
  };
  visit(exportsField ?? './src/index.ts', '.');
  return out;
}

/** Relative specifiers a file imports or re-exports, type-only ones excluded. */
export function relativeImports(text) {
  const code = stripCode(text);
  const out = [];
  for (const m of code.matchAll(IMPORT_SPECIFIER)) {
    if (!m[2].startsWith('.')) continue;
    if (typeOnly(code, m.index)) continue;
    out.push(m[2]);
  }
  return out;
}

function resolveFile(root, fromRel, spec) {
  const base = normalize(join(dirname(fromRel), spec));
  for (const candidate of [base, `${base}.ts`, base.replace(/\.js$/, '.ts'), join(base, 'index.ts')]) {
    if (CODE_EXT.test(candidate) && existsSync(join(root, candidate))) return candidate;
  }
  return null;
}

/** Repo-relative files reachable from `entries` through relative imports. */
export function reachable(root, entries) {
  const seen = new Set();
  const queue = [...entries];
  while (queue.length) {
    const file = queue.pop();
    if (seen.has(file) || !existsSync(join(root, file))) continue;
    seen.add(file);
    for (const spec of relativeImports(readFileSync(join(root, file), 'utf8'))) {
      const next = resolveFile(root, file, spec);
      if (next && !seen.has(next)) queue.push(next);
    }
  }
  return seen;
}

/** What the check covers: whole directories (core) and the edge-reachable provider files. */
export function scope(root = ROOT) {
  const dirs = ['packages/core/src/'];
  const files = new Set();
  const providers = join(root, 'providers');
  for (const dir of existsSync(providers) ? readdirSync(providers) : []) {
    let pkg;
    try {
      pkg = JSON.parse(readFileSync(join(providers, dir, 'package.json'), 'utf8'));
    } catch {
      continue;
    }
    const runtimes = pkg.vid2context?.runtimes ?? [];
    if (!runtimes.some((r) => EDGE_RUNTIMES.includes(r))) continue;
    const entries = [...edgeEntries(pkg.exports)].map((f) => join('providers', dir, f));
    for (const f of reachable(root, entries)) files.add(f);
  }
  return { dirs, files };
}

export function isBuiltin(specifier) {
  if (specifier.startsWith('node:')) return true;
  return BUILTINS.has(specifier.split('/')[0]);
}

let cached;
const current = () => {
  cached ??= scope();
  return cached;
};

export const name = 'edge-safe';
export const description = 'no Node built-ins in core or in code that ships to Workers and browsers';

export function select(path, { dirs, files } = current()) {
  return CODE_EXT.test(path) && (dirs.some((d) => path.startsWith(d)) || files.has(path));
}

export function check(_path, text) {
  const code = stripCode(text);
  const out = [];
  for (const m of code.matchAll(IMPORT_SPECIFIER)) {
    const spec = m[2];
    if (!isBuiltin(spec)) continue;
    if (typeOnly(code, m.index)) continue;
    out.push({
      ...position(code, m.index),
      message: `imports Node built-in "${spec}" in code that ships to Workers or browsers: take it through ctx, or move it behind a node export condition`,
    });
  }
  return out;
}

if (isMain(import.meta.url)) process.exitCode = cli([{ name, description, select, check }]);

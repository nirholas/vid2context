/**
 * edge-safe: `packages/core/src` and every provider that declares the
 * `workers` or `browser` runtime must not import Node built-ins, so they run
 * on Cloudflare Workers and in the browser. A file that package.json maps only
 * to a Node condition (for example `"default": "./src/node.ts"` next to a
 * `"browser"` condition) is the Node build of the package and is exempt.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { join } from 'node:path';
import { CODE_EXT, cli, isMain, position, ROOT, stripCode } from './lib.mjs';

const EDGE_RUNTIMES = ['workers', 'browser'];
const EDGE_CONDITIONS = new Set(['workers', 'worker', 'workerd', 'browser', 'edge-light']);
const NODE_CONDITIONS = new Set(['node', 'default', 'import']);
const BUILTINS = new Set(builtinModules.filter((m) => !m.startsWith('_')).map((m) => m.split('/')[0]));

/** Files that only a Node export condition points at, when the same entry also has an edge condition. */
export function nodeOnlyFiles(exportsField) {
  const out = new Set();
  const visit = (entry) => {
    if (!entry || typeof entry !== 'object') return;
    const keys = Object.keys(entry);
    if (keys.some((k) => EDGE_CONDITIONS.has(k))) {
      for (const k of keys) if (NODE_CONDITIONS.has(k) && typeof entry[k] === 'string') out.add(entry[k].replace(/^\.\//, ''));
    }
    for (const v of Object.values(entry)) visit(v);
  };
  visit(exportsField);
  return out;
}

/** Repo-relative directory prefixes in scope, and the exempt Node-only files. */
export function scope(root = ROOT) {
  const dirs = ['packages/core/src/'];
  const exempt = new Set();
  for (const dir of readdirSync(join(root, 'providers'))) {
    let pkg;
    try {
      pkg = JSON.parse(readFileSync(join(root, 'providers', dir, 'package.json'), 'utf8'));
    } catch {
      continue;
    }
    const runtimes = pkg.vid2context?.runtimes ?? [];
    if (!runtimes.some((r) => EDGE_RUNTIMES.includes(r))) continue;
    dirs.push(`providers/${dir}/src/`);
    for (const f of nodeOnlyFiles(pkg.exports)) exempt.add(`providers/${dir}/${f}`);
  }
  return { dirs, exempt };
}

const IMPORT_SPECIFIER =
  /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\brequire\s*\(\s*|\bexport\s+\*\s+from\s*)(['"])([^'"\n]+)\1/g;

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
export const description = 'no Node built-ins in core or edge providers';

export function select(path, { dirs, exempt } = current()) {
  return CODE_EXT.test(path) && dirs.some((d) => path.startsWith(d)) && !exempt.has(path);
}

export function check(_path, text) {
  const code = stripCode(text);
  const out = [];
  for (const m of code.matchAll(IMPORT_SPECIFIER)) {
    const spec = m[2];
    if (!isBuiltin(spec)) continue;
    const at = position(code, m.index);
    out.push({
      line: at.line,
      column: at.column,
      message: `imports Node built-in "${spec}": take it through ctx, or move it to a Node-only entry`,
    });
  }
  return out;
}

if (isMain(import.meta.url)) process.exitCode = cli([{ name, description, select, check }]);

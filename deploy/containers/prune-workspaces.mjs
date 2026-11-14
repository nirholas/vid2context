#!/usr/bin/env node
/**
 * Build helper for deploy/containers/Dockerfile. Copies only what the HTTP
 * server needs out of the monorepo:
 *
 *   node prune-workspaces.mjs <repo> <out>
 *
 * Kept workspaces: @vid2context/server, every provider that declares the
 * "node" runtime (the node registry imports all of them), and every
 * workspace those depend on. Everything else (CLI, web app, site, other
 * packages) stays out of the image.
 *
 * Writes two trees so Docker can cache the dependency install:
 *   <out>/manifests  root package.json (workspaces narrowed to the kept list),
 *                    package-lock.json and each kept workspace's package.json
 *   <out>/app        the same plus each kept workspace's files (tests and
 *                    fixtures left out), scripts/gen-registry.mjs and the
 *                    license files
 */
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

const [repo, out] = process.argv.slice(2);
if (!repo || !out) {
  console.error('usage: node prune-workspaces.mjs <repo> <out>');
  process.exit(2);
}

const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));

/** Workspace package name -> { dir, pkg } for packages/* and providers/*. */
const workspaces = new Map();
for (const group of ['packages', 'providers']) {
  const groupDir = join(repo, group);
  if (!existsSync(groupDir)) continue;
  for (const name of readdirSync(groupDir).sort()) {
    const manifest = join(groupDir, name, 'package.json');
    if (!existsSync(manifest)) continue;
    const pkg = readJson(manifest);
    workspaces.set(pkg.name, { dir: `${group}/${name}`, pkg });
  }
}

const keep = new Set();
function visit(name) {
  const ws = workspaces.get(name);
  if (!ws || keep.has(ws.dir)) return;
  keep.add(ws.dir);
  const deps = { ...ws.pkg.dependencies, ...ws.pkg.optionalDependencies, ...ws.pkg.peerDependencies };
  for (const dep of Object.keys(deps)) visit(dep);
}

if (!workspaces.has('@vid2context/server')) {
  console.error('prune-workspaces: packages/server/package.json was not found in the build context.');
  process.exit(1);
}
visit('@vid2context/server');
for (const [name, ws] of workspaces) {
  if (ws.dir.startsWith('providers/') && ws.pkg.vid2context?.runtimes?.includes('node')) visit(name);
}
const kept = [...keep].sort();

const rootPkg = readJson(join(repo, 'package.json'));
rootPkg.workspaces = kept;
// The server runs through tsx (Node's own type stripping rejects syntax the
// code uses, such as constructor parameter properties). tsx is a root
// devDependency, so move it, with its locked range, into dependencies where
// `npm ci --omit=dev` installs the version from package-lock.json. The other
// dev tools stay out.
const tsx = rootPkg.devDependencies?.tsx;
if (!tsx) {
  console.error('prune-workspaces: the root package.json has no tsx devDependency to run the server with.');
  process.exit(1);
}
rootPkg.dependencies = { ...rootPkg.dependencies, tsx };
delete rootPkg.devDependencies;

/** Test code and recorded fixtures are not needed at runtime. */
const SKIP = new Set(['test', 'tests', 'node_modules', 'dist', 'coverage']);
const copyTree = (from, to) =>
  cpSync(from, to, {
    recursive: true,
    filter: (src) => !SKIP.has(basename(src)) && !/\.test\.[cm]?[jt]s$/.test(src),
  });

for (const tree of ['manifests', 'app']) {
  const base = join(out, tree);
  mkdirSync(base, { recursive: true });
  writeFileSync(join(base, 'package.json'), `${JSON.stringify(rootPkg, null, 2)}\n`);
  cpSync(join(repo, 'package-lock.json'), join(base, 'package-lock.json'));
  for (const dir of kept) {
    mkdirSync(join(base, dir), { recursive: true });
    if (tree === 'manifests') cpSync(join(repo, dir, 'package.json'), join(base, dir, 'package.json'));
    else copyTree(join(repo, dir), join(base, dir));
  }
}

const app = join(out, 'app');
// Some packages read another package's manifest by relative path (for
// example discovery imports ../../cli/package.json for version numbers)
// without depending on it. Manifests are tiny, so ship every package's
// package.json even when its code stays out. Providers are left out: the
// registry generator scans providers/*/package.json, and every provider the
// node registry needs is already kept.
for (const [, ws] of workspaces) {
  if (keep.has(ws.dir) || !ws.dir.startsWith('packages/')) continue;
  mkdirSync(join(app, ws.dir), { recursive: true });
  cpSync(join(repo, ws.dir, 'package.json'), join(app, ws.dir, 'package.json'));
}

for (const file of ['scripts/gen-registry.mjs', 'LICENSE', 'THIRD_PARTY_NOTICES.md']) {
  if (!existsSync(join(repo, file))) continue;
  mkdirSync(dirname(join(app, file)), { recursive: true });
  cpSync(join(repo, file), join(app, file));
}

console.error(`prune-workspaces: kept ${kept.length} workspaces: ${kept.join(', ')}`);

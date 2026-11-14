/**
 * Builds the publishable npm packages. The workspace packages export raw
 * TypeScript, which npx cannot run, so each bin is bundled with esbuild into
 * one ESM file with no runtime dependencies. The source packages stay as
 * they are; this only reads their entry points.
 */
import { chmodSync, copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { npmReadme } from './manifests.ts';
import { GITHUB_OWNER, KEYWORDS, LICENSE, type PublishedPackage, PACKAGES, REPO_GIT_URL, REPO_URL, SITE_URL } from './meta.ts';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
export const NPM_OUT = join(ROOT, 'packages/discovery/dist/npm');

const SHEBANG = '#!/usr/bin/env node\n';
// Bundled CommonJS dependencies call require(); ESM output has no require, so give it one.
const REQUIRE_SHIM = "import { createRequire as __v2cRequire } from 'node:module';\nconst require = __v2cRequire(import.meta.url);\n";

export function packageJson(pkg: PublishedPackage): Record<string, unknown> {
  return {
    name: pkg.name,
    version: pkg.version,
    description: pkg.description,
    keywords: KEYWORDS,
    homepage: SITE_URL,
    bugs: { url: `${REPO_URL}/issues` },
    repository: { type: 'git', url: REPO_GIT_URL, directory: pkg.directory },
    license: LICENSE,
    author: GITHUB_OWNER,
    type: 'module',
    bin: { [pkg.bin]: `./dist/${pkg.bin}.mjs` },
    files: ['dist', 'README.md', 'LICENSE'],
    engines: { node: '>=22' },
    ...(pkg.mcpName ? { mcpName: pkg.mcpName } : {}),
  };
}

/** Bundles one package into `outDir/<name>/` and returns that directory. */
export async function buildPackage(pkg: PublishedPackage, outDir: string = NPM_OUT): Promise<string> {
  const dir = join(outDir, pkg.name);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(join(dir, 'dist'), { recursive: true });
  const outfile = join(dir, 'dist', `${pkg.bin}.mjs`);

  await build({
    entryPoints: [join(ROOT, pkg.entry)],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    banner: { js: REQUIRE_SHIM },
    legalComments: 'linked',
    logLevel: 'warning',
  });

  // esbuild keeps the source hashbang (`npx tsx`); the bundle runs on plain node.
  const code = readFileSync(outfile, 'utf8').replace(/^#!.*\n/, '');
  writeFileSync(outfile, SHEBANG + code);
  chmodSync(outfile, 0o755);

  writeFileSync(join(dir, 'package.json'), `${JSON.stringify(packageJson(pkg), null, 2)}\n`);
  writeFileSync(join(dir, 'README.md'), npmReadme(pkg));
  copyFileSync(join(ROOT, 'LICENSE'), join(dir, 'LICENSE'));
  return dir;
}

export async function buildAll(outDir: string = NPM_OUT): Promise<string[]> {
  const dirs: string[] = [];
  for (const pkg of PACKAGES) dirs.push(await buildPackage(pkg, outDir));
  return dirs;
}

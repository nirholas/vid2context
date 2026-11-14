/**
 * Builds the publishable npm packages. The workspace packages export raw
 * TypeScript, which npx cannot run, so each bin is bundled with esbuild into
 * one ESM file with no runtime dependencies. The source packages stay as
 * they are; this only reads their entry points.
 */
import { chmodSync, copyFileSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { npmReadme } from './manifests.ts';
import { GITHUB_OWNER, KEYWORDS, LICENSE, PACKAGES, type PublishedPackage, REPO_GIT_URL, REPO_URL, SITE_URL } from './meta.ts';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
export const NPM_OUT = join(ROOT, 'packages/discovery/dist/npm');

const SHEBANG = '#!/usr/bin/env node\n';
// Bundled CommonJS dependencies call require(); ESM output has no require, so give it one.
const REQUIRE_SHIM =
  "import { createRequire as __v2cRequire } from 'node:module';\nconst require = __v2cRequire(import.meta.url);\n";

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
    files: ['dist', 'README.md', 'LICENSE', 'THIRD_PARTY_LICENSES.txt'],
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

  const result = await build({
    entryPoints: [join(ROOT, pkg.entry)],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    banner: { js: REQUIRE_SHIM },
    legalComments: 'none',
    metafile: true,
    logLevel: 'warning',
  });

  // esbuild keeps the source hashbang (`npx tsx`); the bundle runs on plain node.
  const code = readFileSync(outfile, 'utf8').replace(/^#!.*\n/, '');
  writeFileSync(outfile, SHEBANG + code);
  chmodSync(outfile, 0o755);

  const notices = thirdPartyNotices(Object.keys(result.metafile.inputs));
  if (notices) writeFileSync(join(dir, 'THIRD_PARTY_LICENSES.txt'), notices);

  writeFileSync(join(dir, 'package.json'), `${JSON.stringify(packageJson(pkg), null, 2)}\n`);
  writeFileSync(join(dir, 'README.md'), npmReadme(pkg));
  copyFileSync(join(ROOT, 'LICENSE'), join(dir, 'LICENSE'));
  return dir;
}

/**
 * License texts of every npm package bundled into the output, so the
 * notices MIT and similar licenses require ship with the bundle.
 */
export function thirdPartyNotices(inputs: string[]): string {
  const dirs = new Set<string>();
  for (const input of inputs) {
    const match = input.match(/^(.*node_modules\/(?:@[^/]+\/)?[^/]+)\//);
    if (match?.[1]) dirs.add(match[1]);
  }
  const sections: string[] = [];
  for (const rel of [...dirs].sort()) {
    const dir = join(ROOT, rel);
    const meta = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as {
      name: string;
      version: string;
      license?: string;
    };
    const file = readdirSync(dir).find((f) => /^(licen[cs]e|copying)(\.|$)/i.test(f));
    const text = file ? readFileSync(join(dir, file), 'utf8').trim() : `License: ${meta.license ?? 'see package'}`;
    sections.push(`${meta.name}@${meta.version} (${meta.license ?? 'unknown'})\n\n${text}`);
  }
  return sections.length ? `${sections.join(`\n\n${'-'.repeat(72)}\n\n`)}\n` : '';
}

export async function buildAll(outDir: string = NPM_OUT): Promise<string[]> {
  const dirs: string[] = [];
  for (const pkg of PACKAGES) dirs.push(await buildPackage(pkg, outDir));
  return dirs;
}

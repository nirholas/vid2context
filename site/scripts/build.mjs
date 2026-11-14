#!/usr/bin/env node
/**
 * Builds the site from a clean checkout:
 *   1. installs site/ dependencies when they are missing (site/ is its own npm project),
 *   2. generates the provider registry when it is missing,
 *   3. writes src/generated/site-data.json from the repo (scripts/gen-data.ts),
 *   4. runs `astro build`, passing through any extra arguments (for example --base /vid2context/).
 *
 * `npm run build:site` at the repo root and `npm run build` in site/ both land here.
 * --data-only stops after step 3 (used by `npm run dev`).
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const site = join(dirname(fileURLToPath(import.meta.url)), '..');
const root = join(site, '..');
const args = process.argv.slice(2);
const dataOnly = args.includes('--data-only');
const astroArgs = args.filter((a) => a !== '--data-only');

function run(cmd, cmdArgs, cwd) {
  // Child stdout goes to our stderr: this script prints nothing a caller parses.
  const res = spawnSync(cmd, cmdArgs, { cwd, stdio: ['ignore', 2, 2], env: process.env });
  if (res.status !== 0) {
    console.error(`[site] ${cmd} ${cmdArgs.join(' ')} failed (exit ${res.status ?? res.signal})`);
    process.exit(res.status ?? 1);
  }
}

const log = (msg) => console.error(`[site] ${msg}`);

if (!existsSync(join(root, 'node_modules', '@vid2context', 'core'))) {
  console.error('[site] The workspace packages are not installed. Run `npm install` at the repo root first.');
  process.exit(1);
}
if (!existsSync(join(site, 'node_modules', 'astro'))) {
  log('installing site dependencies (npm ci in site/)');
  run('npm', ['ci', '--no-audit', '--no-fund'], site);
}
if (!existsSync(join(root, 'packages', 'registry', 'src', 'generated', 'node.ts'))) {
  log('generating the provider registry');
  run(process.execPath, [join(root, 'scripts', 'gen-registry.mjs')], root);
}

run(process.execPath, [join(site, 'node_modules', 'tsx', 'dist', 'cli.mjs'), join(site, 'scripts', 'gen-data.ts')], root);
if (dataOnly) process.exit(0);

log(`astro build${astroArgs.length ? ` ${astroArgs.join(' ')}` : ''}`);
run(process.execPath, [join(site, 'node_modules', 'astro', 'bin', 'astro.mjs'), 'build', ...astroArgs], site);

for (const required of ['index.html', '404.html', 'robots.txt', 'sitemap.xml', 'llms.txt', 'llms-full.txt', 'index.md']) {
  if (!existsSync(join(site, 'dist', required))) {
    console.error(`[site] dist/${required} is missing after the build.`);
    process.exit(1);
  }
}
log('done: site/dist');

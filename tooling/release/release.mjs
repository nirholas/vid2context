#!/usr/bin/env node
/**
 * Release the npm bundles (`vid2context` and `vid2context-mcp`).
 *
 *   node tooling/release/release.mjs                    build, SBOMs, npm publish --dry-run (default)
 *   node tooling/release/release.mjs --no-build         reuse the bundles already built
 *   node tooling/release/release.mjs --publish --tag v0.2.0
 *
 * The bundles come from `npm run build:npm` (packages/discovery bundles each
 * bin with esbuild into packages/discovery/dist/npm/<name>/). This script
 * never edits a workspace manifest. For each bundle it writes
 * `sbom.cdx.json` (CycloneDX, from `npm sbom` over the source workspace's
 * production tree, renamed to the published package) and runs `npm publish`.
 *
 * `--publish` is a real publish. It refuses unless `--tag` equals
 * `v<version>` of every bundle; npm itself needs a login or token.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const NPM = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const DEFAULT_OUT = join(ROOT, 'packages/discovery/dist/npm');

function parseArgs(argv) {
  const opts = { build: true, publish: false, tag: null, out: DEFAULT_OUT };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--no-build') opts.build = false;
    else if (a === '--publish') opts.publish = true;
    else if (a === '--tag') opts.tag = argv[++i];
    else if (a.startsWith('--tag=')) opts.tag = a.slice(6);
    else if (a === '--out') opts.out = resolve(argv[++i]);
    else throw new Error(`unknown option ${a}`);
  }
  return opts;
}

function run(cmd, args, { capture = false } = {}) {
  console.error(`$ ${cmd} ${args.join(' ')}`);
  const res = spawnSync(cmd, args, {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    stdio: capture ? ['ignore', 'pipe', 'inherit'] : 'inherit',
  });
  if (res.error) throw res.error;
  if (res.status !== 0) throw new Error(`${cmd} ${args[0]} exited with ${res.status}`);
  return res.stdout;
}

/**
 * `npm publish --dry-run` for one bundle, echoing npm's tarball listing.
 * npm silently "auto-corrects" bad manifests at publish time, for example by
 * dropping a `bin` entry it considers invalid, which would ship a package
 * that `npx` cannot run. Any auto-correction fails the release instead.
 */
function dryRun(bundle) {
  const args = ['publish', bundle.dir, '--access', 'public', '--dry-run'];
  console.error(`$ ${NPM} ${args.join(' ')}`);
  const res = spawnSync(NPM, args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (res.error) throw res.error;
  process.stderr.write(res.stderr);
  process.stdout.write(res.stdout);
  if (res.status !== 0) throw new Error(`npm publish --dry-run exited with ${res.status}`);
  const fixes = res.stderr
    .split('\n')
    .filter((l) => /^npm warn publish "/.test(l))
    .map((l) => l.replace(/^npm warn publish /, ''));
  if (/auto-corrected some errors/.test(res.stderr)) {
    throw new Error(
      `${bundle.pkg.name}: npm would rewrite the generated package.json at publish time (${fixes.join('; ') || 'see above'}). Fix the manifest generator (packages/discovery/src/npm.ts) and rebuild.`,
    );
  }
}

/** Bundle directories under `out`: each holds a generated package.json. */
function findBundles(out) {
  if (!existsSync(out)) return [];
  return readdirSync(out, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(join(out, d.name, 'package.json')))
    .map((d) => {
      const dir = join(out, d.name);
      return { dir, pkg: JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) };
    });
}

/**
 * CycloneDX SBOM for one bundle: npm's SBOM of the workspace the bundle is
 * built from (production dependencies only, since those are what esbuild
 * inlines), with the top component renamed to the published package.
 */
function sbomFor(bundle) {
  const source = bundle.pkg.repository?.directory;
  if (!source) throw new Error(`${bundle.pkg.name}: package.json has no repository.directory to take the SBOM from`);
  const raw = run(NPM, ['sbom', '--sbom-format', 'cyclonedx', '--omit', 'dev', '--workspace', source], { capture: true });
  const sbom = JSON.parse(raw);
  const { name, version } = bundle.pkg;
  const ref = `${name}@${version}`;
  const oldRef = sbom.metadata?.component?.['bom-ref'];
  sbom.metadata.component = {
    ...sbom.metadata.component,
    'bom-ref': ref,
    type: 'application',
    name,
    version,
    purl: `pkg:npm/${name}@${version}`,
    properties: [{ name: 'vid2context:source-workspace', value: source }],
  };
  // The workspace's own entry is now the published package itself.
  if (oldRef && Array.isArray(sbom.dependencies)) {
    for (const d of sbom.dependencies) if (d.ref === oldRef) d.ref = ref;
  }
  return sbom;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.build) run(NPM, ['run', 'build:npm']);

  const bundles = findBundles(opts.out);
  if (!bundles.length) throw new Error(`no bundles in ${relative(ROOT, opts.out)}: run npm run build:npm first`);

  if (opts.publish) {
    const bad = bundles.filter((b) => opts.tag !== `v${b.pkg.version}`);
    if (!opts.tag || bad.length) {
      throw new Error(
        `refusing to publish: --tag ${opts.tag ?? '(missing)'} must equal v<version> of every bundle (${bundles.map((b) => `${b.pkg.name}@${b.pkg.version}`).join(', ')})`,
      );
    }
  }

  // Every bundle passes the dry run before anything is published, so one bad
  // manifest cannot leave a half-published release.
  for (const bundle of bundles) {
    const name = `${bundle.pkg.name}@${bundle.pkg.version}`;
    console.error(`\n== ${name} (${relative(ROOT, bundle.dir)})`);
    const sbomPath = join(bundle.dir, 'sbom.cdx.json');
    writeFileSync(sbomPath, `${JSON.stringify(sbomFor(bundle), null, 2)}\n`);
    console.error(`wrote ${relative(ROOT, sbomPath)}`);
    dryRun(bundle);
  }
  if (opts.publish) {
    for (const bundle of bundles) run(NPM, ['publish', bundle.dir, '--access', 'public']);
  }
  console.error(opts.publish ? '\nrelease: published' : '\nrelease: dry run finished, nothing was published');
}

try {
  main();
} catch (err) {
  console.error(`release: ${err.message}`);
  process.exitCode = 1;
}

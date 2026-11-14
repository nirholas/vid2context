#!/usr/bin/env node
/**
 * npm run build:vercel [-- --no-build] [--strict]
 *
 * Writes a complete Vercel Build Output API v3 tree to .vercel/output/:
 *
 *   static/              the same assets as Cloudflare (site, /app/, /chat/, llms.txt)
 *   functions/api.func/  the HTTP API bundled into one ESM file (Node.js 22)
 *   config.json          routes: /api/*, /mcp and /.well-known/oauth-* to the
 *                        function, then files, then SPA fallbacks, then 404.html
 *
 * Deploy it with `npx vercel deploy --prebuilt` (add `--prod` for production).
 * No vercel.json and no Vercel-side build are needed.
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { buildAssets } from '../lib/assets.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '../../..');

/** Route table for config.json. Exported for tests. */
export function vercelRoutes(spaMounts) {
  return [
    { src: '^/api(?:/.*)?$', dest: '/api' },
    { src: '^/mcp(?:/.*)?$', dest: '/api' },
    { src: '^/\\.well-known/oauth-.*$', dest: '/api' },
    { handle: 'filesystem' },
    // Deep links inside an app serve its index.html; paths that look like files stay 404.
    ...spaMounts.map((mount) => ({ src: `^${mount}(?!.*\\.[A-Za-z0-9]{1,8}$).*$`, dest: `${mount}index.html` })),
    { handle: 'error' },
    { status: 404, src: '^/.*$', dest: '/404.html' },
  ];
}

export async function buildVercel({ build = true, strict = false, log = (m) => console.error(m) } = {}) {
  const out = join(root, '.vercel/output');
  rmSync(out, { recursive: true, force: true });
  const assets = buildAssets({ root, out: join(out, 'static'), build, strict, log });

  const fnDir = join(out, 'functions/api.func');
  mkdirSync(fnDir, { recursive: true });
  // esbuild is in the tree through tsx and vitest; see docs/deploy/vercel.md.
  const esbuild = await import('esbuild');
  const result = await esbuild.build({
    entryPoints: [join(here, 'function.ts')],
    outfile: join(fnDir, 'index.mjs'),
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    metafile: true,
    legalComments: 'none',
    // Some dependencies are CommonJS and call require(); give the ESM bundle one.
    banner: { js: "import { createRequire as __v2cCreateRequire } from 'node:module'; const require = __v2cCreateRequire(import.meta.url);" },
    logLevel: 'warning',
  });
  writeFileSync(
    join(fnDir, '.vc-config.json'),
    `${JSON.stringify(
      { runtime: 'nodejs22.x', handler: 'index.mjs', launcherType: 'Nodejs', shouldAddHelpers: false, supportsResponseStreaming: true },
      null,
      2,
    )}\n`,
  );
  writeFileSync(join(out, 'config.json'), `${JSON.stringify({ version: 3, routes: vercelRoutes(assets.spaMounts) }, null, 2)}\n`);

  const fnBytes = Object.values(result.metafile.outputs).reduce((n, o) => n + o.bytes, 0);
  log(`[vercel] .vercel/output: ${assets.files} static files, function ${(fnBytes / 1024).toFixed(1)} KiB`);
  return { out, assets, fnBytes };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: { 'no-build': { type: 'boolean', default: false }, strict: { type: 'boolean', default: false } } });
  buildVercel({ build: !values['no-build'], strict: values.strict }).catch((err) => {
    console.error(`[vercel] ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  });
}

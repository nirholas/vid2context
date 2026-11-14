#!/usr/bin/env node
/**
 * npm run build:assets [-- --out dist/assets] [--no-build] [--strict] [--client-only] [--api-base /api/v1]
 *
 * Builds the static tree the root wrangler.jsonc serves (assets.directory):
 * the site at /, the web app at /app/, the chat app at /chat/, and llms.txt.
 * Apps that are missing or do not build are skipped with a reason; --strict
 * makes that an error (use it for production deploys once the apps exist).
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { buildAssets } from './lib/assets.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const { values } = parseArgs({
  options: {
    out: { type: 'string', default: 'dist/assets' },
    'no-build': { type: 'boolean', default: false },
    strict: { type: 'boolean', default: false },
    'client-only': { type: 'boolean', default: false },
    'api-base': { type: 'string' },
    'base-path': { type: 'string', default: '/' },
  },
});

try {
  const res = buildAssets({
    root,
    out: join(root, values.out),
    build: !values['no-build'],
    strict: values.strict,
    clientOnly: values['client-only'],
    apiBase: values['api-base'],
    basePath: values['base-path'],
  });
  const skipped = res.parts.filter((p) => p.status === 'skipped');
  console.error(
    `[assets] ${values.out}: ${res.files} files, ${(res.bytes / 1024).toFixed(1)} KiB` +
      (skipped.length ? `; skipped ${skipped.map((p) => p.mount).join(', ')}` : ''),
  );
} catch (err) {
  console.error(`[assets] ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
}

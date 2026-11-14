#!/usr/bin/env node
/**
 * Lighthouse over the built site (dist/), desktop and mobile, every category.
 * Serves dist/ with `astro preview` on a random port unless --url is given,
 * prints the scores, writes JSON reports to site/lighthouse/ (gitignored) and
 * exits 1 when any score is below --min (default 95).
 *
 *   npm run lighthouse
 *   npm run lighthouse -- --url https://vid2context.com --pages /,/docs/
 */
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import * as chromeLauncher from 'chrome-launcher';
import lighthouse from 'lighthouse';
import desktopConfig from 'lighthouse/core/config/desktop-config.js';
import { findChromium } from './chromium.mjs';

const site = join(dirname(fileURLToPath(import.meta.url)), '..');
const { values } = parseArgs({
  options: {
    url: { type: 'string' },
    pages: { type: 'string', default: '/,/docs/,/docs/clients/claude-code/' },
    min: { type: 'string', default: '95' },
  },
});
const min = Number(values.min);
const log = (msg) => console.error(`[lighthouse] ${msg}`);

async function serve() {
  const port = 20000 + Math.floor(Math.random() * 10000);
  const child = spawn(
    process.execPath,
    [join(site, 'node_modules/astro/bin/astro.mjs'), 'preview', '--ignore-lock', '--host', '127.0.0.1', '--port', String(port)],
    {
      cwd: site,
      stdio: ['ignore', 'ignore', 'inherit'],
    },
  );
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 60; i++) {
    try {
      if ((await fetch(base)).ok) return { base, stop: () => child.kill() };
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  child.kill();
  throw new Error('astro preview did not start');
}

const server = values.url ? { base: values.url.replace(/\/$/, ''), stop: () => {} } : await serve();
const chromePath = findChromium();
if (!chromePath) throw new Error('No Chromium found. Set CHROME_PATH or run `npx playwright install chromium` in site/.');
const chrome = await chromeLauncher.launch({ chromePath, chromeFlags: ['--headless=new', '--no-sandbox'] });
const outDir = join(site, 'lighthouse');
mkdirSync(outDir, { recursive: true });

const rows = [];
let failed = false;
try {
  for (const path of values.pages.split(',')) {
    for (const form of ['desktop', 'mobile']) {
      const result = await lighthouse(
        `${server.base}${path}`,
        { port: chrome.port, output: 'json', logLevel: 'error' },
        form === 'desktop' ? desktopConfig : undefined,
      );
      if (!result) throw new Error(`no result for ${path}`);
      const name = `${form}${path.replace(/\//g, '_')}`;
      writeFileSync(join(outDir, `${name}.json`), result.report);
      const scores = Object.fromEntries(
        Object.entries(result.lhr.categories).map(([k, c]) => [k, Math.round((c.score ?? 0) * 100)]),
      );
      rows.push({ path, form, ...scores });
      for (const [k, s] of Object.entries(scores)) {
        if (s < min) {
          failed = true;
          const audits = Object.values(result.lhr.audits).filter(
            (a) =>
              a.score !== null && a.score < 0.9 && result.lhr.categories[k].auditRefs.some((r) => r.id === a.id && r.weight > 0),
          );
          log(`${form} ${path} ${k} ${s}: ${audits.map((a) => a.id).join(', ')}`);
        }
      }
    }
  }
} finally {
  await chrome.kill();
  server.stop();
}

console.error(['page'.padEnd(34), 'form'.padEnd(8), 'perf', 'a11y', 'best', 'seo'].join(' '));
for (const r of rows) {
  console.error(
    [
      r.path.padEnd(34),
      r.form.padEnd(8),
      String(r.performance).padStart(4),
      String(r.accessibility).padStart(4),
      String(r['best-practices']).padStart(4),
      String(r.seo).padStart(4),
    ].join(' '),
  );
}
process.exit(failed ? 1 : 0);

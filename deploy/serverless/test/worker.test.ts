/**
 * Runs the Worker in the real Workers runtime with `wrangler dev` (local,
 * no Cloudflare account). Slow (about 10 seconds per server), so it runs only
 * with WRANGLER_TEST=1 or LIVE=1:
 *
 *   WRANGLER_TEST=1 npx vitest run -c deploy/serverless/vitest.config.ts
 *   LIVE=1 ...   also fetches a real YouTube transcript through the Worker
 */
import { type ChildProcess, spawn } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
// @ts-expect-error: plain ESM build script without type declarations
import { buildAssets } from '../lib/assets.mjs';
import { staticSiteFixture } from './site-fixture.ts';

const root = join(import.meta.dirname, '../../..');
const wranglerBin = join(root, 'node_modules/wrangler/bin/wrangler.js');
const enabled = Boolean(process.env.WRANGLER_TEST || process.env.LIVE);
const servers: ChildProcess[] = [];
const dirs: string[] = [];

afterAll(() => {
  for (const s of servers) if (s.pid) process.kill(-s.pid, 'SIGTERM');
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

async function startWrangler(config: string): Promise<string> {
  const port = 20000 + Math.floor(Math.random() * 9999);
  const child = spawn(process.execPath, [wranglerBin, 'dev', '-c', config, '--port', String(port), '--ip', '127.0.0.1'], {
    cwd: root,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, WRANGLER_SEND_METRICS: 'false' },
  });
  servers.push(child);
  let output = '';
  child.stdout?.on('data', (d) => {
    output += String(d);
  });
  child.stderr?.on('data', (d) => {
    output += String(d);
  });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 90; i++) {
    if (child.exitCode !== null) throw new Error(`wrangler dev exited:\n${output.slice(-2000)}`);
    try {
      await fetch(base, { signal: AbortSignal.timeout(1000) });
      return base;
    } catch {
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  throw new Error(`wrangler dev did not start:\n${output.slice(-2000)}`);
}

describe.skipIf(!enabled)('SPA fallback in the Workers runtime', () => {
  it('serves an app index for deep links, real files as-is, and the site 404 elsewhere', async () => {
    const dir = mkdtempSync(join(root, '.vid2context', 'worker-test-'));
    dirs.push(dir);
    const assets = join(dir, 'assets');
    const siteDir = staticSiteFixture(root);
    dirs.push(siteDir);
    buildAssets({ root, out: assets, build: false, siteDir, log: () => {} });
    // A mounted app made of real repo files: the site's page as its index and
    // llms.txt as a static file inside it. The fallback only cares about paths.
    mkdirSync(join(assets, 'app'), { recursive: true });
    cpSync(join(siteDir, 'index.html'), join(assets, 'app/index.html'));
    cpSync(join(root, 'llms.txt'), join(assets, 'app/notes.txt'));
    const config = join(dir, 'wrangler.jsonc');
    writeFileSync(
      config,
      JSON.stringify({
        name: 'v2c-spa-test',
        main: join(root, 'deploy/serverless/test/spa-worker.ts'),
        compatibility_date: '2026-10-01',
        assets: {
          directory: assets,
          binding: 'ASSETS',
          run_worker_first: true,
          html_handling: 'auto-trailing-slash',
          not_found_handling: '404-page',
        },
      }),
    );
    const base = await startWrangler(config);

    const deep = await fetch(`${base}/app/runs/42`);
    expect(deep.status).toBe(200);
    expect(await deep.text()).toContain('vid2context');

    const file = await fetch(`${base}/app/notes.txt`);
    expect(file.status).toBe(200);
    expect(file.headers.get('content-type')).toContain('text/plain');

    expect((await fetch(`${base}/app/assets/missing.js`)).status).toBe(404);
    expect((await fetch(`${base}/chat/anything`)).status).toBe(404); // chat not deployed: no fallback
    const notFound = await fetch(`${base}/no/such/page`);
    expect(notFound.status).toBe(404);
    expect(await notFound.text()).toContain('<html');
    expect((await fetch(`${base}/`)).status).toBe(200);
  });
});

describe.skipIf(!enabled)('the real Worker entry (packages/server/src/workers.ts)', () => {
  it('serves the app shell for /app/* deep links and keeps the API and the site 404', async () => {
    const dir = mkdtempSync(join(root, '.vid2context', 'worker-entry-test-'));
    dirs.push(dir);
    const assets = join(dir, 'assets');
    const siteDir = staticSiteFixture(root);
    dirs.push(siteDir);
    buildAssets({ root, out: assets, build: false, siteDir, log: () => {} });
    // The app shell: a real repo page copied to /app/index.html, as in the SPA test above.
    mkdirSync(join(assets, 'app'), { recursive: true });
    cpSync(join(siteDir, 'index.html'), join(assets, 'app/index.html'));
    const shell = readFileSync(join(assets, 'app/index.html'), 'utf8');
    const config = join(dir, 'wrangler.jsonc');
    writeFileSync(
      config,
      JSON.stringify({
        name: 'v2c-entry-test',
        main: join(root, 'packages/server/src/workers.ts'),
        compatibility_date: '2026-10-01',
        assets: {
          directory: assets,
          binding: 'ASSETS',
          run_worker_first: true,
          html_handling: 'auto-trailing-slash',
          not_found_handling: '404-page',
        },
        vars: { VID2CONTEXT_PUBLIC: '1' },
      }),
    );
    const base = await startWrangler(config);

    const deep = await fetch(`${base}/app/some/path`);
    expect(deep.status).toBe(200);
    expect(deep.headers.get('content-type')).toContain('text/html');
    expect(await deep.text()).toBe(shell);
    expect((await fetch(`${base}/app`)).status).toBe(200);
    expect((await fetch(`${base}/app/assets/missing.js`)).status).toBe(404);

    const health = await fetch(`${base}/api/v1/health`);
    expect(health.status).toBe(200);
    expect((await health.json()).runtime).toBe('workers');
    expect((await fetch(`${base}/no/such/page`)).status).toBe(404);
  });
});

describe.skipIf(!enabled)('the root wrangler.jsonc', () => {
  it('serves the site and the API from one Worker', async () => {
    // The real site: Astro is built when site/ is an Astro project; apps use whatever dist/ they have.
    buildAssets({ root, out: join(root, 'dist/assets'), build: false, buildSite: true, log: () => {} });
    const base = await startWrangler(join(root, 'wrangler.jsonc'));
    const health = await fetch(`${base}/api/v1/health`);
    expect(health.status).toBe(200);
    expect((await health.json()).runtime).toBe('workers');
    expect((await fetch(`${base}/`)).status).toBe(200);
    expect((await fetch(`${base}/llms.txt`)).status).toBe(200);
    expect((await fetch(`${base}/missing-page`)).status).toBe(404);

    if (process.env.LIVE) {
      const t = await fetch(`${base}/api/v1/transcript?url=https://youtu.be/jNQXAC9IVRw&timestamps=1`);
      const body = await t.text();
      // From a datacenter IP YouTube may answer 429; the API must then say so with a hint, not crash.
      if (t.status === 200) expect(body).toContain('elephants');
      else expect(JSON.parse(body).error.hint).toBeTruthy();
    }
  });
});

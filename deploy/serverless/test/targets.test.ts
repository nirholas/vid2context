import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
// @ts-expect-error: plain ESM build script without type declarations
import { publishPages } from '../github-pages/publish.mjs';
// @ts-expect-error: plain ESM build script without type declarations
import { buildVercel, vercelRoutes } from '../vercel/build.mjs';
import { staticSiteFixture } from './site-fixture.ts';

const root = join(import.meta.dirname, '../../..');
const cleanups: (() => void)[] = [];
const siteDir = staticSiteFixture(root);
cleanups.push(() => execFileSync('rm', ['-rf', siteDir]));
afterAll(() => {
  for (const c of cleanups) c();
});

describe('Vercel build output', () => {
  it('writes static files, a bundled function and a v3 config', async () => {
    const res = await buildVercel({ build: false, siteDir, log: () => {} });
    const out = res.out as string;
    for (const f of ['static/index.html', 'static/404.html', 'static/llms.txt', 'functions/api.func/index.mjs']) {
      expect(existsSync(join(out, f))).toBe(true);
    }
    const vc = JSON.parse(readFileSync(join(out, 'functions/api.func/.vc-config.json'), 'utf8'));
    expect(vc).toMatchObject({ runtime: 'nodejs22.x', handler: 'index.mjs', launcherType: 'Nodejs' });
    const config = JSON.parse(readFileSync(join(out, 'config.json'), 'utf8'));
    expect(config.version).toBe(3);
    expect(config.routes.findIndex((r: { handle?: string }) => r.handle === 'filesystem')).toBe(3);
  });

  it('serves the API from the bundled function on a real Node server, and refuses local paths', async () => {
    const mod = await import(pathToFileURL(join(root, '.vercel/output/functions/api.func/index.mjs')).href);
    const server = createServer(mod.default);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    cleanups.push(() => server.close());
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const health = await fetch(`${base}/api/v1/health`);
    expect(health.status).toBe(200);
    const body = await health.json();
    expect(body.providers.map((p: { id: string }) => p.id)).not.toContain('media-file');
    const local = await fetch(`${base}/api/v1/context?url=${encodeURIComponent('/etc/passwd')}`);
    expect(local.status).toBe(400);
  });

  it('routes the API first, then files, then app fallbacks that skip file-like paths, then 404', () => {
    const routes = vercelRoutes(['/app/']) as { src?: string; dest?: string; handle?: string }[];
    const api = routes.filter((r) => r.dest === '/api').map((r) => new RegExp(r.src as string));
    expect(['/api/v1/health', '/mcp', '/.well-known/oauth-authorization-server'].every((p) => api.some((re) => re.test(p)))).toBe(
      true,
    );
    expect(api.some((re) => re.test('/apiary'))).toBe(false);
    const spa = new RegExp(routes.find((r) => r.dest === '/app/index.html')?.src as string);
    expect(spa.test('/app/runs/42')).toBe(true);
    expect(spa.test('/app/assets/index-abc.js')).toBe(false);
    expect(routes.at(-1)).toMatchObject({ status: 404, dest: '/404.html' });
  });
});

describe('GitHub Pages publisher (dry run)', () => {
  it('builds the client-only tree and commits it to gh-pages in a throwaway clone only', () => {
    const before = execFileSync('git', ['branch', '--list', 'gh-pages'], { cwd: root, encoding: 'utf8' });
    const res = publishPages({ dryRun: true, build: false, keep: true, siteDir, log: () => {} });
    cleanups.push(() => execFileSync('rm', ['-rf', res.work]));
    expect(res.basePath).toBe('/vid2context/');
    expect(res.changed).toBe(true);
    const files = execFileSync('git', ['ls-tree', '-r', '--name-only', res.commit], { cwd: res.repo, encoding: 'utf8' }).split(
      '\n',
    );
    expect(files).toEqual(expect.arrayContaining(['.nojekyll', 'index.html', '404.html', 'llms.txt', 'llms-full.txt']));
    expect(files).not.toContain('CNAME');
    const msg = execFileSync('git', ['log', '-1', '--format=%B', res.commit], { cwd: res.repo, encoding: 'utf8' });
    expect(msg).toMatch(/^chore\(pages\): publish the client-only build of [0-9a-f]+/);
    expect(msg).toContain('Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>');
    // The page was rebased for the project-pages subpath.
    const html = execFileSync('git', ['show', `${res.commit}:index.html`], { cwd: res.repo, encoding: 'utf8' });
    expect(html).toContain('href="/vid2context/llms.txt"');
    // The real repository gained no branch.
    expect(execFileSync('git', ['branch', '--list', 'gh-pages'], { cwd: root, encoding: 'utf8' })).toBe(before);
  });

  it('serves from the domain root and writes CNAME when a custom domain is given', () => {
    const res = publishPages({ dryRun: true, build: false, keep: true, siteDir, cname: 'pages.vid2context.com', log: () => {} });
    cleanups.push(() => execFileSync('rm', ['-rf', res.work]));
    expect(res.basePath).toBe('/');
    expect(execFileSync('git', ['show', `${res.commit}:CNAME`], { cwd: res.repo, encoding: 'utf8' })).toBe(
      'pages.vid2context.com\n',
    );
  });

  it('refuses to push from a dry run', () => {
    expect(() => publishPages({ dryRun: true, push: true, build: false, siteDir, log: () => {} })).toThrow(/--push/);
  });
});

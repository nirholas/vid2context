import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join, relative } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
// @ts-expect-error: plain ESM build script without type declarations
import { buildAssets, mountPath, normalizeBasePath, rebaseHtml, spaMounts } from '../lib/assets.mjs';
import { staticSiteFixture } from './site-fixture.ts';

const root = join(import.meta.dirname, '../../..');
const scratch = join(root, '.vid2context');
const outs: string[] = [];
const siteDir = staticSiteFixture(root);
outs.push(siteDir);

function tempOut(): string {
  const dir = mkdtempSync(join(scratch, 'assets-test-'));
  outs.push(dir);
  return dir;
}

afterAll(() => {
  for (const d of outs) rmSync(d, { recursive: true, force: true });
});

type Part = { name: string; mount: string; status: string; reason?: string };

describe('buildAssets', () => {
  it('assembles the real site and llms files at the root and reports skipped apps', () => {
    const out = tempOut();
    const res = buildAssets({ root, out, build: false, siteDir, log: () => {} });
    for (const f of ['index.html', '404.html', 'llms.txt', 'llms-full.txt']) expect(existsSync(join(out, f))).toBe(true);
    expect(readFileSync(join(out, 'llms.txt'), 'utf8')).toBe(readFileSync(join(root, 'llms.txt'), 'utf8'));
    expect(readFileSync(join(out, 'index.html'), 'utf8')).toBe(readFileSync(join(siteDir, 'index.html'), 'utf8'));
    // Source files of the site never ship.
    expect(existsSync(join(out, 'package.json'))).toBe(false);
    // No _redirects: on Workers a rewrite rule would also catch the apps' own assets.
    expect(existsSync(join(out, '_redirects'))).toBe(false);
    const parts = res.parts as Part[];
    expect(parts.map((p) => p.name)).toEqual(['site', 'web', 'chat']);
    for (const p of parts.filter((x) => x.name !== 'site')) {
      // An app is either copied from its real dist/ or skipped with a reason; never stubbed.
      if (p.status === 'skipped') {
        expect(p.reason).toBeTruthy();
        expect(existsSync(join(out, p.mount))).toBe(false);
      } else {
        expect(existsSync(join(out, p.mount, 'index.html'))).toBe(true);
      }
    }
    expect(res.spaMounts).toEqual(spaMounts(parts));
  });

  it('rebases the site for a subpath (GitHub Pages project sites)', () => {
    const out = tempOut();
    buildAssets({ root, out, build: false, siteDir, basePath: '/vid2context/', log: () => {} });
    const html = readFileSync(join(out, 'index.html'), 'utf8');
    expect(html).toContain('href="/vid2context/llms.txt"');
    expect(html).not.toMatch(/href="\/llms\.txt"/);
    expect(html).toContain('href="https://github.com/nirholas/vid2context"');
  });

  it('refuses to write into the repo root or site/', () => {
    expect(() => buildAssets({ root, out: root, build: false, siteDir, log: () => {} })).toThrow(/Refusing/);
    expect(() => buildAssets({ root, out: join(root, 'site/out'), build: false, siteDir, log: () => {} })).toThrow(/Refusing/);
    expect(() => buildAssets({ root, out: '/tmp/v2c-outside', build: false, siteDir, log: () => {} })).toThrow(/Refusing/);
  });
});

describe('path helpers', () => {
  it('normalizes base paths and joins mounts', () => {
    expect(normalizeBasePath('')).toBe('/');
    expect(normalizeBasePath('vid2context')).toBe('/vid2context/');
    expect(normalizeBasePath('/vid2context/')).toBe('/vid2context/');
    expect(mountPath('/', 'app')).toBe('/app/');
    expect(mountPath('/vid2context/', 'chat')).toBe('/vid2context/chat/');
  });

  it('rewrites only root-absolute attributes', () => {
    const html = '<a href="/x">x</a><img src="//cdn.example/y.png"><a href="https://a.b/c">c</a><a href="#top">t</a>';
    expect(rebaseHtml(html, '/p/')).toBe(
      '<a href="/p/x">x</a><img src="//cdn.example/y.png"><a href="https://a.b/c">c</a><a href="#top">t</a>',
    );
    expect(rebaseHtml(html, '/')).toBe(html);
  });

  it('keeps every scratch output under the ignored .vid2context directory', () => {
    for (const d of outs) expect(relative(root, d).startsWith('.vid2context')).toBe(true);
  });
});

describe.skipIf(!(process.env.WRANGLER_TEST || process.env.LIVE))('the real Astro site (slow)', () => {
  it('builds site/ with Astro when it is an Astro project and copies its output', () => {
    const out = tempOut();
    const res = buildAssets({ root, out, build: false, buildSite: true, log: () => {} });
    const site = (res.parts as Part[])[0];
    expect(site?.name).toBe('site');
    expect(existsSync(join(out, 'index.html'))).toBe(true);
  });
});

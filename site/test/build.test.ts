/**
 * Checks over the built site in site/dist (run `npm run build:site` first).
 * No network: external links are listed, never fetched.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';

const SITE = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(SITE, 'dist');
const ORIGIN = 'https://vid2context.com';
/** Paths other builds mount into the same assets directory (prompts 28, 46, 47, 50). */
const MOUNTS = ['/app/', '/chat/', '/api/', '/mcp'];

if (!existsSync(join(DIST, 'index.html'))) {
  throw new Error('site/dist is missing. Run `npm run build:site` at the repo root first.');
}

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

const files = walk(DIST);
const htmlFiles = files.filter((f) => f.endsWith('.html'));
const read = (f: string) => readFileSync(f, 'utf8');
/** URL path of an HTML file: dist/docs/x/index.html is /docs/x/. */
const pathOf = (file: string) =>
  `/${relative(DIST, file)
    .replace(/index\.html$/, '')
    .replace(/\\/g, '/')}`;
const pages = htmlFiles.filter((f) => !f.endsWith('404.html'));

function attrs(html: string, tag: string, attr: string): string[] {
  const re = new RegExp(`<${tag}\\b[^>]*?\\s${attr}="([^"]*)"`, 'gi');
  return [...html.matchAll(re)].map((m) => (m[1] ?? '').replace(/&amp;/g, '&'));
}

function ids(html: string): Set<string> {
  return new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1] ?? ''));
}

/** The dist file a root-absolute path is served from, following the Worker's auto-trailing-slash rules. */
function resolveTarget(pathname: string): string | null {
  const clean = decodeURIComponent(pathname);
  const candidates = clean.endsWith('/')
    ? [join(DIST, clean, 'index.html')]
    : [join(DIST, clean), join(DIST, clean, 'index.html'), join(DIST, `${clean}.html`)];
  return candidates.find((c) => existsSync(c) && statSync(c).isFile()) ?? null;
}

describe('required files', () => {
  it.each([
    'index.html',
    '404.html',
    'robots.txt',
    'sitemap.xml',
    'llms.txt',
    'llms-full.txt',
    'index.md',
    'docs.md',
    'favicon.svg',
    'apple-touch-icon.png',
  ])('%s exists', (f) => {
    expect(existsSync(join(DIST, f))).toBe(true);
  });

  it('apple-touch-icon.png is a 180x180 PNG', () => {
    const png = readFileSync(join(DIST, 'apple-touch-icon.png'));
    expect(png.subarray(1, 4).toString()).toBe('PNG');
    expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([180, 180]);
  });

  it('builds nothing under the paths other builds own', () => {
    for (const mount of ['app', 'chat', 'api']) expect(existsSync(join(DIST, mount))).toBe(false);
  });
});

describe('links', () => {
  const external = new Set<string>();
  const broken: string[] = [];
  for (const file of htmlFiles) {
    const html = read(file);
    const here = pathOf(file);
    const links = [
      ...attrs(html, 'a', 'href'),
      ...attrs(html, 'link', 'href'),
      ...attrs(html, 'script', 'src'),
      ...attrs(html, 'img', 'src'),
    ];
    for (const href of links) {
      if (/^(mailto|tel|vscode|vscode-insiders|cursor|lmstudio|goose):/.test(href)) continue;
      if (/^https?:\/\//.test(href)) {
        if (!href.startsWith(ORIGIN)) external.add(href.split('#')[0] ?? href);
        continue;
      }
      const url = new URL(href, `${ORIGIN}${here}`);
      if (MOUNTS.some((m) => url.pathname.startsWith(m))) continue;
      const target = url.pathname === here ? file : resolveTarget(url.pathname);
      if (!target) {
        broken.push(`${here}: ${href} (no file)`);
        continue;
      }
      if (url.hash && target.endsWith('.html')) {
        const id = decodeURIComponent(url.hash.slice(1));
        if (!ids(read(target)).has(id)) broken.push(`${here}: ${href} (no #${id})`);
      }
    }
  }

  it('every internal link and anchor resolves', () => {
    expect(broken).toEqual([]);
  });

  it('lists external links without fetching them', () => {
    console.error(`[site:test] ${external.size} external links (not fetched):\n${[...external].sort().join('\n')}`);
    expect(external.size).toBeGreaterThan(0);
  });

  it('every page in llms.txt has its Markdown twin', () => {
    const urls = [...read(join(DIST, 'llms.txt')).matchAll(/\((https:\/\/vid2context\.com\/[^)]+\.md)\)/g)].map(
      (m) => m[1] ?? '',
    );
    expect(urls.length).toBeGreaterThan(10);
    for (const u of urls) expect(resolveTarget(new URL(u).pathname), u).not.toBeNull();
  });
});

describe('SEO', () => {
  it.each(pages.map((f) => [pathOf(f), f]))('%s has canonical, description, Open Graph and a Markdown twin', (path, file) => {
    const html = read(file);
    expect(html).toContain(`<link rel="canonical" href="${ORIGIN}${path}"`);
    expect(path.endsWith('/')).toBe(true);
    expect(html).toMatch(/<html lang="en"/);
    expect(html).toMatch(/<meta name="description" content="[^"]{40,}"/);
    expect(html).toContain('<meta name="twitter:card" content="summary_large_image"');
    expect(html).toContain('<meta property="og:site_name" content="vid2context"');
    expect(html).toContain('<meta name="theme-color"');
    const og = html.match(/<meta property="og:image" content="([^"]+)"/)?.[1] ?? '';
    expect(og.startsWith(`${ORIGIN}/og/`)).toBe(true);
    const png = readFileSync(join(DIST, new URL(og).pathname));
    expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([1200, 630]);
    const twin = html.match(/<link rel="alternate" type="text\/markdown" href="([^"]+)"/)?.[1];
    expect(twin).toBeDefined();
    const twinFile = resolveTarget(twin ?? '');
    expect(twinFile).not.toBeNull();
    expect(read(twinFile ?? '').trim().length).toBeGreaterThan(100);
  });

  it('the 404 page is noindex and has no canonical', () => {
    const html = read(join(DIST, '404.html'));
    expect(html).toContain('<meta name="robots" content="noindex"');
    expect(html).not.toContain('rel="canonical"');
  });

  it('robots.txt allows everything, names the AI crawlers and keeps /api/ out', () => {
    const robots = read(join(DIST, 'robots.txt'));
    for (const bot of [
      '*',
      'GPTBot',
      'OAI-SearchBot',
      'ChatGPT-User',
      'ClaudeBot',
      'Claude-SearchBot',
      'Claude-User',
      'PerplexityBot',
      'Perplexity-User',
      'Google-Extended',
      'Applebot',
      'Applebot-Extended',
    ]) {
      expect(robots).toContain(`User-agent: ${bot}\nAllow: /\nDisallow: /api/`);
    }
    expect(robots).toContain(`Sitemap: ${ORIGIN}/sitemap.xml`);
  });

  it('the sitemap lists every page once, on the apex host, with a date', () => {
    const xml = read(join(DIST, 'sitemap.xml'));
    const locs = [...xml.matchAll(/<loc>([^<]+)<\/loc>\s*<lastmod>(\d{4}-\d{2}-\d{2})<\/lastmod>/g)].map((m) => m[1] ?? '');
    expect(new Set(locs).size).toBe(locs.length);
    expect(locs.sort()).toEqual(pages.map((f) => `${ORIGIN}${pathOf(f)}`).sort());
  });

  it('sitemap dates come from git, not the build time', () => {
    const xml = read(join(DIST, 'sitemap.xml'));
    const readme = xml.match(/<loc>https:\/\/vid2context\.com\/docs\/<\/loc>\s*<lastmod>([^<]+)</)?.[1];
    const committed = execFileSync('git', ['log', '-1', '--format=%cI', '--', 'README.md'], {
      cwd: join(SITE, '..'),
      encoding: 'utf8',
    }).trim();
    expect(readme).toBe(new Date(committed).toISOString().slice(0, 10));
  });
});

describe('JSON-LD', () => {
  type Node = Record<string, unknown> & { '@type': string };
  const graphs = (html: string) =>
    [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map(
      (m) => JSON.parse(m[1] ?? '') as { '@context': string; '@graph': Node[] },
    );

  it.each(htmlFiles.map((f) => [pathOf(f), f]))('%s has one valid @graph', (path, file) => {
    const blocks = graphs(read(file));
    expect(blocks).toHaveLength(1);
    const g = blocks[0];
    expect(g?.['@context']).toBe('https://schema.org');
    const types = g?.['@graph'].map((n) => n['@type']) ?? [];
    expect(types).toEqual(expect.arrayContaining(['WebSite', 'SoftwareApplication', 'SoftwareSourceCode']));
    if (path.startsWith('/docs/')) expect(types).toContain('BreadcrumbList');
    if (path === '/') expect(types).toContain('FAQPage');
  });

  it('describes the software with the facts from discovery', () => {
    const g = graphs(read(join(DIST, 'index.html')))[0]?.['@graph'] ?? [];
    const app = g.find((n) => n['@type'] === 'SoftwareApplication');
    expect(app).toMatchObject({
      applicationCategory: 'DeveloperApplication',
      operatingSystem: 'macOS, Linux, Windows',
      offers: { price: '0' },
    });
    expect(typeof app?.softwareVersion).toBe('string');
    expect(String(app?.downloadUrl)).toMatch(/^https:\/\/(www\.npmjs\.com|github\.com)\//);
    const src = g.find((n) => n['@type'] === 'SoftwareSourceCode');
    expect(src).toMatchObject({ codeRepository: 'https://github.com/nirholas/vid2context', programmingLanguage: 'TypeScript' });
    const faq = g.find((n) => n['@type'] === 'FAQPage') as
      | { mainEntity: { name: string; acceptedAnswer: { text: string } }[] }
      | undefined;
    expect(faq?.mainEntity.length).toBeGreaterThan(3);
    const html = read(join(DIST, 'index.html'));
    for (const q of faq?.mainEntity ?? []) expect(html).toContain(q.name.replace(/'/g, '&#39;').replace(/"/g, '&quot;'));
  });
});

// The site lists each rung id once, as the chain keys rungs by id.
const { createRegistry } = await import('@vid2context/registry/node');
const expectedRungs: Record<string, Set<string>> = { local: new Set(), free: new Set(), keyless: new Set(), paid: new Set() };
for (const p of createRegistry().providers) {
  if (!('rungs' in p) || typeof p.rungs !== 'function') continue;
  for (const r of p.rungs({}) as { id: string; tier: string }[]) expectedRungs[r.tier]?.add(r.id);
}

describe('the provider grid matches the registry', () => {
  const html = read(join(DIST, 'index.html'));
  const grid = html.slice(html.indexOf('data-rung-grid'));

  it.each(['local', 'free', 'keyless', 'paid'])('%s tier', (tier) => {
    const section = grid.match(new RegExp(`data-tier="${tier}" data-count="(\\d+)"([\\s\\S]*?)</section>`));
    expect(section, `no ${tier} tier in the grid`).not.toBeNull();
    const shown = [...(section?.[2] ?? '').matchAll(/data-rung="([^"]+)"/g)].map((m) => m[1]);
    expect(Number(section?.[1])).toBe(expectedRungs[tier]?.size);
    expect(new Set(shown)).toEqual(expectedRungs[tier]);
  });
});

describe('landing page', () => {
  const html = read(join(DIST, 'index.html'));

  it('the hero form sends the link to /app/ as ?url=', () => {
    expect(html).toMatch(/<form[^>]*action="\/app\/" method="get"/);
    expect(html).toMatch(/<input[^>]*name="url"/);
    expect(html).toContain(`/app/?url=${encodeURIComponent('https://www.youtube.com/watch?v=cCPsdFdlshc')}`);
  });

  it('loads no third-party scripts, styles, fonts or images', () => {
    for (const file of htmlFiles) {
      const page = read(file);
      const loaded = [
        ...attrs(page, 'script', 'src'),
        ...attrs(page, 'img', 'src'),
        ...[
          ...page.matchAll(/<link\b[^>]*rel="(?:stylesheet|preload|icon|apple-touch-icon|modulepreload)"[^>]*href="([^"]+)"/g),
        ].map((m) => m[1] ?? ''),
      ];
      for (const src of loaded) expect(src.startsWith('/') && !src.startsWith('//'), `${pathOf(file)} loads ${src}`).toBe(true);
    }
    for (const css of files.filter((f) => f.endsWith('.css'))) expect(read(css)).not.toMatch(/url\(["']?https?:/);
  });

  it('ships under 100 KB of JavaScript, gzipped', () => {
    const urls = new Set(
      [...html.matchAll(/(?:component-url|renderer-url|src)="(\/_astro\/[^"]+\.js)"/g)].map((m) => m[1] ?? ''),
    );
    let total = 0;
    const seen = new Set<string>();
    const add = (url: string) => {
      if (seen.has(url)) return;
      seen.add(url);
      const code = readFileSync(join(DIST, url));
      total += gzipSync(code).length;
      for (const m of code.toString().matchAll(/from\s*"\.\/([^"]+\.js)"|import\("\.\/([^"]+\.js)"\)/g))
        add(`/_astro/${m[1] ?? m[2]}`);
    };
    for (const u of urls) add(u);
    for (const m of html.matchAll(/<script(?![^>]*type="application\/ld\+json")[^>]*>([\s\S]*?)<\/script>/g))
      total += gzipSync(m[1] ?? '').length;
    console.error(`[site:test] landing page JavaScript: ${(total / 1024).toFixed(1)} KB gzipped`);
    expect(total).toBeLessThan(100 * 1024);
  });
});

describe('copy rules', () => {
  it('no en dash or em dash anywhere in site/src', () => {
    const offenders = walk(join(SITE, 'src'))
      .filter((f) => !f.includes(`${join('src', 'generated')}`))
      .filter((f) => /[\u2013\u2014]/.test(read(f)));
    expect(offenders).toEqual([]);
  });
});

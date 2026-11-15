/**
 * The embed widget's contract (src/lib/embed.ts) and what the build ships for
 * it: /embed/, /embed.js, the recorded samples and the docs pages. Run
 * `npm run build:site` first.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Script } from 'node:vm';
import { describe, expect, it } from 'vitest';
import {
  changedParams,
  checkParam,
  EMBED_PARAMS,
  EMBED_SAMPLES,
  embedDefaults,
  embedUrl,
  iframeSnippet,
  parseEmbedParams,
  parseSeconds,
  SNIPPETS,
} from '../src/lib/embed.ts';

const SITE = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(SITE, 'dist');
const REPO = join(SITE, '..');
const read = (p: string) => readFileSync(join(DIST, p), 'utf8');

describe('parameters', () => {
  it('reads seconds in every documented form', () => {
    expect(parseSeconds('75')).toBe(75);
    expect(parseSeconds('1:15')).toBe(75);
    expect(parseSeconds('01:01:15')).toBe(3675);
    expect(parseSeconds('1m15s')).toBe(75);
    expect(parseSeconds('1h2m3s')).toBe(3723);
    expect(parseSeconds('2m')).toBe(120);
    expect(parseSeconds('soon')).toBeUndefined();
    expect(parseSeconds('')).toBeUndefined();
  });

  it('uses the defaults when nothing is set', () => {
    expect(parseEmbedParams('')).toEqual({ params: embedDefaults(), errors: [] });
  });

  it('rejects values that could reach CSS or fetch', () => {
    expect(checkParam('accent', 'red;}body{display:none')).toHaveProperty('error');
    expect(checkParam('accent', '#3B82F6')).toEqual({ value: '3b82f6' });
    expect(checkParam('api', 'javascript:alert(1)')).toHaveProperty('error');
    expect(checkParam('src', 'file:///etc/passwd')).toHaveProperty('error');
    expect(checkParam('view', 'everything')).toHaveProperty('error');
    expect(checkParam('lang', 'en"><script>')).toHaveProperty('error');
    expect(checkParam('lang', 'pt-BR')).toEqual({ value: 'pt-BR' });
  });

  it('reports bad values and keeps the default', () => {
    const { params, errors } = parseEmbedParams('view=nope&start=10&end=5&player=yes');
    expect(params.view).toBe('transcript');
    expect(params.end).toBe('');
    expect(params.player).toBe('1');
    expect(errors).toHaveLength(2);
  });

  it('writes only changed values, and reads back what it wrote', () => {
    const params = { ...embedDefaults(), url: 'https://www.youtube.com/watch?v=jNQXAC9IVRw', theme: 'light', start: '75' };
    expect(changedParams(params).map(([k]) => k)).toEqual(['url', 'theme', 'start']);
    const url = embedUrl('https://vid2context.com', params);
    expect(url).toBe('https://vid2context.com/embed/?url=https%3A%2F%2Fwww.youtube.com%2Fwatch%3Fv%3DjNQXAC9IVRw&theme=light&start=75');
    expect(parseEmbedParams(new URL(url).search).params).toEqual(params);
    expect(embedUrl('https://vid2context.com', embedDefaults())).toBe('https://vid2context.com/embed/');
  });

  it('escapes values in the HTML snippets', () => {
    const params = { ...embedDefaults(), src: 'https://example.org/a.json?x="><b>' };
    const html = iframeSnippet('https://vid2context.com', params);
    expect(html).not.toContain('"><b>');
    for (const s of SNIPPETS) expect(s.build('https://vid2context.com', params)).toContain('vid2context.com');
  });
});

describe('built files', () => {
  if (!existsSync(join(DIST, 'embed', 'index.html'))) throw new Error('site/dist/embed is missing. Run `npm run build:site` first.');

  it('the widget page is noindex, has no canonical, and loads only this origin', () => {
    const html = read('embed/index.html');
    expect(html).toContain('<meta name="robots" content="noindex"');
    expect(html).not.toContain('rel="canonical"');
    const loaded = [...html.matchAll(/<(?:script|img)\b[^>]*\ssrc="([^"]+)"/g)].map((m) => m[1] ?? '');
    for (const src of loaded) expect(src.startsWith('/') && !src.startsWith('//'), src).toBe(true);
  });

  it('the widget is left out of the sitemap', () => {
    expect(read('sitemap.xml')).not.toContain('<loc>https://vid2context.com/embed/');
  });

  it('/embed.js is one classic script that defines the element and knows every parameter', () => {
    const code = read('embed.js');
    expect(() => new Script(code)).not.toThrow();
    expect(code).not.toMatch(/^\s*(import|export)\s/m);
    expect(code).toContain('vid2context-embed');
    for (const p of EMBED_PARAMS) expect(code).toContain(`"${p.name}"`);
    expect(Buffer.byteLength(code)).toBeLessThan(8 * 1024);
  });

  it.each(EMBED_SAMPLES.map((s) => [s.id, s.file]))('sample %s is the recorded context without its description', (id, file) => {
    const served = JSON.parse(read(`embed/samples/${id}.json`));
    const fixture = JSON.parse(readFileSync(join(REPO, 'tests/fixtures/contexts', file), 'utf8'));
    expect(served.metadata.description).toBeUndefined();
    expect(served.transcript).toEqual(fixture.transcript);
    expect(served.metadata.title).toBe(fixture.metadata.title);
  });

  it('the docs have an Embed section with the builder, the gallery and the live element', () => {
    const builder = read('docs/embed/index.html');
    expect(builder).toContain('data-widget="embed-builder"');
    expect(builder).toContain('data-widget="embed-gallery"');
    for (const p of EMBED_PARAMS) expect(builder).toContain(`name="${p.name}"`);
    expect(read('docs/embed/javascript/index.html')).toContain('data-widget="embed-component"');
    const params = read('docs/embed/parameters/index.html');
    for (const p of EMBED_PARAMS) expect(params).toContain(`<code>${p.name}</code>`);
    expect(read('docs/embed.md')).toContain('```html');
  });
});

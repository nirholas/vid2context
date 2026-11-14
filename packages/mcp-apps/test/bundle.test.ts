// @vitest-environment happy-dom
/**
 * The committed viewer bundle (src/ui/viewer.html.ts) must match a fresh
 * build of src/ui/, and must be self-contained: MCP Apps hosts load it under
 * a CSP that blocks external scripts, styles, fonts and images.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { VideoContext } from '@vid2context/core';
import { describe, expect, it } from 'vitest';
import { buildViewerSource, outFile } from '../scripts/build-viewer.mjs';
import { toViewerData } from '../src/context.ts';
import { VIEWER_HTML } from '../src/ui/viewer.html.ts';
import { createViewer } from '../src/ui/viewer.ts';

describe('viewer bundle', () => {
  it('is up to date with src/ui (rebuild: node packages/mcp-apps/scripts/build-viewer.mjs)', async () => {
    const fresh = await buildViewerSource();
    expect(readFileSync(outFile, 'utf8')).toBe(fresh);
  });

  it('is one HTML document with inline CSS and JS and no external URLs', () => {
    expect(VIEWER_HTML.startsWith('<!doctype html>')).toBe(true);
    expect(VIEWER_HTML).toContain('<style>');
    expect(VIEWER_HTML).toContain('<script>');
    // Elements the viewer hides with the hidden attribute also have display rules; this keeps them hidden.
    expect(VIEWER_HTML).toContain('.v2c [hidden]{display:none}');
    expect(VIEWER_HTML).not.toMatch(/https?:\/\//i);
    expect(VIEWER_HTML).not.toMatch(/<script[^>]+src=|<link\b|<img\b|<iframe\b|@import|url\(/i);
    expect(VIEWER_HTML).not.toMatch(/[\u2013\u2014]/);
    expect(/^[\x20-\x7e\n]*$/.test(VIEWER_HTML)).toBe(true);
  });

  it('parses, and once rendered links only to timestamp URLs', () => {
    const doc = new DOMParser().parseFromString(VIEWER_HTML, 'text/html');
    expect(doc.querySelectorAll('script')).toHaveLength(1);
    expect(doc.querySelectorAll('style')).toHaveLength(1);
    expect(doc.getElementById('app')).not.toBeNull();

    const context = JSON.parse(
      readFileSync(join(import.meta.dirname, '../../../tests/fixtures/contexts/youtube-cCPsdFdlshc.json'), 'utf8'),
    ) as VideoContext;
    const root = document.createElement('div');
    document.body.replaceChildren(root);
    const data = toViewerData(context);
    createViewer(root).setData(data);
    const prefix = (data.timestampBase ?? '').split('{t}')[0] as string;
    const hrefs = [...root.querySelectorAll('[href], [src]')].map((e) => e.getAttribute('href') ?? e.getAttribute('src'));
    expect(hrefs.length).toBeGreaterThan(0);
    for (const h of hrefs) expect(h?.startsWith(prefix)).toBe(true);
  });
});

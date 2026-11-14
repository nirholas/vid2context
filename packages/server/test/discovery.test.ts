import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { MCP_HTTP_PATHS } from '@vid2context/mcp-http';
import { describe, expect, it } from 'vitest';
import {
  type FetchAsset,
  isAppPath as isAppPathIn,
  linkHeader,
  markdownTwins,
  prefersMarkdown,
  serveSite,
} from '../src/discovery.ts';

const repo = join(import.meta.dirname, '..', '..', '..');
const TYPES: Record<string, string> = { html: 'text/html; charset=utf-8', md: 'text/markdown', txt: 'text/plain; charset=utf-8' };

/** Serves real files from a directory the way the Workers ASSETS binding does: the file, `<path>/index.html`, or 404. */
function filesAt(dir: string): FetchAsset & { requested: string[] } {
  const requested: string[] = [];
  const fn = async (req: Request) => {
    const path = decodeURIComponent(new URL(req.url).pathname);
    requested.push(path);
    for (const candidate of [path, join(path, 'index.html'), `${path}.html`]) {
      const file = join(dir, candidate);
      if (file.startsWith(dir) && existsSync(file) && statSync(file).isFile()) {
        const ext = file.split('.').pop() ?? '';
        return new Response(readFileSync(file), { headers: { 'content-type': TYPES[ext] ?? 'application/octet-stream' } });
      }
    }
    return new Response('not found', { status: 404, headers: { 'content-type': 'text/html; charset=utf-8' } });
  };
  return Object.assign(fn, { requested });
}

const mcpPaths = new Set<string>(MCP_HTTP_PATHS);
const isAppPath = (p: string) => isAppPathIn(p, mcpPaths);

describe('markdown negotiation', () => {
  it('prefers markdown only when Accept ranks it above HTML', () => {
    expect(prefersMarkdown('text/markdown')).toBe(true);
    expect(prefersMarkdown('text/markdown, text/html;q=0.5')).toBe(true);
    expect(prefersMarkdown('text/markdown, */*;q=0.1')).toBe(true);
    expect(prefersMarkdown('text/html, text/markdown')).toBe(false);
    expect(prefersMarkdown('text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8')).toBe(false);
    expect(prefersMarkdown('*/*')).toBe(false);
    expect(prefersMarkdown('text/markdown;q=0')).toBe(false);
    expect(prefersMarkdown(null)).toBe(false);
  });

  it('maps page paths to .md twins, and files to none', () => {
    expect(markdownTwins('/')).toEqual(['/index.md']);
    expect(markdownTwins('/docs/http-api')).toEqual(['/docs/http-api.md', '/docs/http-api/index.md']);
    expect(markdownTwins('/docs/')).toEqual(['/docs.md', '/docs/index.md']);
    expect(markdownTwins('/llms.txt')).toEqual([]);
  });

  it('serves the .md twin with Vary: Accept when one exists', async () => {
    const assets = filesAt(join(repo, 'docs'));
    const res = await serveSite(
      new Request('https://vid2context.com/contracts/http-api', { headers: { accept: 'text/markdown' } }),
      assets,
      { mcp: false },
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/markdown; charset=utf-8');
    expect(res.headers.get('vary')).toBe('Accept');
    expect(await res.text()).toBe(readFileSync(join(repo, 'docs', 'contracts', 'http-api.md'), 'utf8'));
    expect(assets.requested).toEqual(['/contracts/http-api.md']);
  });

  it('falls through to HTML with Vary and Link headers when there is no twin', async () => {
    const assets = filesAt(join(import.meta.dirname, 'fixtures', 'site'));
    const res = await serveSite(new Request('https://vid2context.com/', { headers: { accept: 'text/markdown' } }), assets, {
      mcp: true,
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    expect(res.headers.get('vary')).toBe('Accept');
    expect(res.headers.get('link')).toBe(linkHeader({ mcp: true }));
    expect(res.headers.get('link')).toContain('</mcp>; rel="service"');
    expect(await res.text()).toBe(readFileSync(join(import.meta.dirname, 'fixtures', 'site', 'index.html'), 'utf8'));

    const browser = await serveSite(
      new Request('https://vid2context.com/', { headers: { accept: 'text/html,*/*;q=0.8' } }),
      assets,
      { mcp: false },
    );
    expect(browser.headers.get('link')).toBe(
      '</llms.txt>; rel="alternate"; type="text/plain", </api/v1/openapi.json>; rel="service-desc"; type="application/openapi+json"',
    );

    const txt = await serveSite(new Request('https://vid2context.com/llms.txt'), filesAt(repo), { mcp: false });
    expect(txt.headers.get('content-type')).toContain('text/plain');
    expect(txt.headers.get('link')).toBeNull();
  });

  it('routes the API and the MCP endpoints to the app, everything else to assets', () => {
    expect(isAppPath('/api/v1/health')).toBe(true);
    expect(isAppPath('/api')).toBe(true);
    expect(isAppPath('/mcp')).toBe(true);
    expect(isAppPath('/.well-known/oauth-authorization-server')).toBe(true);
    expect(isAppPath('/')).toBe(false);
    expect(isAppPath('/apiary')).toBe(false);
    expect(isAppPath('/llms.txt')).toBe(false);
  });
});

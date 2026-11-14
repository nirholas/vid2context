/** Every HTML page with lastmod from its source files' last git commit, not the build time. */
import type { APIRoute } from 'astro';
import { SITE_URL } from '../data/site.ts';
import { sitePages } from '../lib/pages.ts';

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');

export const GET: APIRoute = () => {
  const urls = sitePages()
    .map(
      (p) => `  <url>\n    <loc>${esc(`${SITE_URL}${p.url}`)}</loc>\n    <lastmod>${p.lastmod.slice(0, 10)}</lastmod>\n  </url>`,
    )
    .join('\n');
  const body = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`;
  return new Response(body, { headers: { 'content-type': 'application/xml; charset=utf-8' } });
};

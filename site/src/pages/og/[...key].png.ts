/** One 1200x630 Open Graph image per page: /og/index.png, /og/docs.png, /og/docs/<slug>.png. */
import type { APIRoute } from 'astro';
import { ogImage } from '../../lib/og.ts';
import { type SitePage, sitePages } from '../../lib/pages.ts';
import { ogImageFor } from '../../lib/seo.ts';

export function getStaticPaths() {
  return sitePages().map((page) => ({
    params: { key: ogImageFor(page.url).replace(/^\/og\//, '').replace(/\.png$/, '') },
    props: { page },
  }));
}

export const GET: APIRoute = async ({ props }) => {
  const { page } = props as { page: SitePage };
  const png = await ogImage({ title: page.title, description: page.description, kicker: page.kicker });
  return new Response(png, { headers: { 'content-type': 'image/png' } });
};

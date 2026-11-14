/** Markdown twin of the landing page, for agents (served for Accept: text/markdown by the server). */
import type { APIRoute } from 'astro';
import { sitePages } from '../lib/pages.ts';

export const GET: APIRoute = () => {
  const home = sitePages().find((p) => p.url === '/');
  if (!home) throw new Error('The home page is missing from the page list.');
  return new Response(home.twin, { headers: { 'content-type': 'text/markdown; charset=utf-8' } });
};

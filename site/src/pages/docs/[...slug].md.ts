/** Markdown twins of every docs page: /docs/architecture/ has /docs/architecture.md. */
import type { APIRoute } from 'astro';
import { type DocPage, docPages } from '../../lib/docs.ts';

export function getStaticPaths() {
  return docPages()
    .filter((page) => page.slug)
    .map((page) => ({ params: { slug: page.slug }, props: { page } }));
}

export const GET: APIRoute = ({ props }) =>
  new Response((props as { page: DocPage }).page.twin, { headers: { 'content-type': 'text/markdown; charset=utf-8' } });

/** Markdown twin of /docs/. */
import type { APIRoute } from 'astro';
import { docBySlug } from '../lib/docs.ts';

export const GET: APIRoute = () => new Response(docBySlug('').twin, { headers: { 'content-type': 'text/markdown; charset=utf-8' } });

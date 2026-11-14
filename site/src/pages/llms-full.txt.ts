/** The repo's llms-full.txt, unchanged. */
import { readFileSync } from 'node:fs';
import type { APIRoute } from 'astro';
import { repoPath } from '../lib/paths.ts';

export const GET: APIRoute = () =>
  new Response(readFileSync(repoPath('llms-full.txt'), 'utf8'), { headers: { 'content-type': 'text/plain; charset=utf-8' } });

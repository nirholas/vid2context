/** The favicon is the project logo from packages/discovery/assets/logo.svg. */
import { readFileSync } from 'node:fs';
import type { APIRoute } from 'astro';
import { repoPath } from '../lib/paths.ts';

export const GET: APIRoute = () =>
  new Response(readFileSync(repoPath('packages/discovery/assets/logo.svg'), 'utf8'), {
    headers: { 'content-type': 'image/svg+xml' },
  });

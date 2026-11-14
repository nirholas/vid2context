/**
 * The public-domain Apollo 11 clip from tests/fixtures/media, served so the
 * upload example can send a real file without one being copied into site/.
 */
import { readFileSync } from 'node:fs';
import type { APIRoute } from 'astro';
import { APOLLO_SAMPLE } from '../../data/runnables.ts';
import { repoPath } from '../../lib/paths.ts';

export const GET: APIRoute = () =>
  new Response(new Uint8Array(readFileSync(repoPath(APOLLO_SAMPLE.repoPath))), { headers: { 'content-type': 'audio/mpeg' } });

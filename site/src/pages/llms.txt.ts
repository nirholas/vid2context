/**
 * The repo's llms.txt (the source of truth) with a generated `## Docs` section
 * that lists every docs page's Markdown twin.
 */
import { readFileSync } from 'node:fs';
import type { APIRoute } from 'astro';
import { SITE_URL } from '../data/site.ts';
import { docPages, sectionLabel } from '../lib/docs.ts';
import { repoPath } from '../lib/paths.ts';

export const GET: APIRoute = () => {
  const repo = readFileSync(repoPath('llms.txt'), 'utf8').replace(/\s+$/, '');
  const lines = docPages().map((p) => `- [${p.label}](${SITE_URL}${p.twinUrl}): ${sectionLabel(p.section)}. ${p.description}`);
  const body = `${repo}\n\n## Docs\n\nEvery page on ${SITE_URL}/docs/ as Markdown.\n\n${lines.join('\n')}\n`;
  return new Response(body, { headers: { 'content-type': 'text/plain; charset=utf-8' } });
};

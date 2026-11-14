/**
 * The repo's llms.txt (the source of truth) plus every docs page's Markdown
 * twin, listed under `## Docs`: merged into the repo's own Docs section when it
 * has one, else appended as a new section.
 */
import { readFileSync } from 'node:fs';
import type { APIRoute } from 'astro';
import { SITE_URL } from '../data/site.ts';
import { docPages, sectionLabel } from '../lib/docs.ts';
import { repoPath } from '../lib/paths.ts';

export function withDocsSection(repo: string, lines: string[]): string {
  const text = repo.replace(/\s+$/, '');
  const list = lines.join('\n');
  const heading = /^## Docs[ \t]*$/m.exec(text);
  if (!heading) return `${text}\n\n## Docs\n\nEvery page on ${SITE_URL}/docs/ as Markdown.\n\n${list}\n`;
  const after = heading.index + heading[0].length;
  const next = text.slice(after).search(/^## /m);
  const end = next === -1 ? text.length : after + next;
  const section = text.slice(0, end).replace(/\s+$/, '');
  const rest = text.slice(end);
  return `${section}\n${list}\n${rest ? `\n${rest}` : ''}\n`.replace(/\n{3,}/g, '\n\n');
}

export const GET: APIRoute = () => {
  const repo = readFileSync(repoPath('llms.txt'), 'utf8');
  const lines = docPages().map((p) => `- [${p.label}](${SITE_URL}${p.twinUrl}): ${sectionLabel(p.section)}. ${p.description}`);
  return new Response(withDocsSection(repo, lines), { headers: { 'content-type': 'text/plain; charset=utf-8' } });
};

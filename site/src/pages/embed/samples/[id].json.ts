/**
 * The recorded contexts the embed widget can show without an API call
 * (`/embed/?sample=zoo`), served from tests/fixtures/contexts so nothing is
 * copied into site/. The description is dropped: the widget never shows it,
 * and creator descriptions can carry contact details.
 */
import { readFileSync } from 'node:fs';
import type { APIRoute, GetStaticPaths } from 'astro';
import { EMBED_SAMPLES } from '../../../lib/embed.ts';
import { repoPath } from '../../../lib/paths.ts';

export const getStaticPaths: GetStaticPaths = () => EMBED_SAMPLES.map((s) => ({ params: { id: s.id }, props: { file: s.file } }));

export const GET: APIRoute = ({ props }) => {
  const ctx = JSON.parse(readFileSync(repoPath('tests/fixtures/contexts', String(props.file)), 'utf8'));
  delete ctx.metadata.description;
  return new Response(JSON.stringify(ctx), { headers: { 'content-type': 'application/json; charset=utf-8' } });
};

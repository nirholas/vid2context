/** 180x180 PNG rendered from the logo SVG at build time. */
import { readFileSync } from 'node:fs';
import type { APIRoute } from 'astro';
import sharp from 'sharp';
import { repoPath } from '../lib/paths.ts';

export const GET: APIRoute = async () => {
  const svg = readFileSync(repoPath('packages/discovery/assets/logo.svg'), 'utf8');
  // iOS rounds the corners itself and paints transparency black, so fill the square with the logo's own color.
  const background = svg.match(/<rect[^>]*fill="([^"]+)"/)?.[1] ?? '#000000';
  const png = await sharp(Buffer.from(svg), { density: 300 }).resize(180, 180).flatten({ background }).png().toBuffer();
  return new Response(new Uint8Array(png), { headers: { 'content-type': 'image/png' } });
};

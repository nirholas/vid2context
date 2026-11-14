/** 180x180 PNG rendered from the logo SVG at build time. */
import type { APIRoute } from 'astro';
import sharp from 'sharp';
import { repoPath } from '../lib/paths.ts';

export const GET: APIRoute = async () => {
  const png = await sharp(repoPath('packages/discovery/assets/logo.svg'), { density: 300 }).resize(180, 180).png().toBuffer();
  return new Response(new Uint8Array(png), { headers: { 'content-type': 'image/png' } });
};

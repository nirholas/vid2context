/**
 * /embed.js, the loader script for sites that embed vid2context
 * (src/scripts/embed-loader.ts), bundled and minified at build time so it
 * ships as one small classic script with no imports.
 */
import type { APIRoute } from 'astro';
import { build } from 'esbuild';
import { EMBED_PARAMS, EMBED_VIEWS, suggestedHeight } from '../lib/embed.ts';
import { repoPath } from '../lib/paths.ts';

async function bundleLoader(): Promise<string> {
  const heights = Object.fromEntries(EMBED_VIEWS.map((view) => [view, suggestedHeight({ view, player: '0' })]));
  const out = await build({
    // A repo path, not import.meta.url: Astro runs this from a bundled chunk outside src/.
    entryPoints: [repoPath('site/src/scripts/embed-loader.ts')],
    bundle: true,
    write: false,
    minify: true,
    format: 'iife',
    target: 'es2020',
    legalComments: 'none',
    define: {
      __V2C_PARAMS__: JSON.stringify(EMBED_PARAMS.map((p) => p.name)),
      __V2C_HEIGHTS__: JSON.stringify(heights),
    },
  });
  const code = out.outputFiles[0]?.text ?? '';
  return `/* vid2context embed loader. Docs: https://vid2context.com/docs/embed/ */\n${code}`;
}

export const GET: APIRoute = async () =>
  new Response(await bundleLoader(), { headers: { 'content-type': 'text/javascript; charset=utf-8' } });

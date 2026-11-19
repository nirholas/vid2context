/**
 * The GitHub social preview (the card shown when the repository link is shared), rendered with the same layout as
 * the site's Open Graph images so the two never drift:
 *
 *   cd site && npx tsx scripts/social-preview.ts
 *
 * Writes docs/images/social-preview.png at 1280x640, the size GitHub asks for. GitHub has no API for the image:
 * upload it under Settings, General, Social preview.
 */
import { writeFileSync } from 'node:fs';
import { ogImage } from '../src/lib/og.ts';
import { repoPath } from '../src/lib/paths.ts';

const png = await ogImage({
  kicker: 'MCP server, CLI and API',
  title: 'Turn any video into context for AI agents',
  description:
    'Transcripts, captions, chapters and metadata from YouTube, X, podcasts and 1,000+ sites. Free first: no key needed.',
  footer: 'npx vid2context  ·  vid2context.com',
  width: 1280,
  height: 640,
});
const out = repoPath('docs/images/social-preview.png');
writeFileSync(out, png);
console.error(`wrote ${out} (${png.byteLength} bytes)`);

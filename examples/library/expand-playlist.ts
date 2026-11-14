/**
 * Expand a playlist, channel or feed into its videos, then fetch the first
 * few transcripts and combine them into one context pack for a model.
 *
 *   npx tsx examples/library/expand-playlist.ts [playlist-url] [count]
 *
 * Live, no keys needed. Default: a public YouTube playlist, first 3 videos.
 * A video that fails is reported on stderr and the others still go in.
 */
import { estimateTokens, expandInput, getVideoContext, renderMany, type VideoContext } from '@vid2context/core';
import { createNodeContext, createRegistry, loadEnvFiles } from '@vid2context/registry/node';

loadEnvFiles();
const registry = createRegistry();
const ctx = createNodeContext();
const input = process.argv[2] ?? 'https://www.youtube.com/playlist?list=PLHeawKfarQSPKIjpe86at3Ttc2sz7uD_b';
const count = Number(process.argv[3] ?? 3);

const refs = await expandInput(registry, input, ctx, { limit: count });
process.stderr.write(`${refs.length} videos\n`);

const contexts: VideoContext[] = [];
for (const ref of refs) {
  try {
    contexts.push(await getVideoContext(registry, ref.url ?? ref.input, {}, ctx));
    process.stderr.write(`  ok      ${ref.url}\n`);
  } catch (err) {
    process.stderr.write(`  failed  ${ref.url}: ${err instanceof Error ? err.message : String(err)}\n`);
  }
}

// One Markdown document with citation instructions, sized to a token budget.
const pack = renderMany(contexts, 'pack', { maxTokens: 12_000 });
process.stdout.write(pack);
process.stderr.write(`pack: ${contexts.length} videos, about ${estimateTokens(pack)} tokens\n`);

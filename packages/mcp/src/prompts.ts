/**
 * MCP prompts: instructions for the calling agent to read videos with this
 * server's tools and write a cited brief. Synthesis is the agent's job, so
 * these cost the user nothing beyond the agent's own model.
 *
 * @vid2context/insights (item 32) does not export prompt text yet, so the
 * text lives here.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

/** Split a comma, space or newline separated list of URLs. */
export function splitUrls(value: string | undefined): string[] {
  return (value ?? '')
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function sourcesStep(collection: string | undefined, urls: string[]): string {
  if (collection) {
    return `1. Call get_collection { "collection": ${JSON.stringify(collection)} } to see the videos and their token counts.`;
  }
  if (urls.length > 0) {
    return [
      '1. The sources are:',
      ...urls.map((u) => `   - ${u}`),
      '   Playlists, channels and feeds among them: call list_items first to see their videos.',
      '   For many sources, add them all to one collection (create_collection with sources) so you can search them together.',
    ].join('\n');
  }
  return '1. Ask me which videos, playlists or collection to use, then continue.';
}

const READING = `2. Plan your reading from the token counts (speech is about 12k tokens per hour of video):
   - If everything together is well under half of your context, read it whole: export_context_pack (collection or urls) or get_transcript per video.
   - Otherwise read outline first: get_outline for each video, then get_section for the chapters that matter, and search_transcript for the key terms of the question to find passages in videos you have not read.
3. Note the transcript origin in each header. Auto-captions and speech-to-text misspell names, model numbers and jargon: correct obvious ones from context and say when you are unsure.`;

const CITATIONS = `Citation rules (follow them for every claim):
- Cite every factual claim as [Video title @ m:ss](timestamp link). Take the link from the url field of get_outline chapters or search_transcript hits, or build it from the video URL (YouTube: https://www.youtube.com/watch?v=VIDEO_ID&t=SECONDSs).
- The time is where the claim is made, taken from the [m:ss] prefix of the transcript line. Never cite a time you did not read.
- When several videos make the same claim, cite all of them: that is consensus, say so.
- When videos disagree, give each position with its citations and say what might explain the difference (year, model, region, the speaker's incentives).
- A claim made by only one source is labeled as such.
- Never add facts that are not in the sources. If the sources do not answer part of the question, say so.`;

export function briefPrompt(args: { collection?: string; urls?: string; question?: string }): string {
  const urls = splitUrls(args.urls);
  const focus = args.question ? `The brief must answer this question: ${args.question}` : 'Cover the main points of the sources.';
  return [
    'Write a cited brief from video sources, using the vid2context tools.',
    focus,
    '',
    'Steps:',
    sourcesStep(args.collection, urls),
    READING,
    '4. Write the brief:',
    '   - A summary of a few sentences that answers the question.',
    '   - Key findings, grouped by theme, each with citations.',
    '   - Consensus and disagreement: what most sources agree on, and where they differ.',
    '   - Open questions the sources leave unanswered.',
    '   - Sources: each video with title, channel and URL.',
    '',
    CITATIONS,
  ].join('\n');
}

export function buyerGuidePrompt(args: { collection?: string; urls?: string; product: string }): string {
  const urls = splitUrls(args.urls);
  return [
    `Write a buyer guide for ${args.product} from video sources, using the vid2context tools.`,
    '',
    'Steps:',
    sourcesStep(args.collection, urls),
    READING,
    `   Useful searches: "problem", "avoid", "reliable", "cost", "price", "mileage", "recall", "years", and the names of models, engines and generations of ${args.product}.`,
    '4. Write the guide with these sections, leaving out any the sources do not cover:',
    '   - Overview: what the product is and who it suits.',
    '   - Models, generations and years: what changed when.',
    '   - Best and worst years or versions to buy, with the reasons.',
    '   - Known issues: per year, model or engine, with symptoms, how to check for them, and repair costs when given.',
    '   - Prices: purchase prices, running and maintenance costs, with the date or year each figure refers to.',
    '   - Mileage and age: what counts as high, and what to expect at which point.',
    '   - Inspection checklist: what to check before buying.',
    '   - Consensus and disagreement between the sources.',
    '   - Sources: each video with title, channel and URL.',
    '',
    CITATIONS,
    '- Prices and costs date quickly: always say when and where a figure applies, as the video states it.',
  ].join('\n');
}

export function registerPrompts(server: McpServer): void {
  server.registerPrompt(
    'brief',
    {
      title: 'Cited brief from videos',
      description:
        'Instructions to read a collection or a list of videos with the vid2context tools (outline first, sections, search) and write a brief where every claim cites [Title @ m:ss](link), flagging consensus and disagreement.',
      argsSchema: {
        collection: z.string().optional().describe('Collection id or name (see list_collections)'),
        urls: z.string().optional().describe('Video, playlist or channel URLs, separated by commas, spaces or new lines'),
        question: z.string().optional().describe('What the brief should answer'),
      },
    },
    (args) => ({
      description: 'Write a cited brief from video sources',
      messages: [{ role: 'user', content: { type: 'text', text: briefPrompt(args) } }],
    }),
  );

  server.registerPrompt(
    'buyer_guide',
    {
      title: 'Buyer guide from videos',
      description:
        'Instructions to research a product from reviews and owner videos (models, years, known issues, prices, mileage) and write a buyer guide with a timestamp citation for every claim.',
      argsSchema: {
        product: z.string().describe('The product, e.g. "Mercedes G-Class W463"'),
        collection: z.string().optional().describe('Collection id or name holding the videos'),
        urls: z.string().optional().describe('Video, playlist or channel URLs, separated by commas, spaces or new lines'),
      },
    },
    (args) => ({
      description: `Write a cited buyer guide for ${args.product}`,
      messages: [{ role: 'user', content: { type: 'text', text: buyerGuidePrompt(args) } }],
    }),
  );
}

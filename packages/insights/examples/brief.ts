/**
 * A real buyer-guide brief over the G-Wagon series fixtures, LIVE, with the
 * keyless LLM chain (no keys needed: Kilo Code's free gateway, OVH AI
 * Endpoints, Pollinations; free-tier lanes such as Cloudflare Workers AI join
 * when their keys are in the environment).
 *
 *   npx tsx packages/insights/examples/brief.ts [out.json]
 *
 * Prints the Markdown brief to stdout. With a path, also writes the full
 * Brief JSON there. Every link in the brief opens the video at a timestamp
 * whose transcript contains the quoted words: the claims were verified
 * against the transcripts before they were allowed in.
 */
import { writeFileSync } from 'node:fs';
import { createContext, Registry, stderrLogger } from '@vid2context/core';
import freeCatalog from '@vid2context/provider-llm-free-catalog';
import llm from '@vid2context/provider-llm-openai-compatible';
import { buildBrief } from '../src/index.ts';
import { gwagonContexts } from '../test/gwagon.ts';
import { QUESTION } from '../test/scenarios.ts';

const registry = new Registry([freeCatalog, llm], 'node');
const ctx = createContext({ runtime: 'node', env: process.env, log: stderrLogger('info') });

const brief = await buildBrief(
  gwagonContexts(),
  {
    question: QUESTION,
    template: 'buyer-guide',
    onProgress: (p) => console.error(`[brief] ${p.done}/${p.total ?? '?'} ${p.message}`),
  },
  { registry, ctx },
);

process.stdout.write(brief.markdown);
console.error(
  `[brief] ${brief.strategy}: ${brief.claims.length} verified claims, ${brief.unverified.length} unverified, ` +
    `${brief.consensus.length} consensus, ${brief.disagreements.length} disputed; rungs: ${[...new Set(brief.rungs.map((r) => r.rung))].join(', ')}`,
);
const out = process.argv[2];
if (out) writeFileSync(out, `${JSON.stringify(brief, null, 2)}\n`);

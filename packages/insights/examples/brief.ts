/**
 * A real buyer-guide brief over the G-Wagon series fixtures, LIVE, with the
 * keyless LLM chain (no keys: OVH AI Endpoints, then Pollinations).
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
import llm from '@vid2context/provider-llm-openai-compatible';
import { buildBrief } from '../src/index.ts';
import { gwagonContexts } from '../test/recording.ts';
import { QUESTION } from '../test/scenarios.ts';

const registry = new Registry([llm], 'node');
const ctx = createContext({ runtime: 'node', env: {}, log: stderrLogger('info') });

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

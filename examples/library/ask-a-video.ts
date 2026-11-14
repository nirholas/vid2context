/**
 * Ask a question about a video and get an answer whose [n] citations are
 * checked against the transcript: each one maps to a real excerpt with a
 * timestamp link, and numbers that match no excerpt are removed.
 *
 *   npx tsx examples/library/ask-a-video.ts ["your question"]
 *
 * Live, no keys needed: the transcript is a real recorded one, and the
 * answer comes from the free-first LLM chain (a local model or a free key
 * when configured, else the keyless hosts).
 */
import { readFileSync } from 'node:fs';
import { ask } from '@vid2context/ask';
import { formatTimestamp, MemoryStorage, type VideoContext } from '@vid2context/core';
import { createNodeContext, createRegistry, loadEnvFiles } from '@vid2context/registry/node';

loadEnvFiles();
const context: VideoContext = JSON.parse(
  readFileSync(new URL('../../tests/fixtures/contexts/youtube-cCPsdFdlshc.json', import.meta.url), 'utf8'),
);
const question = process.argv[2] ?? 'Which G-Wagon engine do they call the most reliable, and why?';

const result = await ask(
  createRegistry(),
  { question, contexts: [context], storage: new MemoryStorage(), maxTokens: 600 },
  createNodeContext(),
);

process.stdout.write(`Q: ${question}\n\n${result.answer}\n\nCitations:\n`);
for (const c of result.citations) {
  process.stdout.write(`  [${c.n}] ${formatTimestamp(c.startSec)} ${c.url ?? ''}\n      "${c.quote ?? ''}"\n`);
}
if (result.unverified.length)
  process.stdout.write(`Removed citations that matched no excerpt: ${result.unverified.join(', ')}\n`);
process.stdout.write(`\nAnswered by ${result.rung} (${result.sources.length} excerpts sent)\n`);

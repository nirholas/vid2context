/**
 * Find where a topic comes up across several videos: index transcripts, then
 * search with plain words, an exact "phrase" and an -excluded word. Every hit
 * comes back with a time range, a timestamp link and a highlighted snippet.
 *
 *   npx tsx examples/library/search-transcripts.ts
 *
 * Offline: an engine built on a registry with no providers has no embedding
 * model, so it runs BM25 keyword search in memory and never calls the
 * network. Pass createRegistry() from '@vid2context/registry/node' instead to
 * add vector search with the free-first embedding chain.
 */
import { readFileSync } from 'node:fs';
import { createContext, formatTimestamp, Registry, type VideoContext } from '@vid2context/core';
import { createSearchEngine } from '@vid2context/search';

const load = (file: string): VideoContext =>
  JSON.parse(readFileSync(new URL(`../../tests/fixtures/contexts/${file}`, import.meta.url), 'utf8'));

const ctx = createContext({ runtime: 'node' });
const engine = createSearchEngine({ registry: new Registry([], 'node'), ctx });

for (const context of [load('youtube-cCPsdFdlshc.json'), load('youtube-jNQXAC9IVRw.json')]) {
  const r = await engine.index(context);
  process.stdout.write(`indexed ${r.videoId}: ${r.chunks} chunks, vectors ${r.vector}\n`);
}

for (const query of ['timing chain', '"supercharged"', 'engine -oil', 'elephants trunks']) {
  const { hits, meta } = await engine.search({ query, limit: 2 });
  process.stdout.write(`\n${query}  (${meta.keyword.backend}, vectors ${meta.vector}, ${hits.length} hits)\n`);
  for (const h of hits) {
    process.stdout.write(`  ${h.title.slice(0, 40)} [${formatTimestamp(h.startSec)}-${formatTimestamp(h.endSec)}]\n`);
    process.stdout.write(`    ${h.url}\n    ${h.snippet}\n`);
  }
}

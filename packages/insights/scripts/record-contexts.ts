/**
 * Records real VideoContext fixtures for the insights tests, through the same
 * core pipeline the CLI uses (`getVideoContext`), with only the YouTube
 * provider loaded. Used instead of `npm run cli` while the shared generated
 * registry was broken by another package's unfinished work.
 *
 *   npx tsx packages/insights/scripts/record-contexts.ts list <playlist url>
 *   npx tsx packages/insights/scripts/record-contexts.ts get <video url>...
 *
 * Writes packages/insights/test/fixtures/contexts/youtube-<id>.json. Review
 * descriptions for personal details before committing.
 */
import { writeFileSync } from 'node:fs';
import { createContext, expandInput, getVideoContext, Registry } from '@vid2context/core';
import youtube from '@vid2context/provider-youtube';

const [cmd, ...inputs] = process.argv.slice(2);
const registry = new Registry(youtube, 'node');
const ctx = createContext({ runtime: 'node', env: {} });
const dir = new URL('../test/fixtures/contexts/', import.meta.url);

if (cmd === 'list') {
  for (const input of inputs) {
    for (const ref of await expandInput(registry, input, ctx, { limit: 50 })) console.error(ref.url ?? ref.id);
  }
} else if (cmd === 'get') {
  for (const input of inputs) {
    const c = await getVideoContext(registry, input, { mode: 'captions' }, ctx);
    const file = new URL(`youtube-${c.metadata.ref.nativeId}.json`, dir);
    writeFileSync(file, `${JSON.stringify(c, null, 2)}\n`);
    console.error(`${c.metadata.ref.nativeId}  ${c.metadata.title}  ${c.transcript.origin} ${c.transcript.segments.length} segments`);
  }
} else {
  console.error('usage: record-contexts.ts list <playlist url> | get <video url>...');
  process.exitCode = 2;
}

/**
 * Re-record the LLM fixtures for the chapters tests from the real keyless
 * rungs (OVH for titles, Pollinations for titles with summaries). Run from the repo root:
 *
 *   LIVE=1 node_modules/.bin/tsx packages/chapters/scripts/record.ts [titles|summaries]
 *
 * Writes test/fixtures/llm-titles-NNN.json (titles only) and
 * test/fixtures/llm-summaries-NNN.json (titles and summaries), scrubbed by
 * the testkit recorder. Document any change in test/fixtures/README.md.
 */
import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { clearCooldowns, createContext, Registry, type VideoContext } from '@vid2context/core';
import llm from '@vid2context/provider-llm-openai-compatible';
import { recordingFetch } from '@vid2context/testkit/recorder';
import { autoChapters } from '../src/index.ts';

if (!process.env.LIVE) {
  console.error('Set LIVE=1 to call the real service.');
  process.exit(1);
}

const dir = join(import.meta.dirname, '..', 'test', 'fixtures');
const context = JSON.parse(
  readFileSync(join(import.meta.dirname, '..', '..', '..', 'tests', 'fixtures', 'contexts', 'youtube-cCPsdFdlshc.json'), 'utf8'),
) as VideoContext;
const clear = (name: string): void => {
  for (let i = 1; i <= 9; i++) rmSync(join(dir, `${name}-${String(i).padStart(3, '0')}.json`), { force: true });
};

// Which recording to make: `titles` (OVH) or `summaries` (Pollinations). Default: both.
const which = process.argv[2];
for (const [name, summaries, service] of [
  ['llm-titles', false, 'ovh'],
  ['llm-summaries', true, 'pollinations'],
] as const) {
  if (which && !name.endsWith(which)) continue;
  // The keyless lane allows one reply per 45 s per IP: wait and retry when it says so.
  for (let round = 1; round <= 6; round++) {
    clear(name);
    clearCooldowns();
    if (round > 1) await new Promise((r) => setTimeout(r, 50_000));
    const fetch = recordingFetch(globalThis.fetch, { dir, name });
    const ctx = createContext({ runtime: 'node', env: {}, fetch });
    const registry = new Registry([llm], 'node');
    const res = await autoChapters(registry, context, { summaries, chain: { only: [service] } }, ctx);
    console.error(`${name} round ${round}: ${res.method} by ${res.producer}; files ${fetch.files.join(', ')}`);
    if (res.method === 'texttiling+llm') {
      console.error(JSON.stringify({ chapters: res.chapters, notes: res.notes }, null, 2));
      break;
    }
  }
}

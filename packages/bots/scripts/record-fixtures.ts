/**
 * Record the LLM summary fixture once, from the real keyless chain:
 *
 *   LIVE=1 npm run -w packages/bots record
 *
 * The transcript is the shared real VideoContext in
 * tests/fixtures/contexts/youtube-cCPsdFdlshc.json, the same one the route
 * tests rebuild from the recorded YouTube responses, so the request matches
 * what they send. Only the chat completion goes to the network, with no API
 * key (env is empty, so the keyless OVH rung answers first).
 * Writes test/fixtures/llm-summary-cCPsdFdlshc.json.
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createContext, Registry, type VideoContext } from '@vid2context/core';
import llm from '@vid2context/provider-llm-openai-compatible';
import { summarize } from '../src/summary.ts';
import { FIXTURES, readRepo } from '../test/util.ts';

const VIDEO_ID = 'cCPsdFdlshc';
const OUT = `llm-summary-${VIDEO_ID}.json`;

if (!process.env.LIVE) {
  console.error('Set LIVE=1 to call the real LLM service.');
  process.exit(2);
}

const context = JSON.parse(readRepo(`tests/fixtures/contexts/youtube-${VIDEO_ID}.json`)) as VideoContext;

let captured: { url: string; request: unknown; status: number; response: unknown } | undefined;
const recording: typeof fetch = async (input, init) => {
  const res = await fetch(input, init);
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  if (url.endsWith('/chat/completions') && res.ok) {
    captured = { url, request: JSON.parse(String(init?.body)), status: res.status, response: await res.clone().json() };
  }
  return res;
};
const live = createContext({ runtime: 'node', env: {}, fetch: recording });
const summary = await summarize(new Registry([llm], 'node'), context, live);
if (!captured) throw new Error('No successful chat completion was captured.');

writeFileSync(
  join(FIXTURES, OUT),
  `${JSON.stringify({ recordedAt: new Date().toISOString(), rung: summary.rung, ...captured }, null, 2)}\n`,
);
console.error(`Recorded ${OUT} from ${summary.rung}: ${summary.bullets.length} valid bullets.`);
for (const b of summary.bullets) console.error(`  - ${b.text} ${b.times.join(', ')}`);

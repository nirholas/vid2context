/**
 * Record the LLM summary fixture once, from the real keyless chain:
 *
 *   LIVE=1 npm run -w packages/bots record
 *
 * The transcript comes from the recorded YouTube fixtures (so the request is
 * exactly what the route tests send); only the chat completion goes to the
 * network, with no API key (env is empty, so the keyless OVH rung answers).
 * Writes test/fixtures/llm-summary-cCPsdFdlshc.json.
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createContext, getVideoContext } from '@vid2context/core';
import { replayFetch } from '@vid2context/core/testing';
import { summarize } from '../src/summary.ts';
import { FIXTURES, LLM_FIXTURE, type LlmRecording, testRegistry, VIDEO_URL, youtubeRoutes } from '../test/helpers.ts';

if (!process.env.LIVE) {
  console.error('Set LIVE=1 to call the real LLM service.');
  process.exit(2);
}

const registry = testRegistry();
const replayed = createContext({ runtime: 'node', env: {}, fetch: replayFetch(youtubeRoutes()) });
const context = await getVideoContext(registry, VIDEO_URL, { mode: 'auto' }, replayed);

let captured: Omit<LlmRecording, 'recordedAt' | 'rung'> | undefined;
const recording: typeof fetch = async (input, init) => {
  const res = await fetch(input, init);
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  if (url.endsWith('/chat/completions') && res.ok) {
    const text = await res.clone().text();
    captured = { url, request: JSON.parse(String(init?.body)), status: res.status, response: JSON.parse(text) };
  }
  return res;
};
const live = createContext({ runtime: 'node', env: {}, fetch: recording });
const summary = await summarize(registry, context, live);
if (!captured) throw new Error('No successful chat completion was captured.');

const out: LlmRecording = { recordedAt: new Date().toISOString(), rung: summary.rung, ...captured };
writeFileSync(join(FIXTURES, LLM_FIXTURE), `${JSON.stringify(out, null, 2)}\n`);
console.error(`Recorded ${LLM_FIXTURE} from ${summary.rung}: ${summary.bullets.length} valid bullets.`);
for (const b of summary.bullets) console.error(`  - ${b.text} ${b.times.join(', ')}`);

/**
 * Records real LLM exchanges for the insights tests, LIVE, from the keyless
 * chain only (no keys: OVH AI Endpoints, then Pollinations), and saves them to
 * packages/insights/test/fixtures/llm/<scenario>.json.
 *
 *   npx tsx packages/insights/scripts/record-llm.ts <scenario>
 *
 * Scenarios:
 *   brief-single      buildBrief over the four G-Wagon fixtures, buyer-guide template (one pass)
 *   brief-map-reduce  buildBrief over two of them with a 2500-token chunk cap (map per chunk, then reduce)
 *   extract-buyer     extract with the buyer-guide template over the four fixtures
 *   extract-repair    extract with a strict custom schema (short strings, few items) that models tend to break
 *
 * Every response is stored as the service sent it. Nothing is written by hand.
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createContext, Registry, stderrLogger, type VideoContext } from '@vid2context/core';
import llm from '@vid2context/provider-llm-openai-compatible';
import { buildBrief, extract } from '../src/index.ts';
import type { Exchange, Recording } from '../test/recording.ts';
import { gwagonContext } from '../test/recording.ts';
import { SCENARIOS } from '../test/scenarios.ts';

const scenario = process.argv[2] ?? '';
if (!(scenario in SCENARIOS)) {
  console.error(`usage: record-llm.ts <${Object.keys(SCENARIOS).join('|')}>`);
  process.exit(2);
}

const exchanges: Exchange[] = [];
const started = Date.now();
const recordingFetch: typeof fetch = async (input, init) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  const atMs = Date.now() - started;
  let model: string | undefined;
  try {
    model = (JSON.parse(String(init?.body)) as { model?: string }).model;
  } catch {
    model = undefined;
  }
  const res = await globalThis.fetch(input, init);
  const body = await res.text();
  exchanges.push({
    atMs,
    url,
    method: (init?.method ?? 'GET').toUpperCase(),
    ...(model ? { model } : {}),
    status: res.status,
    ...(res.headers.get('content-type') ? { contentType: res.headers.get('content-type') as string } : {}),
    ...(res.headers.get('retry-after') ? { retryAfter: res.headers.get('retry-after') as string } : {}),
    body,
  });
  console.error(
    `[record] ${res.status} ${model ?? ''} ${url} (${body.length} bytes, ${Math.round((Date.now() - started - atMs) / 1000)} s)`,
  );
  return new Response(body, { status: res.status, headers: res.headers });
};

const registry = new Registry([llm], 'node');
const ctx = createContext({ runtime: 'node', env: {}, fetch: recordingFetch, log: stderrLogger('info') });
const s = SCENARIOS[scenario as keyof typeof SCENARIOS];
const contexts: VideoContext[] = s.videos.map((i) => gwagonContext(i));

let result: unknown;
try {
  if (s.kind === 'brief') result = await buildBrief(contexts, s.options, { registry, ctx });
  else
    result = await extract(contexts, s.kind === 'extract-repair' ? { schema: REPAIR_SCHEMA, ...s.options } : s.options, {
      registry,
      ctx,
    });
} catch (err) {
  console.error('[record] run failed:', err);
}

const rec: Recording = {
  scenario,
  recordedAt: new Date(started).toISOString(),
  note: 'Recorded LIVE with packages/insights/scripts/record-llm.ts from the keyless chain (no keys). Responses are verbatim.',
  exchanges,
};
const file = join(import.meta.dirname, '../test/fixtures/llm', `${scenario}.json`);
writeFileSync(file, `${JSON.stringify(rec, null, 2)}\n`);
console.error(`[record] wrote ${exchanges.length} exchanges to ${file}`);
if (result) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);

/**
 * Records the LLM fixtures for the ask tests from the real keyless rungs (OVH
 * AI Endpoints and Pollinations), no key sent, env empty so only keyless rungs
 * run. Run once with network:
 *
 *   npx tsx packages/ask/test/record-fixtures.ts [scenario ...]
 *
 * Each scenario is saved as test/fixtures/<scenario>.json with every request
 * the engine made, in order: URL, model, status, the content-type and
 * retry-after headers, and the body. Nothing else from the response is kept.
 */
import { writeFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { clearCooldowns, type Ctx, createContext, type Storage } from '@vid2context/core';
import { ask } from '../src/engine.ts';
import { askRoutes } from '../src/http.ts';
import { GWAGON_URL, makeRegistry, makeStorage, type RecordedExchange, type Recording } from './helpers.ts';

const KEEP_HEADERS = ['content-type', 'retry-after'];

function recorder(calls: RecordedExchange[]): typeof fetch {
  return async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const res = await globalThis.fetch(input, init);
    const body = await res.text();
    let model = '';
    try {
      model = (JSON.parse(String(init?.body)) as { model?: string }).model ?? '';
    } catch {
      model = '';
    }
    const headers: Record<string, string> = {};
    for (const h of KEEP_HEADERS) {
      const v = res.headers.get(h);
      if (v) headers[h] = v;
    }
    calls.push({ url, model, status: res.status, headers, body });
    return new Response(body, { status: res.status, headers });
  };
}

function ctxFor(calls: RecordedExchange[], env: Record<string, string> = {}): Ctx {
  return createContext({ runtime: 'node', env, fetch: recorder(calls) });
}

const registry = makeRegistry();

type Scenario = { notes: string; run: (ctx: Ctx, storage: Storage, collectionId: string) => Promise<unknown>; env?: Record<string, string> };

const scenarios: Record<string, Scenario> = {
  'gwagon-g55': {
    notes: 'ask() over the G-Wagon video, whole transcript fits: "How much horsepower does the G55 AMG compressor engine make, and does it have any known issues?"',
    run: (ctx, storage) =>
      ask(registry, { question: 'How much horsepower does the G55 AMG compressor engine make, and does it have any known issues?', inputs: [GWAGON_URL], storage }, ctx),
  },
  'gwagon-offtopic': {
    notes: 'ask() over the G-Wagon video with a question it does not cover: "What is the towing capacity of the electric G580?"',
    run: (ctx, storage) => ask(registry, { question: 'What is the towing capacity of the electric G580?', inputs: [GWAGON_URL], storage }, ctx),
  },
  'gwagon-followup': {
    notes:
      'ask() follow-up in chunked mode (maxSourceTokens 1200): history "Which engine does the 2000 G500 use?" / "It uses the M113 V8.", question "How much power does it make?". First call condenses, second answers.',
    run: (ctx, storage) =>
      ask(
        registry,
        {
          question: 'How much power does it make?',
          history: [
            { role: 'user', content: 'Which engine does the 2000 G500 use?' },
            { role: 'assistant', content: 'It uses the M113 V8 [2].' },
          ],
          inputs: [GWAGON_URL],
          storage,
          maxSourceTokens: 1200,
        },
        ctx,
      ),
  },
  'collection-na-offroad': {
    notes:
      'ask() over a collection of both shared videos, chunked mode (maxSourceTokens 1500): "Why did they pick a naturally aspirated G550 for an off-road build instead of a biturbo?"',
    run: (ctx, storage, collectionId) =>
      ask(
        registry,
        { question: 'Why did they pick a naturally aspirated G550 for an off-road build instead of a biturbo?', collectionId, storage, maxSourceTokens: 1500 },
        ctx,
      ),
  },
  'chat-sse-designo': {
    notes: 'POST /chat through askRoutes on a bare Hono app, question "Which years have the designo seats?" over the G-Wagon video.',
    run: async (ctx, storage) => {
      const app = askRoutes({ registry, makeCtx: () => ctx, storage: async () => storage });
      const res = await app.request('/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ messages: [{ role: 'user', content: 'Which years have the designo seats?' }], context: { inputs: [GWAGON_URL] } }),
      });
      return res.text();
    },
  },
  'strict-429': {
    notes:
      'Rate limited on purpose: the OVH Llama rung was called repeatedly until it answered 429, then ask() with model { rung: llm/ovh/Meta-Llama-3_3-70B-Instruct, strict: false } fell back. The same 429 serves the strict test.',
    run: async (ctx, storage) => {
      await hammer('Meta-Llama-3_3-70B-Instruct');
      return ask(
        registry,
        { question: 'What does the 2000 G500 interior look like?', inputs: [GWAGON_URL], storage, model: { rung: 'llm/ovh/Meta-Llama-3_3-70B-Instruct' } },
        ctx,
      );
    },
  },
  'all-429': {
    notes:
      'Both OVH rungs called repeatedly until they answered 429, Pollinations skipped by env (VID2CONTEXT_SKIP=pollinations), then ask() over the G-Wagon video: every rung fails.',
    env: { VID2CONTEXT_SKIP: 'pollinations' },
    run: async (ctx, storage) => {
      await Promise.all([hammer('Meta-Llama-3_3-70B-Instruct'), hammer('gpt-oss-120b')]);
      return ask(registry, { question: 'Which years have timing chains?', inputs: [GWAGON_URL], storage }, ctx).catch((e: unknown) => ({
        error: e instanceof Error ? e.message : String(e),
      }));
    },
  },
};

/** Call one OVH model until it answers 429 (at most 12 tries). These calls are not recorded. */
async function hammer(model: string): Promise<void> {
  for (let i = 0; i < 12; i++) {
    const res = await globalThis.fetch('https://oai.endpoints.kepler.ai.cloud.ovh.net/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model, messages: [{ role: 'user', content: 'Say OK.' }], max_tokens: 5 }),
    });
    await res.text();
    console.error(`hammer ${model}: ${res.status}`);
    if (res.status === 429) return;
  }
}

const wanted = process.argv.slice(2);
const names = wanted.length > 0 ? wanted : Object.keys(scenarios);
for (const [i, name] of names.entries()) {
  const s = scenarios[name];
  if (!s) throw new Error(`unknown scenario ${name}`);
  if (i > 0) await sleep(65_000); // OVH allows about 2 requests per minute per model per IP.
  clearCooldowns();
  const calls: RecordedExchange[] = [];
  const { storage, collection } = await makeStorage();
  const result = await s.run(ctxFor(calls, s.env), storage, collection.id);
  const rec: Recording = { scenario: name, recordedAt: new Date().toISOString(), notes: s.notes, calls };
  writeFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), `${JSON.stringify(rec, null, 2)}\n`);
  console.error(`\n== ${name}: ${calls.map((c) => `${c.model}=${c.status}`).join(', ')}`);
  console.error(typeof result === 'string' ? result : JSON.stringify(result, null, 2));
}

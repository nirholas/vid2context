/**
 * Records the real responses the search tests replay:
 *
 *   test/fixtures/embeddings-ovh-bge-m3.json  every embedding request the engine makes
 *     while indexing the two shared contexts and running each evaluation query
 *     (keyless OVH bge-m3, base64 float32)
 *   test/fixtures/embeddings-ovh-gemma2-zoo.json  the zoo chunks embedded with a second
 *     model (bge-multilingual-gemma2), for the model-change test
 *   test/fixtures/rerank-ovh.json             one rerank chat call through the real
 *     llm-openai-compatible provider (keyless lanes only, no key needed)
 *
 * Run: npx tsx packages/search/scripts/record-fixtures.ts [--embeddings] [--second-model] [--rerank]
 * (all three when no flag is given). OVH keyless allows about 2 requests per minute
 * per model, so the script waits out 429s; a full run takes 10 to 15 minutes.
 * Re-run after changing the chunker or the evaluation queries.
 */
import { writeFileSync } from 'node:fs';
import { createContext, MemoryStorage, stderrLogger } from '@vid2context/core';
import { replayFetch } from '@vid2context/core/testing';
import llmProvider from '@vid2context/provider-llm-openai-compatible';
import { createSearchEngine } from '../src/engine.ts';
import {
  EMBED_FIXTURE,
  type EmbedFixture,
  embedProvider,
  embedRoute,
  GWAGON,
  loadContext,
  loadEmbedFixture,
  loadQueries,
  OVH_EMBED_URL,
  ovhEmbedRung,
  type RecordedEmbedCall,
  registryWith,
  SECOND_FIXTURE,
  SECOND_MODEL,
  ZOO,
} from '../test/helpers.ts';

const args = new Set(process.argv.slice(2));
const all = !args.has('--embeddings') && !args.has('--second-model') && !args.has('--rerank');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A fetch that waits out 429s and keeps every successful exchange for the given URL. */
function recordingFetch(
  match: (url: string) => boolean,
  onOk: (url: string, body: string, status: number, text: string) => void,
) {
  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    for (let attempt = 1; ; attempt++) {
      const res = await fetch(input, init);
      if (res.status === 429 && attempt < 30) {
        const wait = (Number(res.headers.get('retry-after')) || 30) + 2;
        console.error(`429 from ${new URL(url).host}, waiting ${wait}s (attempt ${attempt})`);
        await res.body?.cancel();
        await sleep(wait * 1000);
        continue;
      }
      const text = await res.text();
      if (res.ok && match(url)) onOk(url, String(init?.body ?? ''), res.status, text);
      return new Response(text, { status: res.status, headers: res.headers });
    }
  };
}

function embedRecorder(calls: RecordedEmbedCall[]): typeof fetch {
  const seen = new Set<string>();
  return recordingFetch(
    (u) => u === OVH_EMBED_URL,
    (_u, body, status, text) => {
      const input = (JSON.parse(body) as { input: string[] }).input;
      const key = JSON.stringify(input);
      if (seen.has(key)) return;
      seen.add(key);
      calls.push({ input, status, body: text });
      console.error(`recorded embeddings for ${input.length} texts`);
    },
  ) as typeof fetch;
}

async function recordEmbeddings(): Promise<void> {
  const calls: RecordedEmbedCall[] = [];
  const fetchImpl = embedRecorder(calls);
  const ctx = createContext({ runtime: 'node', env: {}, fetch: fetchImpl, log: stderrLogger('info') });
  const registry = registryWith([embedProvider([ovhEmbedRung()])]);
  const engine = createSearchEngine({ registry, storage: new MemoryStorage(), ctx });
  for (const file of [GWAGON, ZOO]) {
    const res = await engine.index(loadContext(file));
    if (res.vector !== 'indexed') throw new Error(`indexing ${file} failed: ${res.reason}`);
  }
  for (const q of loadQueries()) {
    const res = await engine.search({ query: q.query, mode: 'vector' });
    if (res.meta.vector !== 'ok') throw new Error(`query ${q.id}: vector ${res.meta.vector}: ${res.meta.vectorReason}`);
  }
  const fixture: EmbedFixture = {
    endpoint: OVH_EMBED_URL,
    model: 'bge-m3',
    encoding: 'base64',
    recordedAt: new Date().toISOString(),
    calls,
  };
  writeFileSync(EMBED_FIXTURE, `${JSON.stringify(fixture, null, 1)}\n`);
  console.error(`wrote ${calls.length} calls to ${EMBED_FIXTURE.pathname}`);
}

async function recordSecondModel(): Promise<void> {
  const calls: RecordedEmbedCall[] = [];
  const ctx = createContext({ runtime: 'node', env: {}, fetch: embedRecorder(calls), log: stderrLogger('info') });
  const registry = registryWith([embedProvider([ovhEmbedRung(SECOND_MODEL)])]);
  const engine = createSearchEngine({ registry, ctx });
  const res = await engine.index(loadContext(ZOO));
  if (res.vector !== 'indexed') throw new Error(`indexing the zoo video with ${SECOND_MODEL} failed: ${res.reason}`);
  const fixture: EmbedFixture = {
    endpoint: OVH_EMBED_URL,
    model: SECOND_MODEL,
    encoding: 'base64',
    recordedAt: new Date().toISOString(),
    calls,
  };
  writeFileSync(SECOND_FIXTURE, `${JSON.stringify(fixture, null, 1)}\n`);
  console.error(`wrote ${calls.length} calls to ${SECOND_FIXTURE.pathname}`);
}

const RERANK_QUERY = 'does the engine use a cam chain or a belt';

async function recordRerank(): Promise<void> {
  const recorded: { url: string; model: string; status: number; body: string }[] = [];
  const fetchImpl = recordingFetch(
    (u) => u.includes('/chat/completions') || u.includes('pollinations'),
    (url, body, status, text) => {
      const model = (JSON.parse(body) as { model: string }).model;
      recorded.push({ url, model, status, body: text });
      console.error(`recorded chat response from ${model}`);
    },
  ) as typeof fetch;
  // Embeddings come from the fixture just recorded, so only the chat call goes out.
  const replay = replayFetch([embedRoute(loadEmbedFixture())]);
  const both: typeof fetch = (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    return url === OVH_EMBED_URL ? replay(input, init) : fetchImpl(input, init);
  };
  const ctx = createContext({ runtime: 'node', env: {}, fetch: both, log: stderrLogger('info') });
  const registry = registryWith([embedProvider([ovhEmbedRung()]), ...[llmProvider].flat()]);
  const engine = createSearchEngine({ registry, storage: new MemoryStorage(), ctx });
  for (const file of [GWAGON, ZOO]) await engine.index(loadContext(file));
  const res = await engine.search({ query: RERANK_QUERY, rerank: true });
  if (res.meta.rerank !== 'ok') throw new Error(`rerank failed: ${res.meta.rerankReason}`);
  const last = recorded.at(-1);
  if (!last) throw new Error('no chat response recorded');
  const file = new URL('../test/fixtures/rerank-ovh.json', import.meta.url);
  const out = {
    recordedAt: new Date().toISOString(),
    query: RERANK_QUERY,
    rung: res.meta.rerankRung,
    ...last,
  };
  writeFileSync(file, `${JSON.stringify(out, null, 1)}\n`);
  console.error(`wrote rerank response from ${res.meta.rerankRung} to ${file.pathname}`);
}

if (all || args.has('--embeddings')) await recordEmbeddings();
if (all || args.has('--second-model')) await recordSecondModel();
if (all || args.has('--rerank')) await recordRerank();

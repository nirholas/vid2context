/**
 * Records the chat completions behind the replayed digest test.
 *
 *   npx tsx packages/mcp-agentic/test/record-fixtures.ts
 *
 * Runs digest_videos exactly as the unit test does (the two shared fixture
 * contexts, RECORDED_MAX_TOKENS, QUESTION) with the client's sampling handler
 * on the real keyless LLM chain, and saves every successful chat completion
 * with the messages that produced it to test/fixtures/. No key is sent.
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createContext } from '@vid2context/core';
import {
  chainSampler,
  connect,
  FIXTURES,
  filledStorage,
  GWAGON,
  QUESTION,
  RECORDED_MAX_TOKENS,
  type RecordedExchange,
  recordedAnswer,
  resultText,
  SAMPLING_FIXTURE,
  testRegistry,
  ZOO,
} from './helpers.ts';

const exchanges: RecordedExchange[] = [];

const recordingFetch: typeof fetch = async (input, init) => {
  const res = await fetch(input, init);
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  const sent = init?.body
    ? (JSON.parse(String(init.body)) as { model: string; messages: RecordedExchange['messages']; max_tokens?: number })
    : undefined;
  const body = await res.clone().text();
  console.error(`[record] ${res.status} ${url} ${sent?.model ?? ''}`);
  if (res.ok && sent) {
    const ex: RecordedExchange = {
      url,
      model: sent.model,
      messages: sent.messages,
      maxTokens: sent.max_tokens,
      status: res.status,
      body,
    };
    // Keep only answers the chain accepts (an empty answer makes it move to the next rung).
    let answer = '';
    try {
      answer = recordedAnswer(ex);
    } catch {
      answer = '';
    }
    if (answer) exchanges.push(ex);
  }
  return res;
};

const registry = testRegistry();
// Keyless lanes only: an empty env, never process.env, so no key can leak into the fixture.
const chainCtx = createContext({ runtime: 'node', env: {}, fetch: recordingFetch });
const serverCtx = createContext({
  runtime: 'node',
  env: {},
  fetch: () => Promise.reject(new Error('the server side needs no network here')),
});

const h = await connect({
  registry,
  ctx: serverCtx,
  storage: await filledStorage(),
  capabilities: { sampling: {} },
  sampling: chainSampler(registry, chainCtx, { retries: 6 }),
});
const res = await h.client.callTool(
  { name: 'digest_videos', arguments: { urls: [ZOO, GWAGON], question: QUESTION, maxTokensPerVideo: RECORDED_MAX_TOKENS } },
  undefined,
  { timeout: 30 * 60 * 1000 },
);
await h.close();

const out = resultText(res);
console.error(out);
if ((res as { isError?: boolean }).isError) throw new Error('digest failed; nothing recorded');

writeFileSync(
  join(FIXTURES, SAMPLING_FIXTURE),
  `${JSON.stringify(
    {
      recordedAt: new Date().toISOString(),
      note: 'Chat completions from the keyless OVH and Pollinations lanes (no key) for the sampling requests digest_videos sends, recorded by test/record-fixtures.ts.',
      exchanges,
    },
    null,
    2,
  )}\n`,
);
console.error(`[record] wrote ${exchanges.length} exchanges to ${SAMPLING_FIXTURE}`);

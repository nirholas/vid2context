/**
 * Record real responses for the chat tests by running the client-only engine
 * (localChat over the browser registry) against live services with a fetch
 * that keeps a copy of every response. Each case saves:
 *   - the raw upstream responses, replayed in tests with replayFetch, and
 *   - the ChatEvents the engine emitted, as the reference for UI tests.
 *
 *   npx tsx packages/chat/scripts/record-fixtures.ts
 *
 * Cases:
 *   ovh-gpt-oss     keyless OVH gpt-oss-120b, strict, grounded in the real
 *                   cCPsdFdlshc transcript fixture: streaming with reasoning
 *   groq-bad-key    Groq, strict, with a deliberately invalid key: a real 401
 *                   and the error event with its attempts
 *
 * No real key is used or stored. Review the files before committing.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { createContext, type VideoContext } from '@vid2context/core';
import { createRegistry } from '@vid2context/registry/browser';
import { localChat } from '../src/lib/local-engine.ts';
import type { ChatApiRequest, ChatEvent } from '../src/lib/types.ts';

const fixtures = new URL('../test/fixtures/', import.meta.url);
const context = JSON.parse(
  readFileSync(new URL('../../../tests/fixtures/contexts/youtube-cCPsdFdlshc.json', import.meta.url), 'utf8'),
) as VideoContext;

interface Recorded {
  url: string;
  method: string;
  status: number;
  headers: Record<string, string>;
  body: string;
}

function teeFetch(log: Recorded[]): typeof fetch {
  return async (input, init) => {
    const res = await fetch(input, init);
    const body = await res.text();
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const headers: Record<string, string> = {};
    for (const k of ['content-type', 'retry-after']) {
      const v = res.headers.get(k);
      if (v) headers[k] = v;
    }
    log.push({ url, method: init?.method ?? 'GET', status: res.status, headers, body });
    return new Response(body, { status: res.status, headers: res.headers });
  };
}

async function record(name: string, env: Record<string, string>, request: ChatApiRequest) {
  const responses: Recorded[] = [];
  const ctx = createContext({ runtime: 'browser', env, fetch: teeFetch(responses) });
  const events: ChatEvent[] = [];
  for await (const ev of localChat({ registry: createRegistry(), ctx, request, contexts: [context] })) events.push(ev);
  const out = { recordedAt: new Date().toISOString(), case: name, env: Object.keys(env), request, responses, events };
  writeFileSync(new URL(`client-${name}.json`, fixtures), `${JSON.stringify(out, null, 2)}\n`);
  const last = events[events.length - 1];
  console.error(`${name}: ${responses.length} responses, ${events.length} events, last ${last?.type}`);
}

const question = 'Which engine does the 2000 G500 have, and why do the hosts call it reliable? Cite the moments.';
await record('ovh-gpt-oss', {}, { messages: [{ role: 'user', content: question }], model: { rung: 'llm/ovh/gpt-oss-120b', strict: true } });
await record(
  'groq-bad-key',
  { GROQ_API_KEY: 'invalid-key-for-fixture' },
  { messages: [{ role: 'user', content: question }], model: { rung: 'llm/groq/openai/gpt-oss-120b', strict: true } },
);

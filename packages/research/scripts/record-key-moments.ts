/**
 * Record the real keyless LLM chain answering keyMoments() for the shared
 * G-Wagon transcript, so unit tests can replay it without the network.
 *
 *   npx tsx packages/research/scripts/record-key-moments.ts [chunkTokens] [count]
 *
 * Runs with an empty env, so only keyless rungs are enabled and no key is
 * ever sent or written. Only LLM calls are recorded (the transcript comes from
 * tests/fixtures/contexts). Writes
 * packages/research/test/fixtures/key-moments-cCPsdFdlshc[-chunked].json.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createContext, MemoryStorage, Registry, type VideoContext } from '@vid2context/core';
import llm from '@vid2context/provider-llm-openai-compatible';
import youtube from '@vid2context/provider-youtube';
import { keyMoments } from '../src/moments.ts';

const root = join(import.meta.dirname, '../../..');
const chunkTokens = process.argv[2] ? Number(process.argv[2]) : undefined;
const count = process.argv[3] ? Number(process.argv[3]) : 8;
const context = JSON.parse(readFileSync(join(root, 'tests/fixtures/contexts/youtube-cCPsdFdlshc.json'), 'utf8')) as VideoContext;

interface Call {
  url: string;
  model: string;
  status: number;
  request: unknown;
  response: string;
}
const calls: Call[] = [];

const recording = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  const res = await fetch(input, init);
  if (typeof init?.body === 'string' && (url.endsWith('/chat/completions') || url.endsWith('/openai'))) {
    const request = JSON.parse(String(init?.body)) as { model?: string };
    const body = await res.clone().text();
    calls.push({ url, model: request.model ?? '', status: res.status, request, response: body });
  }
  return res;
};

const storage = new MemoryStorage();
await storage.putContext(context);
const registry = new Registry([...youtube, llm], 'node');
const ctx = createContext({ runtime: 'node', env: {}, fetch: recording as typeof fetch });
const result = await keyMoments(context.metadata.ref.url ?? '', { count, chunkTokens }, { registry, ctx, storage });

const name = `key-moments-${context.metadata.ref.nativeId}${chunkTokens ? '-chunked' : ''}.json`;
const out = {
  recordedAt: new Date().toISOString(),
  options: { count, ...(chunkTokens ? { chunkTokens } : {}) },
  rung: result.rung,
  calls,
};
writeFileSync(join(import.meta.dirname, '../test/fixtures', name), `${JSON.stringify(out, null, 2)}\n`);
console.error(
  `wrote ${name}: ${calls.length} calls, rung ${result.rung}, ${result.moments.length} moments, ${result.dropped} dropped`,
);
for (const m of result.moments) console.error(`${m.timestamp} ${m.title}`);

/**
 * Re-record the long-transcript Ollama fixtures through this package's own
 * client, so the request body is exactly what the rung sends.
 *
 *   OLLAMA_BASE_URL=http://127.0.0.1:11434 OLLAMA_MODEL=qwen2.5:0.5b npx tsx providers/llm-local/test/record.ts
 *
 * Writes test/fixtures/ollama-chat-long-transcript.{request,response}.json.
 * The other fixtures were recorded with curl (see test/fixtures/README.md).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createContext } from '@vid2context/core';
import { ollamaChat } from '../src/ollama.ts';
import { normalizeOllamaBase } from '../src/servers.ts';
import { longTranscriptRequest } from './long-transcript.ts';

const dir = join(import.meta.dirname, 'fixtures');
const base = normalizeOllamaBase(process.env.OLLAMA_BASE_URL);
const model = process.env.OLLAMA_MODEL?.split(',')[0]?.trim() || 'qwen2.5:0.5b';

let request = '';
let response = '';
const ctx = createContext({
  runtime: 'node',
  env: {},
  fetch: async (input, init) => {
    const res = await fetch(input, init);
    if (String(input).endsWith('/api/chat')) {
      request = String(init?.body);
      response = await res.clone().text();
    }
    return res;
  },
});

const result = await ollamaChat({ base, model }, longTranscriptRequest(), ctx);
writeFileSync(join(dir, 'ollama-chat-long-transcript.request.json'), `${JSON.stringify(JSON.parse(request), null, 2)}\n`);
writeFileSync(join(dir, 'ollama-chat-long-transcript.response.json'), response);
console.error(`${model}: ${result.usage?.inputTokens} prompt tokens evaluated. Answer: ${result.text}`);

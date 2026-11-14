/**
 * Live tests against servers running on this machine. Gated by LIVE=1 and by
 * the env that points at each server:
 *
 *   LIVE=1 OLLAMA_MODEL=qwen2.5:3b [OLLAMA_BASE_URL=...] npx vitest run providers/llm-local
 *   LIVE=1 LLAMACPP_MODEL=<id> [LLAMACPP_BASE_URL=...] npx vitest run providers/llm-local
 */
import { chat, createContext, Registry } from '@vid2context/core';
import { describe, expect, it } from 'vitest';
import { detectLocalServers } from '../src/detection.ts';
import provider, { localRungs } from '../src/index.ts';
import { collect } from './helpers.ts';
import { longTranscriptRequest } from './long-transcript.ts';

const env = process.env as Record<string, string>;
const live = (v: string) => !process.env.LIVE || !process.env[v];

describe.skipIf(live('OLLAMA_MODEL'))('Ollama, live', () => {
  const ctx = () => createContext({ runtime: 'node', env: { ...env, VID2CONTEXT_POLICY: 'local-only' } });

  it('answers about both ends of an 18-minute transcript under local-only (nothing truncated)', async () => {
    const registry = new Registry([provider], 'node');
    const res = await chat(registry, longTranscriptRequest(), { only: ['ollama'] }, ctx());
    expect(res.rung.startsWith('llm/ollama/')).toBe(true);
    // Ollama evaluated the whole prompt: about 4,600 tokens, not the 2,050 its default window keeps.
    expect(res.usage?.inputTokens).toBeGreaterThan(4000);
    console.error(`${res.rung}: ${res.usage?.inputTokens} prompt tokens. ${res.text}`);
    expect(res.text).toMatch(/Adam/);
    expect(res.text).toMatch(/G500|G 500|2000|early 2000s/i);
  }, 600_000);

  it('streams', async () => {
    const rung = localRungs(env).find((r) => r.service === 'ollama' && r.model);
    if (!rung) throw new Error('no Ollama rung');
    const events = await collect(
      rung.stream({ messages: [{ role: 'user', content: 'Say hello in three words.' }], maxTokens: 20 }, ctx()),
    );
    expect(events.at(-1)?.type).toBe('done');
  }, 120_000);

  it('detects the server', async () => {
    const r = await detectLocalServers(ctx());
    expect(r.servers.some((s) => s.kind === 'ollama' && s.models.length > 0)).toBe(true);
  });
});

describe.skipIf(live('LLAMACPP_MODEL'))('llama.cpp server, live', () => {
  it('chats and streams', async () => {
    const ctx = createContext({ runtime: 'node', env });
    const rung = localRungs(env).find((r) => r.service === 'llamacpp' && r.model);
    if (!rung) throw new Error('no llama.cpp rung');
    const req = {
      messages: [{ role: 'user' as const, content: 'Which year did Apollo 11 land on the moon? Answer in one short sentence.' }],
      maxTokens: 64,
      temperature: 0,
    };
    expect((await rung.chat(req, ctx)).text).toContain('1969');
    const events = await collect(rung.stream(req, ctx));
    expect(events.at(-1)?.type).toBe('done');
  }, 120_000);
});

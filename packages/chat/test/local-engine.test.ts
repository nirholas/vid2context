import { clearCooldowns } from '@vid2context/core';
import { replayFetch, testContext } from '@vid2context/core/testing';
import { createRegistry } from '@vid2context/registry/browser';
import { beforeEach, describe, expect, it } from 'vitest';
import { blockedRungIds, chainOptions, hintFor, localChat } from '../src/lib/local-engine.ts';
import { buildGrounding, excerptsOf } from '../src/lib/sources.ts';
import type { ChatEvent } from '../src/lib/types.ts';
import { clientRecording, routesFor, sharedContext } from './helpers.ts';

const registry = createRegistry();
const video = sharedContext('cCPsdFdlshc');

async function run(opts: Parameters<typeof localChat>[0]): Promise<ChatEvent[]> {
  const out: ChatEvent[] = [];
  for await (const ev of localChat(opts)) out.push(ev);
  return out;
}

beforeEach(() => clearCooldowns());

describe('client-only engine, replaying a real OVH gpt-oss stream', () => {
  const rec = clientRecording('ovh-gpt-oss');
  const ctxFor = (fetch: typeof globalThis.fetch) => testContext({ env: {}, fetch, runtime: 'browser' });

  it('emits meta, reasoning, deltas and done exactly as recorded', async () => {
    const fetch = replayFetch(routesFor(rec));
    const events = await run({ registry, ctx: ctxFor(fetch), request: rec.request, contexts: [video] });
    expect(events.map((e) => e.type)).toEqual(rec.events.map((e) => e.type));
    const done = events.at(-1) as Extract<ChatEvent, { type: 'done' }>;
    const recorded = rec.events.at(-1) as Extract<ChatEvent, { type: 'done' }>;
    expect(done.text).toBe(recorded.text);
    expect(done.citations).toEqual(recorded.citations);
    expect(done.rung).toBe('llm/ovh/gpt-oss-120b');
  });

  it('never mixes reasoning into the answer', async () => {
    const fetch = replayFetch(routesFor(rec));
    const events = await run({ registry, ctx: ctxFor(fetch), request: rec.request, contexts: [video] });
    const answer = events
      .filter((e) => e.type === 'delta')
      .map((e) => (e as { text: string }).text)
      .join('');
    const reasoning = events
      .filter((e) => e.type === 'reasoning')
      .map((e) => (e as { text: string }).text)
      .join('');
    expect(reasoning.length).toBeGreaterThan(50);
    expect(answer).not.toContain(reasoning.slice(0, 40));
  });

  it('sends the transcript excerpts as the system message and numbers them as meta.sources', async () => {
    const fetch = replayFetch(routesFor(rec));
    const events = await run({ registry, ctx: ctxFor(fetch), request: rec.request, contexts: [video] });
    const meta = events[0] as Extract<ChatEvent, { type: 'meta' }>;
    expect(meta.sources.length).toBe(excerptsOf(video).length);
    const body = JSON.parse(String(fetch.calls[0]?.body)) as { messages: { role: string; content: string }[] };
    expect(body.messages[0]?.role).toBe('system');
    expect(body.messages[0]?.content).toContain('[2] Best & Worst G-Wagon Years');
    expect(body.messages.at(-1)?.content).toBe(rec.request.messages[0]?.content);
  });

  it('skips services that block browsers: Auto never calls Kilo', async () => {
    const fetch = replayFetch(routesFor(rec));
    const { model: _model, ...auto } = rec.request;
    const events = await run({ registry, ctx: ctxFor(fetch), request: auto, contexts: [video] });
    expect(fetch.calls.every((c) => !c.url.includes('kilo.ai'))).toBe(true);
    expect(fetch.calls[0]?.url).toContain('ovh.net');
    expect(events.at(-1)?.type).toBe('done');
    expect(blockedRungIds(registry.llmRungs({}))).toContain('llm/kilo/nvidia/nemotron-3.5-lightning:free');
  });

  it('refuses a strict pick of a blocked service before any request', async () => {
    const fetch = replayFetch([]);
    const ctx = ctxFor(fetch);
    const req = { ...rec.request, model: { rung: 'llm/cerebras/gpt-oss-120b', strict: true } };
    expect(() => chainOptions(registry, req, ctx)).toThrow(/cannot be called from a web page/);
    const events = await run({ registry, ctx, request: req, contexts: [video] });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'error', code: 'bad-request' });
    expect(fetch.calls).toHaveLength(0);
  });
});

describe('client-only engine, replaying a real Groq 401', () => {
  const rec = clientRecording('groq-bad-key');

  it('ends with an error that carries the attempt and an actionable hint', async () => {
    const fetch = replayFetch(routesFor(rec));
    const env = { GROQ_API_KEY: 'invalid-key-for-fixture' };
    const events = await run({
      registry,
      ctx: testContext({ env, fetch, runtime: 'browser' }),
      request: rec.request,
      contexts: [video],
    });
    expect(events).toHaveLength(1);
    const err = events[0] as Extract<ChatEvent, { type: 'error' }>;
    expect(err.code).toBe('all-rungs-failed');
    expect(err.attempts?.[0]).toMatchObject({ id: 'llm/groq/openai/gpt-oss-120b', outcome: 'error', reason: 'auth-401' });
    expect(err.hint).toMatch(/rejected the key/);
  });

  it('picks the hint from what the attempts say', () => {
    const limited = hintFor('all-rungs-failed', undefined, [
      { id: 'x', stage: 'llm', outcome: 'error', reason: 'rate-limited-429' },
    ]);
    expect(limited.hint).toMatch(/Rate-limited/);
    expect(hintFor('no-provider', undefined).hint).toMatch(/Add a free key/);
    expect(hintFor('upstream', 'from the server').hint).toBe('from the server');
  });
});

describe('grounding budget', () => {
  it('keeps every excerpt when it fits and spreads the cut when it does not', () => {
    const all = buildGrounding([video], 100_000);
    expect(all.omitted).toBe(0);
    const tight = buildGrounding([video], 1500);
    expect(tight.omitted).toBeGreaterThan(0);
    expect(tight.tokens).toBeLessThanOrEqual(1800);
    const ns = tight.sources.map((s) => s.n);
    expect(ns[0]).toBe(1);
    expect(Math.max(...ns)).toBeGreaterThan(all.sources.length / 2);
    expect(tight.system).toMatch(/excerpts were left out/);
  });
});

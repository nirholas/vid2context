import llmOpenAiCompatible from '@vid2context/provider-llm-openai-compatible';
import { beforeEach, describe, expect, it } from 'vitest';
import { attemptsOf, clearCooldowns } from '../../src/chain.ts';
import { resolveModelChoice } from '../../src/llm/choice.ts';
import { type ChainStreamEvent, chatStream } from '../../src/llm/stream.ts';
import { Registry } from '../../src/registry.ts';
import { replayFetch, testContext } from '../../src/testing.ts';
import { recording, response } from './fixtures.ts';

// The foundation's real llm provider. With no keys its enabled rungs are the
// keyless lanes, in order: OVH Llama, OVH gpt-oss-120b, Pollinations.
const registry = new Registry([llmOpenAiCompatible], 'node');
const question = {
  messages: [{ role: 'user' as const, content: 'Which year did Apollo 11 land on the moon? Answer in one short sentence.' }],
  maxTokens: 300,
};

const rate429 = recording('ovh-llama-3.3-70b.stream.http429');
const gptOss = recording('ovh-gpt-oss-120b.stream');
const llama = recording('ovh-llama-3.3-70b.stream');
const pollinations = recording('pollinations-openai-fast.stream');

/** Serve recordings by the model named in the request body. */
function byModel(map: Record<string, ReturnType<typeof response>>) {
  return replayFetch([
    {
      method: 'POST',
      url: () => true,
      response: (call) => {
        const model = JSON.parse(String(call.body)).model as string;
        const rec = map[model];
        if (!rec) throw new Error(`no recording for model ${model}`);
        return rec;
      },
    },
  ]);
}

async function collect(it: AsyncIterable<ChainStreamEvent>): Promise<ChainStreamEvent[]> {
  const out: ChainStreamEvent[] = [];
  for await (const e of it) out.push(e);
  return out;
}

beforeEach(() => clearCooldowns());

describe('chatStream', () => {
  it('falls back past a 429 before the first token, names the answering rung in meta and cools the failed rung down', async () => {
    const fetch = byModel({ 'Meta-Llama-3_3-70B-Instruct': response(rate429), 'gpt-oss-120b': response(gptOss) });
    const events = await collect(chatStream(registry, question, {}, testContext({ fetch })));

    expect(events[0]).toEqual({ type: 'meta', rung: 'llm/ovh/gpt-oss-120b', model: 'gpt-oss-120b', contextTokens: 131_072 });
    expect(events.filter((e) => e.type === 'meta')).toHaveLength(1);
    const done = events.at(-1);
    if (done?.type !== 'done') throw new Error('no done event');
    expect(done.rung).toBe('llm/ovh/gpt-oss-120b');
    expect(done.result.text).toContain('1969');
    expect(done.attempts.map((a) => [a.id, a.outcome, a.reason])).toEqual([
      ['llm/ovh/Meta-Llama-3_3-70B-Instruct', 'error', 'rate-limited-429'],
      ['llm/ovh/gpt-oss-120b', 'ok', undefined],
    ]);

    // The 429 put the rung on cooldown (shared with chat()), so the next request skips it without calling it.
    const again = byModel({ 'gpt-oss-120b': response(gptOss) });
    const next = await collect(chatStream(registry, question, {}, testContext({ fetch: again })));
    const nextDone = next.at(-1);
    if (nextDone?.type !== 'done') throw new Error('no done event');
    expect(nextDone.attempts[0]).toMatchObject({
      id: 'llm/ovh/Meta-Llama-3_3-70B-Instruct',
      outcome: 'skipped',
      reason: 'cooldown',
    });
    expect(again.calls).toHaveLength(1);
  });

  it('streams reasoning before deltas and ends with one done', async () => {
    const fetch = byModel({ 'Meta-Llama-3_3-70B-Instruct': response(rate429), 'gpt-oss-120b': response(gptOss) });
    const events = await collect(chatStream(registry, question, {}, testContext({ fetch })));
    const kinds = events.map((e) => e.type);
    expect(kinds[0]).toBe('meta');
    expect(kinds[1]).toBe('reasoning');
    expect(kinds.indexOf('delta')).toBeGreaterThan(kinds.lastIndexOf('reasoning'));
    expect(kinds.filter((k) => k === 'done')).toHaveLength(1);
  });

  it('never switches rungs after the first delta: a stream cut mid-answer ends with an error carrying the attempts', async () => {
    const raw = new TextDecoder().decode(llama.body);
    const cut = new TextEncoder().encode(raw.slice(0, raw.indexOf('"content":" ') + 200));
    const fetch = byModel({ 'Meta-Llama-3_3-70B-Instruct': response(llama, cut), 'gpt-oss-120b': response(gptOss) });
    const events: ChainStreamEvent[] = [];
    let error: unknown;
    try {
      for await (const e of chatStream(registry, question, {}, testContext({ fetch }))) events.push(e);
    } catch (err) {
      error = err;
    }
    expect(error).toMatchObject({ code: 'upstream' });
    expect(events.some((e) => e.type === 'delta')).toBe(true);
    expect(events.filter((e) => e.type === 'meta')).toHaveLength(1);
    expect(fetch.calls).toHaveLength(1);
    expect(attemptsOf(error)).toEqual([
      expect.objectContaining({ id: 'llm/ovh/Meta-Llama-3_3-70B-Instruct', outcome: 'error', reason: 'upstream' }),
    ]);
  });

  it('throws all-rungs-failed with every attempt when nothing answers', async () => {
    const fetch = byModel({});
    const ctx = testContext({ fetch });
    await expect(collect(chatStream(registry, question, {}, ctx))).rejects.toMatchObject({ code: 'all-rungs-failed' });
    try {
      await collect(chatStream(registry, question, {}, ctx));
    } catch (err) {
      expect(attemptsOf(err).map((a) => a.id)).toEqual([
        'llm/ovh/Meta-Llama-3_3-70B-Instruct',
        'llm/ovh/gpt-oss-120b',
        'llm/pollinations/openai-fast',
      ]);
    }
  });

  it('throws no-provider when nothing is enabled', async () => {
    const ctx = testContext({ env: { VID2CONTEXT_KEYLESS: '0' } });
    await expect(collect(chatStream(registry, question, {}, ctx))).rejects.toMatchObject({ code: 'no-provider' });
  });
});

describe('model choice in chatStream', () => {
  it('a non-strict choice starts with that rung', async () => {
    const fetch = byModel({ 'openai-fast': response(pollinations) });
    const chain = resolveModelChoice({ rung: 'llm/pollinations/openai-fast' }, registry, {});
    expect(chain).toEqual({ prefer: ['llm/pollinations/openai-fast'] });
    const events = await collect(chatStream(registry, question, chain, testContext({ fetch })));
    expect(events[0]).toMatchObject({ type: 'meta', rung: 'llm/pollinations/openai-fast' });
    expect(events.at(-1)).toMatchObject({ type: 'done', rung: 'llm/pollinations/openai-fast' });
  });

  it('a non-strict choice falls back along the normal order when it fails', async () => {
    const fetch = byModel({ 'gpt-oss-120b': response(rate429), 'Meta-Llama-3_3-70B-Instruct': response(llama) });
    const chain = resolveModelChoice({ rung: 'llm/ovh/gpt-oss-120b' }, registry, {});
    const events = await collect(chatStream(registry, question, chain, testContext({ fetch })));
    const done = events.at(-1);
    if (done?.type !== 'done') throw new Error('no done event');
    expect(done.attempts.map((a) => [a.id, a.outcome])).toEqual([
      ['llm/ovh/gpt-oss-120b', 'error'],
      ['llm/ovh/Meta-Llama-3_3-70B-Instruct', 'ok'],
    ]);
  });

  it('a strict choice is that rung or an error', async () => {
    const fetch = byModel({ 'gpt-oss-120b': response(rate429), 'Meta-Llama-3_3-70B-Instruct': response(llama) });
    const chain = resolveModelChoice({ rung: 'llm/ovh/gpt-oss-120b', strict: true }, registry, {});
    expect(chain).toEqual({ only: ['llm/ovh/gpt-oss-120b'] });
    await expect(collect(chatStream(registry, question, chain, testContext({ fetch })))).rejects.toMatchObject({
      code: 'all-rungs-failed',
    });
    expect(fetch.calls).toHaveLength(1);
  });
});

describe('resolveModelChoice', () => {
  it('nothing means Auto, a policy maps to policy', () => {
    expect(resolveModelChoice(undefined, registry, {})).toEqual({});
    expect(resolveModelChoice({ policy: 'quality' }, registry, {})).toEqual({ policy: 'quality' });
  });

  it('rejects unknown rungs and policies with a hint to call /models', () => {
    expect(() => resolveModelChoice({ rung: 'llm/nowhere/model' }, registry, {})).toThrow(
      expect.objectContaining({ code: 'bad-request', hint: expect.stringContaining('/models') }),
    );
    expect(() => resolveModelChoice({ policy: 'cheapest' as 'free' }, registry, {})).toThrow(
      expect.objectContaining({ code: 'bad-request' }),
    );
  });

  it('rejects a strict choice of a disabled rung, naming the env var (not its value)', () => {
    expect(() => resolveModelChoice({ rung: 'llm/groq/openai/gpt-oss-120b', strict: true }, registry, {})).toThrow(
      expect.objectContaining({ code: 'bad-request', hint: expect.stringContaining('GROQ_API_KEY') }),
    );
    // Non-strict is allowed: the chain notes it is not eligible and falls back.
    expect(resolveModelChoice({ rung: 'llm/groq/openai/gpt-oss-120b' }, registry, {})).toEqual({
      prefer: ['llm/groq/openai/gpt-oss-120b'],
    });
  });
});

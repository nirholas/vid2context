import { readFileSync } from 'node:fs';
import { type ChatStreamEvent, type Ctx, type Env, streamFromRung, Vid2ContextError } from '@vid2context/core';
import { replayFetch, testContext } from '@vid2context/core/testing';
import { describe, expect, it } from 'vitest';
import providers, {
  type AiBinding,
  embedRungs,
  embedTexts,
  errorFromBinding,
  llmRungs,
  mapCloudflareCode,
  parseSse,
  REST_BASE_URL,
  sttRungs,
} from '../src/index.ts';

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const apollo = new Uint8Array(readFileSync(new URL('../../../tests/fixtures/media/apollo11-small-step.mp3', import.meta.url)));
const audio = { kind: 'bytes' as const, data: apollo, mimeType: 'audio/mpeg', filename: 'apollo11-small-step.mp3' };

const ACCOUNT = '0123456789abcdef0123456789abcdef';
const REST_ENV: Env = { CLOUDFLARE_ACCOUNT_ID: ACCOUNT, CLOUDFLARE_API_TOKEN: 'cf-test-token' };
const BINDING_ENV: Env = { CLOUDFLARE_AI_BINDING: 'AI' };
const runUrl = (model: string) => `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/ai/run/${model}`;

function rungById<T extends { id: string }>(rungs: T[], id: string): T {
  const r = rungs.find((x) => x.id === id);
  if (!r) throw new Error(`no rung ${id}: ${rungs.map((x) => x.id).join(', ')}`);
  return r;
}

/**
 * Workers AI has no local engine, so binding rungs are tested through an
 * adapter: an AI binding whose run() replays the REST response recorded for
 * the same model and returns its `result`, which is what env.AI.run returns.
 * The binding call path itself is verified live in wrangler dev (live.test.ts).
 */
function replayBinding(responses: Record<string, string>): AiBinding & { inputs: { model: string; inputs: unknown }[] } {
  const inputs: { model: string; inputs: unknown }[] = [];
  return {
    inputs,
    async run(model: string, body: unknown) {
      inputs.push({ model, inputs: body });
      const recorded = responses[model];
      if (recorded === undefined) throw new Error(`no recording for ${model}`);
      if ((body as { stream?: boolean }).stream) {
        return new Response(recorded).body as ReadableStream<Uint8Array>;
      }
      return (JSON.parse(recorded) as { result: unknown }).result;
    },
  };
}

function bindingCtx(ai: AiBinding, env: Env = BINDING_ENV): Ctx {
  return { ...testContext({ env, runtime: 'workers' }), bindings: { AI: ai } };
}

describe('rung lists', () => {
  it('declares three providers with distinct ids for every runtime', () => {
    expect(providers.map((p) => p.id)).toEqual(['cloudflare-ai-stt', 'cloudflare-ai-llm', 'cloudflare-ai-embed']);
    for (const p of providers) expect(p.runtimes).toEqual(['node', 'workers', 'browser']);
  });

  it('lists every rung disabled when nothing is configured', () => {
    const all = [...sttRungs({}), ...llmRungs({}), ...embedRungs({})];
    expect(all.map((r) => r.id)).toEqual([
      'stt/cloudflare-binding/@cf/openai/whisper-large-v3-turbo',
      'stt/cloudflare-binding/@cf/openai/whisper',
      'stt/cloudflare/@cf/openai/whisper-large-v3-turbo',
      'stt/cloudflare/@cf/openai/whisper',
      'llm/cloudflare-binding/@cf/meta/llama-3.3-70b-instruct-fp8-fast',
      'llm/cloudflare-binding/@cf/openai/gpt-oss-120b',
      'llm/cloudflare-binding/@cf/meta/llama-4-scout-17b-16e-instruct',
      'llm/cloudflare-binding/@cf/mistralai/mistral-small-3.1-24b-instruct',
      'embed/cloudflare-binding/@cf/baai/bge-m3',
    ]);
    for (const r of all) {
      expect(r.tier).toBe('free');
      expect(r.isEnabled?.({})).toBe(false);
    }
  });

  it('enables binding rungs with CLOUDFLARE_AI_BINDING and REST rungs with the account id and token', () => {
    const binding = [...sttRungs(BINDING_ENV), ...llmRungs(BINDING_ENV), ...embedRungs(BINDING_ENV)];
    for (const r of binding) expect(r.isEnabled?.(BINDING_ENV)).toBe(r.service === 'cloudflare-binding');
    const rest = [...sttRungs(REST_ENV), ...embedRungs(REST_ENV)];
    expect(embedRungs(REST_ENV).every((r) => r.isEnabled?.(REST_ENV) === false)).toBe(true);
    for (const r of rest) expect(r.isEnabled?.(REST_ENV)).toBe(r.service === 'cloudflare');
    expect(rungById(sttRungs(REST_ENV), 'stt/cloudflare/@cf/openai/whisper').requires).toEqual([
      'CLOUDFLARE_ACCOUNT_ID',
      'CLOUDFLARE_API_TOKEN',
    ]);
  });

  it('marks JSON mode only on models verified with a recording, and streaming on every binding LLM', () => {
    const caps = Object.fromEntries(llmRungs(BINDING_ENV).map((r) => [r.model, r.capabilities]));
    expect(caps['@cf/meta/llama-3.3-70b-instruct-fp8-fast']).toEqual(['json', 'stream']);
    expect(caps['@cf/mistralai/mistral-small-3.1-24b-instruct']).toEqual(['stream']);
  });

  it('takes model lists from env', () => {
    const env = {
      ...BINDING_ENV,
      CLOUDFLARE_STT_MODEL: '@cf/openai/whisper',
      CLOUDFLARE_BINDING_MODEL: '@cf/qwen/qwen3.8-27b, @cf/openai/gpt-oss-20b',
    };
    expect(sttRungs(env).map((r) => r.id)).toEqual([
      'stt/cloudflare-binding/@cf/openai/whisper',
      'stt/cloudflare/@cf/openai/whisper',
    ]);
    const llm = llmRungs(env);
    expect(llm.map((r) => r.model)).toEqual(['@cf/qwen/qwen3.8-27b', '@cf/openai/gpt-oss-20b']);
    expect(llm[0]?.capabilities).toEqual(['stream']);
  });

  it('needs CLOUDFLARE_EMBED_DIMENSIONS for an embedding model whose size it does not know', () => {
    const env = { ...BINDING_ENV, CLOUDFLARE_EMBED_MODEL: '@cf/qwen/qwen3-embedding-0.6b' };
    const [binding] = embedRungs(env);
    expect(binding?.requires).toContain('CLOUDFLARE_EMBED_DIMENSIONS');
    expect(binding?.isEnabled?.(env)).toBe(false);
    const sized = { ...env, CLOUDFLARE_EMBED_DIMENSIONS: '1024' };
    expect(embedRungs(sized)[0]?.isEnabled?.(sized)).toBe(true);
    expect(embedRungs(sized)[0]?.dimensions).toBe(1024);
  });
});

describe('REST speech-to-text', () => {
  it('sends base64 audio to whisper-large-v3-turbo and maps its segments and language', async () => {
    const model = '@cf/openai/whisper-large-v3-turbo';
    const fetch = replayFetch([
      { method: 'POST', url: runUrl(model), response: { body: fixture('whisper-large-v3-turbo.apollo.json') } },
    ]);
    const rung = rungById(sttRungs(REST_ENV), `stt/cloudflare/${model}`);
    const res = await rung.transcribe(audio, {}, testContext({ fetch, env: REST_ENV }));
    expect(res.language).toBe('en');
    expect(res.model).toBe(model);
    expect(res.segments).toEqual([
      { startSec: 3.3600000000000017, endSec: 5.16, text: "I'm going to step off the limb now." },
      { startSec: 15.100000000000001, endSec: 23.04, text: "That's one small step for man, one giant leap for mankind." },
    ]);
    const call = fetch.calls[0];
    expect(call?.headers.authorization).toBe('Bearer cf-test-token');
    expect(call?.headers['content-type']).toBe('application/json');
    const body = JSON.parse(String(call?.body)) as { audio: string };
    expect(body.audio).toBe(Buffer.from(apollo).toString('base64'));
  });

  it('passes language and prompt hints to whisper-large-v3-turbo', async () => {
    const model = '@cf/openai/whisper-large-v3-turbo';
    const fetch = replayFetch([
      { method: 'POST', url: runUrl(model), response: { body: fixture('whisper-large-v3-turbo.apollo.json') } },
    ]);
    const rung = rungById(sttRungs(REST_ENV), `stt/cloudflare/${model}`);
    await rung.transcribe(audio, { language: 'en-US', prompt: 'Apollo 11' }, testContext({ fetch, env: REST_ENV }));
    const body = JSON.parse(String(fetch.calls[0]?.body)) as Record<string, unknown>;
    expect(body.language).toBe('en');
    expect(body.initial_prompt).toBe('Apollo 11');
  });

  it('sends raw bytes to the legacy whisper model and rebuilds segments from its words', async () => {
    const model = '@cf/openai/whisper';
    const fetch = replayFetch([{ method: 'POST', url: runUrl(model), response: { body: fixture('whisper.apollo.json') } }]);
    const rung = rungById(sttRungs(REST_ENV), `stt/cloudflare/${model}`);
    const res = await rung.transcribe(audio, { language: 'en' }, testContext({ fetch, env: REST_ENV }));
    const call = fetch.calls[0];
    expect(call?.headers['content-type']).toBe('audio/mpeg');
    expect(new Uint8Array(call?.body as Uint8Array)).toEqual(apollo);
    expect(res.language).toBe('en');
    expect(res.segments.map((s) => s.text)).toEqual([
      'Have no step off the land now.',
      "It's one small step for man, one by a lead for man, time.",
    ]);
    expect(res.segments[0]?.startSec).toBe(0);
    expect(res.segments.at(-1)?.endSec).toBe(23.94);
  });

  it('downloads URL audio through ctx.fetch first', async () => {
    const model = '@cf/openai/whisper-large-v3-turbo';
    const fetch = replayFetch([
      {
        method: 'GET',
        url: 'https://example.org/apollo.mp3',
        response: { body: apollo, headers: { 'content-type': 'audio/mpeg' } },
      },
      { method: 'POST', url: runUrl(model), response: { body: fixture('whisper-large-v3-turbo.apollo.json') } },
    ]);
    const rung = rungById(sttRungs(REST_ENV), `stt/cloudflare/${model}`);
    const res = await rung.transcribe(
      { kind: 'url', url: 'https://example.org/apollo.mp3' },
      {},
      testContext({ fetch, env: REST_ENV }),
    );
    expect(res.segments).toHaveLength(2);
  });
});

describe('REST errors', () => {
  const model = '@cf/openai/whisper-large-v3-turbo';
  const run = async (status: number, body: string) => {
    const fetch = replayFetch([{ method: 'POST', url: runUrl(model), response: { status, body } }]);
    const rung = rungById(sttRungs(REST_ENV), `stt/cloudflare/${model}`);
    return rung.transcribe(audio, {}, testContext({ fetch, env: REST_ENV })).catch((e: unknown) => e);
  };

  it('maps a rejected token (10000) to auth with a hint', async () => {
    const err = (await run(401, fixture('error-bad-token.json'))) as Vid2ContextError;
    expect(err).toBeInstanceOf(Vid2ContextError);
    expect(err.code).toBe('auth');
    expect(err.hint).toMatch(/CLOUDFLARE_API_TOKEN/);
  });

  it('maps an unknown model route (7000) to not-found with a hint', async () => {
    const err = (await run(400, fixture('error-model-not-found.json'))) as Vid2ContextError;
    expect(err.code).toBe('not-found');
    expect(err.hint).toMatch(/CLOUDFLARE_STT_MODEL/);
  });

  it('maps undecodable audio (3030) to upstream so the next rung is tried', async () => {
    const err = (await run(400, fixture('error-bad-input.json'))) as Vid2ContextError;
    expect(err.code).toBe('upstream');
    expect(err.hint).toMatch(/decode/);
  });

  it('maps the error a real AI binding throws for an unknown model (5007) to not-found', () => {
    const err = errorFromBinding('cloudflare-binding x', new Error(fixture('binding-error-unknown-model.txt')));
    expect(err.code).toBe('not-found');
    expect(err.message).toBe('cloudflare-binding x: 5007: No such model @cf/openai/whisper-does-not-exist or task');
  });

  it('maps the daily free allocation (3036) to rate-limited until 00:00 UTC', () => {
    const m = mapCloudflareCode(3036);
    expect(m?.code).toBe('rate-limited');
    expect(m?.retryAfterSec).toBeGreaterThan(0);
    expect(m?.retryAfterSec).toBeLessThanOrEqual(86_400);
  });
});

describe('REST embeddings', () => {
  it('embeds with bge-m3 over REST and returns 1024-dimension vectors', async () => {
    const model = '@cf/baai/bge-m3';
    const fetch = replayFetch([{ method: 'POST', url: runUrl(model), response: { body: fixture('bge-m3.embed.json') } }]);
    const t = { kind: 'rest' as const, accountId: ACCOUNT, token: 'cf-test-token', baseUrl: REST_BASE_URL };
    const texts = [
      'That is one small step for man, one giant leap for mankind.',
      'All right, so here we are in front of the elephants.',
    ];
    const vectors = await embedTexts(t, model, texts, testContext({ fetch }), 'cloudflare');
    expect(vectors).toHaveLength(2);
    for (const v of vectors) expect(v).toHaveLength(1024);
    expect((JSON.parse(String(fetch.calls[0]?.body)) as { text: string[] }).text).toEqual(texts);
  });

  it('leaves the REST embedding rung to providers/embed so rung ids never collide', () => {
    expect(embedRungs({ ...REST_ENV, ...BINDING_ENV }).map((r) => r.id)).toEqual(['embed/cloudflare-binding/@cf/baai/bge-m3']);
  });
});

describe('binding rungs', () => {
  it('fails with a hint when the AI binding is missing', async () => {
    const rung = rungById(llmRungs(BINDING_ENV), 'llm/cloudflare-binding/@cf/meta/llama-3.3-70b-instruct-fp8-fast');
    const err = (await rung
      .chat({ messages: [{ role: 'user', content: 'hi' }] }, testContext({ env: BINDING_ENV, runtime: 'workers' }))
      .catch((e: unknown) => e)) as Vid2ContextError;
    expect(err.code).toBe('no-provider');
    expect(err.hint).toMatch(/"ai": \{ "binding": "AI" \}/);
  });

  it('transcribes through the binding with base64 audio for turbo and a byte array for legacy whisper', async () => {
    const ai = replayBinding({
      '@cf/openai/whisper-large-v3-turbo': fixture('whisper-large-v3-turbo.apollo.json'),
      '@cf/openai/whisper': fixture('whisper.apollo.json'),
    });
    const [turbo, legacy] = sttRungs(BINDING_ENV);
    const a = await turbo?.transcribe(audio, {}, bindingCtx(ai));
    const b = await legacy?.transcribe(audio, {}, bindingCtx(ai));
    expect(a?.segments.at(-1)?.text).toBe("That's one small step for man, one giant leap for mankind.");
    expect(b?.segments).toHaveLength(2);
    expect(((ai.inputs[0]?.inputs ?? {}) as { audio: string }).audio).toBe(Buffer.from(apollo).toString('base64'));
    expect(((ai.inputs[1]?.inputs ?? {}) as { audio: number[] }).audio).toEqual(Array.from(apollo));
  });

  const messages = [
    { role: 'system' as const, content: 'You answer in one short sentence.' },
    { role: 'user' as const, content: 'Who said "one small step for man" and in which year?' },
  ];
  const jsonMessages = [
    { role: 'system' as const, content: 'Reply with a JSON object only.' },
    {
      role: 'user' as const,
      content: 'Give the speaker and year of the quote "one small step for man" as {"speaker": string, "year": number}.',
    },
  ];
  const models: [string, string][] = [
    ['@cf/meta/llama-3.3-70b-instruct-fp8-fast', 'llama-3.3-70b'],
    ['@cf/openai/gpt-oss-120b', 'gpt-oss-120b'],
    ['@cf/meta/llama-4-scout-17b-16e-instruct', 'llama-4-scout'],
    ['@cf/mistralai/mistral-small-3.1-24b-instruct', 'mistral-small-3.1'],
  ];

  for (const [model, slug] of models) {
    it(`chats with ${model} and returns only the answer`, async () => {
      const ai = replayBinding({ [model]: fixture(`${slug}.chat.json`) });
      const rung = rungById(llmRungs(BINDING_ENV), `llm/cloudflare-binding/${model}`);
      const res = await rung.chat({ messages, maxTokens: 200 }, bindingCtx(ai));
      expect(res.text).toMatch(/Armstrong/);
      expect(res.text).not.toMatch(/The user asks/);
      expect(res.model).toBe(model);
      expect(res.usage?.inputTokens).toBeGreaterThan(0);
      expect(ai.inputs[0]?.inputs).toEqual({ messages, max_tokens: 200 });
    });

    it(`returns a JSON object string from ${model} in JSON mode`, async () => {
      const ai = replayBinding({ [model]: fixture(`${slug}.json-mode.json`) });
      const rung = rungById(llmRungs(BINDING_ENV), `llm/cloudflare-binding/${model}`);
      const res = await rung.chat({ messages: jsonMessages, maxTokens: 200, json: true }, bindingCtx(ai));
      expect(JSON.parse(res.text)).toEqual({ speaker: 'Neil Armstrong', year: 1969 });
      const sent = ai.inputs[0]?.inputs as Record<string, unknown>;
      expect(sent.response_format).toEqual(rung.capabilities.includes('json') ? { type: 'json_object' } : undefined);
    });
  }

  it('asks for 4096 tokens by default instead of the Workers AI default of 256', async () => {
    const model = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';
    const ai = replayBinding({ [model]: fixture('llama-3.3-70b.chat.json') });
    await rungById(llmRungs(BINDING_ENV), `llm/cloudflare-binding/${model}`).chat({ messages }, bindingCtx(ai));
    expect(((ai.inputs[0]?.inputs ?? {}) as { max_tokens: number }).max_tokens).toBe(4096);
  });

  it('streams answer deltas from the binding and ends with the full text and usage', async () => {
    const model = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';
    const ai = replayBinding({ [model]: fixture('llama-3.3-70b.stream.sse') });
    const rung = rungById(llmRungs(BINDING_ENV), `llm/cloudflare-binding/${model}`);
    const events: ChatStreamEvent[] = [];
    for await (const e of streamFromRung(rung, { messages, maxTokens: 60 }, bindingCtx(ai))) events.push(e);
    const deltas = events.filter((e) => e.type === 'delta').map((e) => (e as { text: string }).text);
    const done = events.at(-1);
    expect(done?.type).toBe('done');
    const result = (done as Extract<ChatStreamEvent, { type: 'done' }>).result;
    expect(result.text).toBe(deltas.join(''));
    expect(result.text).toMatch(/^Neil Armstrong/);
    expect(result.text).toMatch(/1969/);
    expect(result.usage).toEqual({ inputTokens: 56, outputTokens: 23 });
    expect(((ai.inputs[0]?.inputs ?? {}) as { stream: boolean }).stream).toBe(true);
  });

  it('parses an SSE stream split at arbitrary byte boundaries', async () => {
    const bytes = new TextEncoder().encode(fixture('llama-3.3-70b.stream.sse'));
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        for (let i = 0; i < bytes.length; i += 37) c.enqueue(bytes.slice(i, i + 37));
        c.close();
      },
    });
    let text = '';
    for await (const e of parseSse(stream, 'm')) if (e.type === 'done') text = e.result.text;
    expect(text).toMatch(/^Neil Armstrong.*1969/);
  });

  it('embeds through the binding', async () => {
    const ai = replayBinding({ '@cf/baai/bge-m3': fixture('bge-m3.embed.json') });
    const [rung] = embedRungs(BINDING_ENV);
    const vectors = await rung?.embed(['a', 'b'], bindingCtx(ai));
    expect(vectors?.map((v) => v.length)).toEqual([1024, 1024]);
  });
});

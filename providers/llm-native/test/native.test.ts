import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { type ChatRequest, rankRungs, type StreamingLlmRung, Vid2ContextError } from '@vid2context/core';
import { type RecordedResponse, replayFetch, testContext } from '@vid2context/core/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import { anthropicRetryAfter } from '../src/anthropic.ts';
import { clearMetadataToken, METADATA_TOKEN_URL, metadataToken } from '../src/gce-metadata.ts';
import {
  ANTHROPIC_VERSION,
  anthropicSchema,
  buildAnthropicBody,
  buildGeminiBody,
  geminiSchema,
  minCacheTokens,
  nativeRungs,
} from '../src/index.ts';

// Real recordings (see test/fixtures/README.md).
const fixture = (name: string): RecordedResponse =>
  JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures', name), 'utf8')) as RecordedResponse;

/** Real transcript text from the shared fixtures, long enough to cross every cache minimum. */
const ctxJson = JSON.parse(
  readFileSync(join(import.meta.dirname, '..', '..', '..', 'tests', 'fixtures', 'contexts', 'youtube-cCPsdFdlshc.json'), 'utf8'),
) as { transcript: { segments: { text: string }[] } };
const transcript = ctxJson.transcript.segments.map((s) => s.text).join(' ');
const shortCtx = JSON.parse(
  readFileSync(join(import.meta.dirname, '..', '..', '..', 'tests', 'fixtures', 'contexts', 'youtube-jNQXAC9IVRw.json'), 'utf8'),
) as { transcript: { segments: { text: string }[] } };
const shortTranscript = shortCtx.transcript.segments.map((s) => s.text).join(' ');

const apollo: ChatRequest = {
  messages: [{ role: 'user', content: 'Which year did Apollo 11 land on the moon? One sentence.' }],
  maxTokens: 2000,
};

function rungById(id: string, env: Record<string, string>): StreamingLlmRung {
  const r = nativeRungs(env).find((x) => x.id === id);
  if (!r) throw new Error(`no rung ${id}`);
  return r;
}

async function caught(p: Promise<unknown> | AsyncIterable<unknown>): Promise<Vid2ContextError> {
  try {
    if (Symbol.asyncIterator in p) {
      for await (const _ of p) {
        // drain
      }
    } else {
      await p;
    }
  } catch (err) {
    if (err instanceof Vid2ContextError) return err;
    throw err;
  }
  throw new Error('expected an error');
}

describe('rungs from env', () => {
  it('lists every rung disabled with zero configuration, so health output shows what each key unlocks', () => {
    const rungs = nativeRungs({});
    expect(rungs.map((r) => r.id)).toEqual([
      'llm/gemini-native/gemini-3.8-flash',
      'llm/gemini-native/gemini-3.5-flash-lite',
      'llm/anthropic/claude-haiku-5-5',
      'llm/anthropic/claude-sonnet-5-5',
      'llm/vertex-gemini/gemini-3.8-flash',
      'llm/vertex-anthropic/claude-haiku-5-5',
    ]);
    expect(rungs.every((r) => r.isEnabled?.({}) === false)).toBe(true);
    expect(rankRungs(rungs, {}, {})).toEqual([]);
  });

  it('puts native Gemini in the free tier and Anthropic and Vertex in paid, cheapest Claude first', () => {
    const env = { GEMINI_API_KEY: 'g', ANTHROPIC_API_KEY: 'a', GOOGLE_CLOUD_PROJECT: 'p', GOOGLE_ACCESS_TOKEN: 't' };
    const ranked = rankRungs(nativeRungs(env), {}, env);
    expect(ranked.map((r) => [r.id, r.tier])).toEqual([
      ['llm/gemini-native/gemini-3.8-flash', 'free'],
      ['llm/gemini-native/gemini-3.5-flash-lite', 'free'],
      ['llm/anthropic/claude-haiku-5-5', 'paid'],
      ['llm/anthropic/claude-sonnet-5-5', 'paid'],
      ['llm/vertex-gemini/gemini-3.8-flash', 'paid'],
      ['llm/vertex-anthropic/claude-haiku-5-5', 'paid'],
    ]);
  });

  it('never runs paid rungs when VID2CONTEXT_ALLOW_PAID=0', () => {
    const env = { GEMINI_API_KEY: 'g', ANTHROPIC_API_KEY: 'a', VID2CONTEXT_ALLOW_PAID: '0' };
    expect(rankRungs(nativeRungs(env), {}, env).map((r) => r.service)).toEqual(['gemini-native', 'gemini-native']);
  });

  it('pools extra keys as their own rungs and replaces model lists from env', () => {
    const env = {
      ANTHROPIC_API_KEY: 'a1',
      ANTHROPIC_FALLBACK_KEYS: 'a2, a1',
      ANTHROPIC_MODEL: 'claude-sonnet-5-5',
      GEMINI_API_KEY: 'g1',
      GEMINI_FALLBACK_KEYS: 'g2',
      GEMINI_NATIVE_MODEL: 'gemini-3.5-flash-lite,gemini-new-model',
    };
    const ids = rankRungs(nativeRungs(env), {}, env).map((r) => r.id);
    expect(ids).toEqual([
      'llm/gemini-native/gemini-3.5-flash-lite',
      'llm/gemini-native#2/gemini-3.5-flash-lite',
      'llm/gemini-native/gemini-new-model',
      'llm/gemini-native#2/gemini-new-model',
      'llm/anthropic/claude-sonnet-5-5',
      'llm/anthropic#2/claude-sonnet-5-5',
    ]);
    const pooled = rungById('llm/anthropic#2/claude-sonnet-5-5', env);
    expect(pooled.requires).toEqual(['ANTHROPIC_FALLBACK_KEYS']);
    expect(rungById('llm/gemini-native/gemini-new-model', env).quality).toBe(3);
  });

  it('enables Vertex only with a project and a token source', () => {
    const vertex = (env: Record<string, string>) => nativeRungs(env).filter((r) => r.service.startsWith('vertex-'));
    expect(vertex({ GOOGLE_CLOUD_PROJECT: 'p' }).every((r) => !r.isEnabled?.({}))).toBe(true);
    expect(vertex({ GOOGLE_ACCESS_TOKEN: 't' }).every((r) => !r.isEnabled?.({}))).toBe(true);
    expect(vertex({ GOOGLE_CLOUD_PROJECT: 'p', GOOGLE_ACCESS_TOKEN: 't' }).every((r) => r.isEnabled?.({}))).toBe(true);
    const meta = vertex({ GOOGLE_CLOUD_PROJECT: 'p', VID2CONTEXT_GCE_METADATA: '1' });
    expect(meta.every((r) => r.isEnabled?.({}))).toBe(true);
    expect(meta[0]?.requires).toEqual(['GOOGLE_CLOUD_PROJECT', 'VID2CONTEXT_GCE_METADATA']);
  });

  it('declares JSON, JSON Schema and native streaming', () => {
    const r = rungById('llm/anthropic/claude-haiku-5-5', {});
    expect(r.capabilities).toEqual(['json', 'json-schema', 'stream']);
    expect(typeof r.stream).toBe('function');
    expect(r.contextTokens).toBe(1_000_000);
  });
});

describe('Anthropic request bodies', () => {
  const target = { model: 'claude-haiku-5-5', flavor: 'api' as const };

  it('maps system messages to the top-level system field and drops sampling parameters', () => {
    const body = buildAnthropicBody(target, {
      messages: [
        { role: 'system', content: 'Be brief.' },
        { role: 'user', content: 'Hi' },
        { role: 'assistant', content: 'Hello.' },
        { role: 'user', content: 'Year of Apollo 11?' },
      ],
      temperature: 0.2,
      maxTokens: 300,
    });
    expect(body.model).toBe('claude-haiku-5-5');
    expect(body.max_tokens).toBe(300);
    expect(body.system).toEqual([{ type: 'text', text: 'Be brief.' }]);
    expect(body.messages).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'Hi' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'Hello.' }] },
      { role: 'user', content: [{ type: 'text', text: 'Year of Apollo 11?' }] },
    ]);
    expect(body).not.toHaveProperty('temperature');
    expect(body).not.toHaveProperty('stream');
  });

  it('caches a long system transcript and leaves the question uncached', () => {
    const body = buildAnthropicBody(target, {
      messages: [
        { role: 'system', content: `Answer from this transcript.\n\n${transcript}` },
        { role: 'user', content: 'Which years should I avoid?' },
      ],
    });
    const system = body.system as { cache_control?: unknown }[];
    expect(system[0]?.cache_control).toEqual({ type: 'ephemeral' });
    const msgs = body.messages as { content: { cache_control?: unknown }[] }[];
    expect(msgs[0]?.content[0]?.cache_control).toBeUndefined();
  });

  it('does not mark content below the model minimum', () => {
    const body = buildAnthropicBody(target, {
      messages: [
        { role: 'system', content: shortTranscript },
        { role: 'user', content: 'What animal is shown?' },
      ],
    });
    expect((body.system as { cache_control?: unknown }[])[0]?.cache_control).toBeUndefined();
  });

  it('caches the conversation up to the turn before the new question', () => {
    const body = buildAnthropicBody(target, {
      messages: [
        { role: 'user', content: `Transcript:\n${transcript}\n\nSummarize it.` },
        { role: 'assistant', content: 'It ranks G-Wagon model years.' },
        { role: 'user', content: 'Which engine is best?' },
      ],
    });
    const msgs = body.messages as { content: { cache_control?: unknown }[] }[];
    expect(msgs[1]?.content[0]?.cache_control).toEqual({ type: 'ephemeral' });
    expect(msgs[2]?.content.every((b) => b.cache_control === undefined)).toBe(true);
  });

  it('splits a single long user message so the material is cached and the final question is not', () => {
    const body = buildAnthropicBody(target, {
      messages: [{ role: 'user', content: `Transcript:\n${transcript}\n\nWhich years should I avoid?` }],
    });
    const content = (body.messages as { content: { text: string; cache_control?: unknown }[] }[])[0]?.content;
    expect(content).toHaveLength(2);
    expect(content?.[0]?.cache_control).toEqual({ type: 'ephemeral' });
    expect(content?.[0]?.text.startsWith('Transcript:')).toBe(true);
    expect(content?.[1]).toEqual({ type: 'text', text: 'Which years should I avoid?' });
  });

  it('uses each model family minimum cacheable size', () => {
    expect(minCacheTokens('claude-haiku-5-5')).toBe(512);
    expect(minCacheTokens('claude-sonnet-5-5')).toBe(512);
    expect(minCacheTokens('claude-sonnet-5')).toBe(1024);
    expect(minCacheTokens('claude-opus-5')).toBe(512);
    expect(minCacheTokens('claude-haiku-4-5')).toBe(4096);
    expect(minCacheTokens('claude-opus-4-7')).toBe(2048);
  });

  it('sends a JSON Schema through output_config.format, fitted to structured outputs', () => {
    const schema = {
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      type: 'object',
      properties: {
        year: { type: 'integer', minimum: 1900 },
        crew: {
          type: 'array',
          items: { type: 'object', properties: { name: { type: 'string', maxLength: 40 } } },
          maxItems: 3,
          minItems: 1,
        },
      },
      required: ['year'],
      additionalProperties: true,
    };
    const body = buildAnthropicBody(target, { ...apollo, json: { schema, name: 'answer' } });
    expect(body.output_config).toEqual({
      format: {
        type: 'json_schema',
        schema: {
          type: 'object',
          properties: {
            year: { type: 'integer' },
            crew: {
              type: 'array',
              items: { type: 'object', properties: { name: { type: 'string' } }, additionalProperties: false },
              minItems: 1,
            },
          },
          required: ['year'],
          additionalProperties: false,
        },
      },
    });
    expect(body).not.toHaveProperty('tools');
    expect(body).not.toHaveProperty('tool_choice');
    expect(anthropicSchema({ type: 'array', minItems: 5 })).toEqual({ type: 'array' });
  });

  it('asks for JSON in the system prompt when no schema is given', () => {
    const body = buildAnthropicBody(target, { ...apollo, json: true });
    expect((body.system as { text: string }[])[0]?.text).toBe('Reply with a single JSON object and nothing else.');
    expect(body).not.toHaveProperty('output_config');
  });

  it('streams with summarized thinking on Claude 5-generation models only', () => {
    expect(buildAnthropicBody(target, apollo, { stream: true })).toMatchObject({
      stream: true,
      thinking: { type: 'adaptive', display: 'summarized' },
    });
    expect(buildAnthropicBody({ model: 'claude-haiku-4-5', flavor: 'api' }, apollo, { stream: true })).not.toHaveProperty(
      'thinking',
    );
  });

  it('puts anthropic_version in the body instead of the model for Vertex', () => {
    const body = buildAnthropicBody({ model: 'claude-haiku-5-5', flavor: 'vertex' }, apollo);
    expect(body.anthropic_version).toBe(ANTHROPIC_VERSION);
    expect(body).not.toHaveProperty('model');
  });
});

describe('Gemini request bodies', () => {
  it('maps system to systemInstruction and assistant to the model role', () => {
    const body = buildGeminiBody({
      messages: [
        { role: 'system', content: 'Be brief.' },
        { role: 'user', content: 'Hi' },
        { role: 'assistant', content: 'Hello.' },
        { role: 'user', content: 'Year of Apollo 11?' },
      ],
      maxTokens: 300,
      temperature: 0.2,
    });
    expect(body).toEqual({
      systemInstruction: { parts: [{ text: 'Be brief.' }] },
      contents: [
        { role: 'user', parts: [{ text: 'Hi' }] },
        { role: 'model', parts: [{ text: 'Hello.' }] },
        { role: 'user', parts: [{ text: 'Year of Apollo 11?' }] },
      ],
      generationConfig: { maxOutputTokens: 300, temperature: 0.2 },
    });
  });

  it('requests JSON with responseJsonSchema, minus the keywords Gemini ignores', () => {
    const schema = {
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      type: 'object',
      properties: { mission: { type: 'string', minLength: 1, maxLength: 20 }, year: { type: 'integer', minimum: 1900 } },
      required: ['mission'],
      maxProperties: 4,
    };
    const body = buildGeminiBody({ ...apollo, json: { schema } });
    expect(body.generationConfig).toEqual({
      maxOutputTokens: 2000,
      responseMimeType: 'application/json',
      responseJsonSchema: {
        type: 'object',
        properties: { mission: { type: 'string' }, year: { type: 'integer', minimum: 1900 } },
        required: ['mission'],
      },
    });
    expect(geminiSchema({ anyOf: [{ type: 'string', maxLength: 3 }, { type: 'null' }] })).toEqual({
      anyOf: [{ type: 'string' }, { type: 'null' }],
    });
  });

  it('asks for thought summaries only when streaming', () => {
    expect(buildGeminiBody(apollo)).not.toHaveProperty('generationConfig.thinkingConfig');
    expect(buildGeminiBody(apollo, { stream: true })).toMatchObject({
      generationConfig: { thinkingConfig: { includeThoughts: true } },
    });
  });
});

const vertexEnv = { GOOGLE_CLOUD_PROJECT: 'redacted-project', GOOGLE_ACCESS_TOKEN: 'token-1' };
const project = 'https://us-central1-aiplatform.googleapis.com/v1/projects/redacted-project/locations/us-central1';
const globalProject = 'https://aiplatform.googleapis.com/v1/projects/redacted-project/locations/global';

describe('requests on the wire and real error responses', () => {
  it('Anthropic: sends x-api-key and anthropic-version, maps a real 401 to auth with a hint', async () => {
    const fetch = replayFetch([
      { method: 'POST', url: 'https://api.anthropic.com/v1/messages', response: fixture('anthropic.401-invalid-key.json') },
    ]);
    const r = rungById('llm/anthropic/claude-haiku-5-5', { ANTHROPIC_API_KEY: 'sk-ant-invalid' });
    const err = await caught(r.chat(apollo, testContext({ fetch })));
    expect(err.code).toBe('auth');
    expect(err.status).toBe(401);
    expect(err.message).toContain('authentication_error: invalid x-api-key');
    expect(err.hint).toContain('ANTHROPIC_API_KEY');
    const call = fetch.calls[0];
    expect(call?.headers['x-api-key']).toBe('sk-ant-invalid');
    expect(call?.headers['anthropic-version']).toBe(ANTHROPIC_VERSION);
    expect(JSON.parse(String(call?.body)).model).toBe('claude-haiku-5-5');
  });

  it('Anthropic: honours ANTHROPIC_BASE_URL', async () => {
    const fetch = replayFetch([
      { url: 'https://proxy.example.org/v1/messages', response: fixture('anthropic.401-invalid-key.json') },
    ]);
    const r = rungById('llm/anthropic/claude-haiku-5-5', {
      ANTHROPIC_API_KEY: 'k',
      ANTHROPIC_BASE_URL: 'https://proxy.example.org/',
    });
    expect((await caught(r.stream(apollo, testContext({ fetch })))).code).toBe('auth');
    expect(JSON.parse(String(fetch.calls[0]?.body)).stream).toBe(true);
  });

  it('Gemini: sends the key in x-goog-api-key and maps a real API_KEY_INVALID 400 to auth', async () => {
    const fetch = replayFetch([
      {
        method: 'POST',
        url: 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent',
        response: fixture('gemini-native.400-invalid-key.json'),
      },
      {
        method: 'POST',
        url: 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:streamGenerateContent?alt=sse',
        response: fixture('gemini-native.400-invalid-key.json'),
      },
    ]);
    const r = rungById('llm/gemini-native/gemini-3.8-flash', { GEMINI_API_KEY: 'invalid-key' });
    const err = await caught(r.chat(apollo, testContext({ fetch })));
    expect(err.code).toBe('auth');
    expect(err.status).toBe(400);
    expect(err.hint).toContain('GEMINI_API_KEY');
    expect(fetch.calls[0]?.headers['x-goog-api-key']).toBe('invalid-key');
    expect(fetch.calls[0]?.url).not.toContain('key=');
    expect((await caught(r.stream(apollo, testContext({ fetch })))).code).toBe('auth');
  });

  it('Vertex Gemini: regional URL, bearer token, real billing 403 becomes auth with a billing hint', async () => {
    const fetch = replayFetch([
      {
        url: `${project}/publishers/google/models/gemini-3.8-flash:generateContent`,
        response: fixture('vertex-gemini.chat.403.json'),
      },
      {
        url: `${project}/publishers/google/models/gemini-3.8-flash:streamGenerateContent?alt=sse`,
        response: fixture('vertex-gemini.stream.403.json'),
      },
    ]);
    const r = rungById('llm/vertex-gemini/gemini-3.8-flash', vertexEnv);
    const ctx = testContext({ env: vertexEnv, fetch });
    for (const err of [await caught(r.chat(apollo, ctx)), await caught(r.stream(apollo, ctx))]) {
      expect(err.code).toBe('auth');
      expect(err.status).toBe(403);
      expect(err.hint).toContain('billing');
    }
    expect(fetch.calls[0]?.headers.authorization).toBe('Bearer token-1');
  });

  it('Vertex Claude: global endpoint, rawPredict and streamRawPredict, including the array-wrapped stream error', async () => {
    const fetch = replayFetch([
      {
        url: `${globalProject}/publishers/anthropic/models/claude-haiku-5-5:rawPredict`,
        response: fixture('vertex-anthropic.chat.403.json'),
      },
      {
        url: `${globalProject}/publishers/anthropic/models/claude-haiku-5-5:streamRawPredict`,
        response: fixture('vertex-anthropic.stream.403.json'),
      },
    ]);
    const r = rungById('llm/vertex-anthropic/claude-haiku-5-5', vertexEnv);
    const ctx = testContext({ env: vertexEnv, fetch });
    for (const err of [await caught(r.chat(apollo, ctx)), await caught(r.stream(apollo, ctx))]) {
      expect(err.code).toBe('auth');
      expect(err.message).toContain('PERMISSION_DENIED');
      expect(err.message).toContain('billing account');
    }
    const sent = JSON.parse(String(fetch.calls[1]?.body));
    expect(sent.anthropic_version).toBe(ANTHROPIC_VERSION);
    expect(sent.stream).toBe(true);
  });
});

describe('Vertex token sources', () => {
  beforeEach(() => clearMetadataToken());

  it('reads a token from the GCE metadata server on Node and caches it until shortly before expiry', async () => {
    const fetch = replayFetch([{ url: METADATA_TOKEN_URL, response: fixture('gce-metadata.token.json') }]);
    const ctx = testContext({ fetch });
    const now = Date.now();
    expect(await metadataToken(ctx, now)).toBe('redacted-token');
    expect(await metadataToken(ctx, now + 60_000)).toBe('redacted-token');
    expect(fetch.calls).toHaveLength(1);
    expect(fetch.calls[0]?.headers['metadata-flavor']).toBe('Google');
    // expires_in is 3288 s in the recording; within two minutes of that it refreshes.
    await metadataToken(ctx, now + 3200_000);
    expect(fetch.calls).toHaveLength(2);
  });

  it('uses the metadata token for Vertex calls when VID2CONTEXT_GCE_METADATA=1', async () => {
    const env = { GOOGLE_CLOUD_PROJECT: 'redacted-project', VID2CONTEXT_GCE_METADATA: '1' };
    const fetch = replayFetch([
      { url: METADATA_TOKEN_URL, response: fixture('gce-metadata.token.json') },
      {
        url: `${project}/publishers/google/models/gemini-3.8-flash:generateContent`,
        response: fixture('vertex-gemini.chat.403.json'),
      },
    ]);
    await caught(rungById('llm/vertex-gemini/gemini-3.8-flash', env).chat(apollo, testContext({ env, fetch })));
    expect(fetch.calls[1]?.headers.authorization).toBe('Bearer redacted-token');
  });

  it('a metadata token without the cloud-platform scope (real 403) gets the access-scope hint on both Vertex paths', async () => {
    const env = { GOOGLE_CLOUD_PROJECT: 'redacted-project', VID2CONTEXT_GCE_METADATA: '1' };
    const fetch = replayFetch([
      { url: METADATA_TOKEN_URL, response: fixture('gce-metadata.token.json') },
      {
        url: `${project}/publishers/google/models/gemini-3.8-flash:generateContent`,
        response: fixture('vertex-gemini.chat.403-scope.json'),
      },
      {
        url: `${globalProject}/publishers/anthropic/models/claude-haiku-5-5:rawPredict`,
        response: fixture('vertex-anthropic.chat.403-scope.json'),
      },
    ]);
    const ctx = testContext({ env, fetch });
    for (const id of ['llm/vertex-gemini/gemini-3.8-flash', 'llm/vertex-anthropic/claude-haiku-5-5']) {
      const err = await caught(rungById(id, env).chat(apollo, ctx));
      expect(err.code).toBe('auth');
      expect(err.status).toBe(403);
      expect(err.message).toContain('insufficient authentication scopes');
      expect(err.hint).toContain('cloud-platform scope');
    }
  });

  it('refuses the metadata server outside Node and never calls it', async () => {
    const env = { GOOGLE_CLOUD_PROJECT: 'redacted-project', VID2CONTEXT_GCE_METADATA: '1' };
    const fetch = replayFetch([]);
    const err = await caught(
      rungById('llm/vertex-gemini/gemini-3.8-flash', env).chat(apollo, testContext({ env, fetch, runtime: 'workers' })),
    );
    expect(err.code).toBe('auth');
    expect(err.hint).toContain('GOOGLE_ACCESS_TOKEN');
    expect(fetch.calls).toHaveLength(0);
  });
});

describe('rate limit headers', () => {
  it('prefers Retry-After, else the latest anthropic-ratelimit reset time', () => {
    const now = Date.parse('2026-11-14T12:00:00Z');
    expect(anthropicRetryAfter(new Headers({ 'retry-after': '17' }), now)).toBe(17);
    expect(
      anthropicRetryAfter(
        new Headers({
          'anthropic-ratelimit-requests-reset': '2026-11-14T12:00:05Z',
          'anthropic-ratelimit-tokens-reset': '2026-11-14T12:00:40Z',
        }),
        now,
      ),
    ).toBe(40);
    expect(anthropicRetryAfter(new Headers(), now)).toBeUndefined();
  });
});

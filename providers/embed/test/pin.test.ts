import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Registry, Vid2ContextError } from '@vid2context/core';
import { type RecordedCall, replayFetch, testContext } from '@vid2context/core/testing';
import { describe, expect, it } from 'vitest';
import provider, { canonicalRungId, cosine, embedQuery, embedWithModel, pickEmbedModel, pinnedRungs } from '../src/index.ts';

// Real recordings from OVH AI Endpoints, 2026-11-14 (see test/fixtures/README.md).
const fixture = (name: string) => readFileSync(join(import.meta.dirname, 'fixtures', name), 'utf8');
const OVH = 'https://oai.endpoints.kepler.ai.cloud.ovh.net/v1/embeddings';
const SENTENCES: string[] = JSON.parse(fixture('sentences.json'));
const registry = new Registry([provider], 'node');
const bodyOf = (call: RecordedCall | undefined) => JSON.parse(String(call?.body)) as { model: string; input: string[] };
const bgeVectors = (JSON.parse(fixture('ovh-bge-m3.json')) as { data: { embedding: number[] }[] }).data.map((d) => d.embedding);

/** Answers each input with the vector OVH really returned for that sentence. */
function bgeBySentence(call: RecordedCall) {
  const data = bodyOf(call).input.map((text, index) => ({
    object: 'embedding',
    index,
    embedding: bgeVectors[SENTENCES.indexOf(text)],
  }));
  return { body: JSON.stringify({ object: 'list', data, model: 'bge-m3' }) };
}

describe('pickEmbedModel', () => {
  it('picks OVH bge-m3 with zero configuration', () => {
    expect(pickEmbedModel(registry, {})).toBe('embed/ovh/bge-m3');
  });

  it('prefers a configured local model, free first', () => {
    expect(pickEmbedModel(registry, { OLLAMA_EMBED_MODEL: 'bge-m3' })).toBe('embed/ollama/bge-m3');
  });

  it('honors the quality policy', () => {
    expect(pickEmbedModel(registry, {}, { policy: 'quality' })).toBe('embed/ovh/Qwen3-Embedding-8B');
  });

  it('uses VID2CONTEXT_EMBED_MODEL when set, and strips a pooled-key suffix', () => {
    expect(pickEmbedModel(registry, { VID2CONTEXT_EMBED_MODEL: 'embed/ovh/Qwen3-Embedding-8B' })).toBe(
      'embed/ovh/Qwen3-Embedding-8B',
    );
    expect(pickEmbedModel(registry, { VID2CONTEXT_EMBED_MODEL: 'embed/mistral#2/mistral-embed' })).toBe(
      'embed/mistral/mistral-embed',
    );
  });

  it('rejects an unknown VID2CONTEXT_EMBED_MODEL and names enabled rungs', () => {
    try {
      pickEmbedModel(registry, { VID2CONTEXT_EMBED_MODEL: 'embed/nowhere/x' });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(Vid2ContextError);
      expect(err).toMatchObject({ code: 'not-found' });
      expect((err as Vid2ContextError).hint).toContain('embed/ovh/bge-m3');
    }
  });

  it('throws no-provider when nothing is enabled', () => {
    expect(() => pickEmbedModel(registry, { VID2CONTEXT_KEYLESS: '0' })).toThrow(/No embedding rung/);
  });
});

describe('canonicalRungId and pinnedRungs', () => {
  it('strips only the pooled-key suffix', () => {
    expect(canonicalRungId('embed/groq#2/x')).toBe('embed/groq/x');
    expect(canonicalRungId('embed/cloudflare/@cf/baai/bge-m3')).toBe('embed/cloudflare/@cf/baai/bge-m3');
    expect(canonicalRungId('embed/ovh/bge-m3')).toBe('embed/ovh/bge-m3');
  });

  it('groups pooled keys of the same service and model, never other models', () => {
    const env = { MISTRAL_API_KEY: 'a', MISTRAL_FALLBACK_KEYS: 'b' };
    expect(pinnedRungs(registry, 'embed/mistral/mistral-embed', env).map((r) => r.id)).toEqual([
      'embed/mistral/mistral-embed',
      'embed/mistral#2/mistral-embed',
    ]);
    // Asking for the second key puts it first.
    expect(pinnedRungs(registry, 'embed/mistral#2/mistral-embed', env).map((r) => r.id)[0]).toBe('embed/mistral#2/mistral-embed');
  });

  it('explains how to enable a pinned model that is off', () => {
    try {
      pinnedRungs(registry, 'embed/ovh/bge-m3', { VID2CONTEXT_KEYLESS: '0', MISTRAL_API_KEY: 'a' });
      expect.unreachable();
    } catch (err) {
      expect(err).toMatchObject({ code: 'no-provider' });
      const hint = (err as Vid2ContextError).hint ?? '';
      expect(hint).toContain('VID2CONTEXT_KEYLESS');
      expect(hint).toContain('re-index');
      expect(hint).toContain('embed/mistral/mistral-embed');
    }
  });
});

describe('embedWithModel', () => {
  it('embeds with the pinned rung, batching to its limit and keeping order', async () => {
    const texts = Array.from({ length: 27 }, (_, i) => SENTENCES[i % SENTENCES.length] as string);
    const fetch = replayFetch([{ method: 'POST', url: OVH, response: bgeBySentence }]);
    const vecs = await embedWithModel(registry, 'embed/ovh/bge-m3', texts, testContext({ fetch }));
    expect(fetch.calls.map((c) => bodyOf(c).input.length)).toEqual([25, 2]);
    texts.forEach((t, i) => {
      expect(cosine(vecs[i] as number[], bgeVectors[SENTENCES.indexOf(t)] as number[])).toBeCloseTo(1, 9);
    });
  });

  it('never falls back to another model, even one that would answer', async () => {
    const fetch = replayFetch([
      {
        method: 'POST',
        url: OVH,
        response: (call) =>
          bodyOf(call).model === 'bge-m3'
            ? { status: 404, body: fixture('ovh-bad-model.404.json') }
            : { body: fixture('ovh-qwen3-embedding-8b.json') },
      },
    ]);
    const err = await embedWithModel(registry, 'embed/ovh/bge-m3', SENTENCES, testContext({ fetch })).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Vid2ContextError);
    expect(err).toMatchObject({ code: 'not-found', status: 404 });
    const hint = (err as Vid2ContextError).hint ?? '';
    expect(hint).toContain('re-index');
    expect(hint).toContain('embed/ovh/Qwen3-Embedding-8B');
    expect(fetch.calls.every((c) => bodyOf(c).model === 'bge-m3')).toBe(true);
  });

  it('tries pooled keys of the same service and model, and nothing else', async () => {
    // No recorded answer for Mistral (no key): every call fails, which shows the order of what was tried.
    const env = { MISTRAL_API_KEY: 'key-a', MISTRAL_FALLBACK_KEYS: 'key-b' };
    const fetch = replayFetch([]);
    await expect(embedWithModel(registry, 'embed/mistral/mistral-embed', ['oil'], testContext({ fetch, env }))).rejects.toThrow(
      Vid2ContextError,
    );
    expect(fetch.calls.map((c) => [c.url, c.headers.authorization, bodyOf(c).model])).toEqual([
      ['https://api.mistral.ai/v1/embeddings', 'Bearer key-a', 'mistral-embed'],
      ['https://api.mistral.ai/v1/embeddings', 'Bearer key-b', 'mistral-embed'],
    ]);
  });

  it('waits out a short real rate limit on the same rung, then succeeds', async () => {
    let calls = 0;
    const fetch = replayFetch([
      {
        method: 'POST',
        url: OVH,
        response: () =>
          ++calls === 1
            ? { status: 429, headers: { 'retry-after': '1' }, body: fixture('ovh-rate-limited.429.json') }
            : { body: fixture('ovh-bge-m3-single.json') },
      },
    ]);
    const [v] = await embedWithModel(
      registry,
      'embed/ovh/bge-m3',
      ['wherever you can always get parts for it'],
      testContext({ fetch }),
    );
    expect(fetch.calls).toHaveLength(2);
    expect(v).toHaveLength(1024);
  });

  it('passes empty input errors through without retrying', async () => {
    const fetch = replayFetch([]);
    await expect(embedWithModel(registry, 'embed/ovh/bge-m3', [''], testContext({ fetch }))).rejects.toMatchObject({
      code: 'bad-request',
    });
    expect(fetch.calls).toHaveLength(0);
  });
});

describe('embedQuery', () => {
  it('embeds a query with the index model and finds its paraphrase', async () => {
    const fetch = replayFetch([{ method: 'POST', url: OVH, response: bgeBySentence }]);
    const index = { model: 'embed/ovh/bge-m3' };
    const q = await embedQuery(registry, index, SENTENCES[1] as string, testContext({ fetch }));
    expect(bodyOf(fetch.calls[0])).toEqual({ model: 'bge-m3', input: [SENTENCES[1]] });
    const ranked = SENTENCES.map((_, i) => i)
      .filter((i) => i !== 1)
      .sort((a, b) => cosine(q, bgeVectors[b] as number[]) - cosine(q, bgeVectors[a] as number[]));
    expect(ranked[0]).toBe(0);
  });

  it('adds the Qwen3 query instruction for a Qwen3 index', async () => {
    const fetch = replayFetch([]);
    await embedQuery(registry, { model: 'embed/ovh/Qwen3-Embedding-8B' }, 'timing chain', testContext({ fetch })).catch(
      () => undefined,
    );
    expect(bodyOf(fetch.calls[0]).input[0]).toBe(
      'Instruct: Given a web search query, retrieve relevant passages that answer the query\nQuery: timing chain',
    );
  });
});

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { estimateTokens, rankRungs, Vid2ContextError } from '@vid2context/core';
import { type RecordedCall, replayFetch, testContext } from '@vid2context/core/testing';
import { describe, expect, it } from 'vitest';
import {
  cosine,
  embedRungs,
  LANES,
  l2normalize,
  type RetrievalEmbedRung,
  retrievalPrefixes,
  splitBatches,
  TOKEN_HEADROOM,
  truncateForEmbedding,
} from '../src/index.ts';

// Real recordings from OVH AI Endpoints (keyless) and Cloudflare Workers AI, 2026-11-14 (see test/fixtures/README.md).
const fixture = (name: string) => readFileSync(join(import.meta.dirname, 'fixtures', name), 'utf8');
const OVH = 'https://oai.endpoints.kepler.ai.cloud.ovh.net/v1/embeddings';
const SENTENCES: string[] = JSON.parse(fixture('sentences.json'));

interface EmbeddingsBody {
  data: { index: number; embedding: number[] }[];
}
const vectorsOf = (name: string) => (JSON.parse(fixture(name)) as EmbeddingsBody).data.map((d) => d.embedding);
const bodyOf = (call: RecordedCall | undefined) =>
  JSON.parse(String(call?.body)) as { model: string; input: string[] } & Record<string, unknown>;
const norm = (v: number[]) => Math.sqrt(v.reduce((s, x) => s + x * x, 0));

function rungById(id: string, env: Record<string, string> = {}): RetrievalEmbedRung {
  const r = embedRungs(env).find((x) => x.id === id);
  if (!r) throw new Error(`no rung ${id}`);
  return r;
}

/**
 * Answers each input with the vector OVH really returned for that sentence
 * (bge-m3 is deterministic), so batches of any size and order replay real data.
 */
function bySentence(name: string) {
  const vecs = vectorsOf(name);
  return (call: RecordedCall) => {
    const { input } = bodyOf(call);
    const data = input.map((text, index) => {
      const i = SENTENCES.indexOf(text);
      if (i < 0) throw new Error(`no recorded vector for "${text}"`);
      return { object: 'embedding', index, embedding: vecs[i] };
    });
    return { body: JSON.stringify({ object: 'list', data, model: 'bge-m3' }) };
  };
}

describe('rungs from env', () => {
  it('runs OVH keyless bge-m3 first with zero configuration', () => {
    expect(rankRungs(embedRungs({}), {}, {}).map((r) => r.id)).toEqual(['embed/ovh/bge-m3', 'embed/ovh/Qwen3-Embedding-8B']);
  });

  it('turns keyless rungs off with VID2CONTEXT_KEYLESS=0', () => {
    const env = { VID2CONTEXT_KEYLESS: '0' };
    expect(rankRungs(embedRungs(env), {}, env)).toEqual([]);
  });

  it('orders local, free, keyless, paid', () => {
    const env = {
      OLLAMA_EMBED_MODEL: 'nomic-embed-text',
      LMSTUDIO_EMBED_MODEL: 'text-embedding-bge-m3',
      GEMINI_API_KEY: 'g',
      JINA_API_KEY: 'j',
      CLOUDFLARE_API_TOKEN: 'c',
      CLOUDFLARE_ACCOUNT_ID: 'acct',
      MISTRAL_API_KEY: 'm',
      OPENAI_API_KEY: 'o',
    };
    expect(rankRungs(embedRungs(env), {}, env).map((r) => r.id)).toEqual([
      'embed/ollama/nomic-embed-text',
      'embed/lmstudio/text-embedding-bge-m3',
      'embed/gemini/gemini-embedding-2',
      'embed/jina/jina-embeddings-v3',
      'embed/cloudflare/@cf/baai/bge-m3',
      'embed/mistral/mistral-embed',
      'embed/ovh/bge-m3',
      'embed/ovh/Qwen3-Embedding-8B',
      'embed/openai/text-embedding-3-small',
    ]);
  });

  it('lists disabled rungs with what they require', () => {
    const rungs = embedRungs({});
    expect(rungById('embed/ollama').requires).toEqual(['OLLAMA_EMBED_MODEL']);
    expect(rungById('embed/local').requires).toEqual(['LOCAL_EMBED_MODEL', 'LOCAL_EMBED_BASE_URL']);
    expect(rungById('embed/cloudflare/@cf/baai/bge-m3').requires).toEqual(['CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID']);
    expect(rungs.find((r) => r.id === 'embed/openai/text-embedding-3-small')?.tier).toBe('paid');
  });

  it('replaces a model with <PROVIDER>_EMBED_MODEL and pools extra keys of the same model', () => {
    const env = { MISTRAL_API_KEY: 'a', MISTRAL_FALLBACK_KEYS: 'b,c', OVH_EMBED_MODEL: 'bge-multilingual-gemma2' };
    expect(rankRungs(embedRungs(env), {}, env).map((r) => r.id)).toEqual([
      'embed/mistral/mistral-embed',
      'embed/mistral#2/mistral-embed',
      'embed/mistral#3/mistral-embed',
      'embed/ovh/bge-multilingual-gemma2',
    ]);
  });

  it('does not pool Cloudflare tokens, which belong to one account', () => {
    const env = { CLOUDFLARE_API_TOKEN: 'a', CLOUDFLARE_FALLBACK_KEYS: 'b', CLOUDFLARE_ACCOUNT_ID: 'acct' };
    expect(
      embedRungs(env)
        .filter((r) => r.service.startsWith('cloudflare'))
        .map((r) => r.id),
    ).toEqual(['embed/cloudflare/@cf/baai/bge-m3']);
  });

  it('reports measured dimensions and limits', () => {
    expect(rungById('embed/ovh/bge-m3')).toMatchObject({ dimensions: 1024, maxBatch: 25, maxInputTokens: 8192 });
    expect(rungById('embed/ovh/Qwen3-Embedding-8B')).toMatchObject({ dimensions: 4096, maxBatch: 25, quality: 5 });
    expect(rungById('embed/ollama/all-minilm', { OLLAMA_EMBED_MODEL: 'all-minilm' }).quality).toBeLessThan(
      rungById('embed/ovh/bge-m3').quality,
    );
  });

  it('gives every lane a <PROVIDER>_EMBED_MODEL override', () => {
    for (const lane of LANES) expect(lane.modelVar).toMatch(/^[A-Z]+_EMBED_MODEL$/);
  });

  it('serves the default OVH models that the live /models listing has', () => {
    const listed = (JSON.parse(fixture('ovh-models.json')) as { data: { id: string }[] }).data.map((m) => m.id);
    const ovh = LANES.find((l) => l.service === 'ovh');
    for (const m of ovh?.models ?? []) expect(listed).toContain(m);
  });
});

describe('OVH keyless embeddings (recorded)', () => {
  it('embeds a batch with bge-m3, in order, normalized, without a key', async () => {
    const fetch = replayFetch([{ method: 'POST', url: OVH, response: { body: fixture('ovh-bge-m3.json') } }]);
    const vecs = await rungById('embed/ovh/bge-m3').embed(SENTENCES, testContext({ fetch }));
    expect(fetch.calls).toHaveLength(1);
    expect(fetch.calls[0]?.headers.authorization).toBeUndefined();
    expect(bodyOf(fetch.calls[0])).toEqual({ model: 'bge-m3', input: SENTENCES });
    expect(vecs).toHaveLength(SENTENCES.length);
    const raw = vectorsOf('ovh-bge-m3.json');
    vecs.forEach((v, i) => {
      expect(v).toHaveLength(1024);
      expect(norm(v)).toBeCloseTo(1, 12);
      expect(cosine(v, raw[i] as number[])).toBeCloseTo(1, 9);
    });
  });

  it('embeds with Qwen3-Embedding-8B at 4096 dimensions', async () => {
    const fetch = replayFetch([{ method: 'POST', url: OVH, response: { body: fixture('ovh-qwen3-embedding-8b.json') } }]);
    const vecs = await rungById('embed/ovh/Qwen3-Embedding-8B').embed(SENTENCES, testContext({ fetch }));
    expect(bodyOf(fetch.calls[0]).model).toBe('Qwen3-Embedding-8B');
    expect(bodyOf(fetch.calls[0]).input).toEqual(SENTENCES);
    expect(vecs.every((v) => v.length === 4096)).toBe(true);
  });

  it('splits more texts than the batch limit into ordered requests of at most 25', async () => {
    const texts = Array.from({ length: 30 }, (_, i) => SENTENCES[(i * 3) % SENTENCES.length] as string);
    const fetch = replayFetch([{ method: 'POST', url: OVH, response: bySentence('ovh-bge-m3.json') }]);
    const vecs = await rungById('embed/ovh/bge-m3').embed(texts, testContext({ fetch }));
    expect(fetch.calls.map((c) => bodyOf(c).input.length)).toEqual([25, 5]);
    expect(fetch.calls.flatMap((c) => bodyOf(c).input)).toEqual(texts);
    const raw = vectorsOf('ovh-bge-m3.json');
    texts.forEach((t, i) => {
      expect(cosine(vecs[i] as number[], raw[SENTENCES.indexOf(t)] as number[])).toBeCloseTo(1, 9);
    });
  });

  it('truncates a long transcript so OVH accepts it (it rejects the full text with HTTP 400)', async () => {
    const ctxJson = JSON.parse(
      readFileSync(new URL('../../../tests/fixtures/contexts/youtube-cCPsdFdlshc.json', import.meta.url), 'utf8'),
    ) as { transcript: { segments: { text: string }[] } };
    const t = ctxJson.transcript.segments.map((s) => s.text).join(' ');
    const long = `${t} ${t}`;
    const fetch = replayFetch([
      {
        method: 'POST',
        url: OVH,
        response: (call) =>
          bodyOf(call).input[0] === long
            ? { status: 400, body: fixture('ovh-context-overflow.400.json') }
            : { body: fixture('ovh-bge-m3-truncated.json') },
      },
    ]);
    const [v] = await rungById('embed/ovh/bge-m3').embed([long], testContext({ fetch }));
    const sent = bodyOf(fetch.calls[0]).input[0] as string;
    expect(sent.length).toBeLessThan(long.length);
    expect(long.startsWith(sent)).toBe(true);
    expect(long[sent.length]).toBe(' ');
    expect(estimateTokens(sent)).toBeLessThanOrEqual(8192 * TOKEN_HEADROOM);
    expect(v).toHaveLength(1024);
  });

  it('maps real OVH errors to error codes', async () => {
    const rung = rungById('embed/ovh/bge-m3');
    const run = async (status: number, file: string, headers?: Record<string, string>) => {
      const fetch = replayFetch([{ method: 'POST', url: OVH, response: { status, body: fixture(file), headers } }]);
      return rung.embed([SENTENCES[0] as string], testContext({ fetch })).catch((e: unknown) => e);
    };
    const notFound = await run(404, 'ovh-bad-model.404.json');
    expect(notFound).toBeInstanceOf(Vid2ContextError);
    expect(notFound).toMatchObject({ code: 'not-found', status: 404 });
    const tooMany = await run(400, 'ovh-batch-overflow.400.json');
    expect(tooMany).toMatchObject({ code: 'upstream', status: 400 });
    expect((tooMany as Error).message).toContain('"max":25');
    const limited = await run(429, 'ovh-rate-limited.429.json', { 'retry-after': '2' });
    expect(limited).toMatchObject({ code: 'rate-limited', retryAfterSec: 2 });
  });

  it('rejects empty texts before calling the service', async () => {
    const fetch = replayFetch([]);
    await expect(rungById('embed/ovh/bge-m3').embed(['ok', '  '], testContext({ fetch }))).rejects.toMatchObject({
      code: 'bad-request',
    });
    expect(fetch.calls).toHaveLength(0);
  });

  it('refuses vectors whose size does not match the configured model', async () => {
    // A server set up as nomic-embed-text (768) that actually serves bge-m3 (1024).
    const env = { OLLAMA_EMBED_MODEL: 'nomic-embed-text' };
    const fetch = replayFetch([
      { method: 'POST', url: 'http://localhost:11434/v1/embeddings', response: { body: fixture('ovh-bge-m3-single.json') } },
    ]);
    await expect(rungById('embed/ollama/nomic-embed-text', env).embed(['x'], testContext({ fetch, env }))).rejects.toMatchObject({
      code: 'upstream',
    });
  });

  it('measures dimensions on the first call for a model it does not know', async () => {
    const env = { LOCAL_EMBED_BASE_URL: 'http://127.0.0.1:23456/v1', LOCAL_EMBED_MODEL: 'some-new-model' };
    const rung = rungById('embed/local/some-new-model', env);
    expect(rung.dimensions).toBe(0);
    const fetch = replayFetch([
      { method: 'POST', url: 'http://127.0.0.1:23456/v1/embeddings', response: { body: fixture('ovh-bge-m3-single.json') } },
    ]);
    await rung.embed(['wherever you can always get parts for it'], testContext({ fetch, env }));
    expect(rung.dimensions).toBe(1024);
  });
});

describe('Cloudflare Workers AI (recorded)', () => {
  const env = { CLOUDFLARE_API_TOKEN: 'cf-token', CLOUDFLARE_ACCOUNT_ID: 'acct123' };

  it('embeds through the OpenAI-compatible route and normalizes slightly long vectors', async () => {
    const url = 'https://api.cloudflare.com/client/v4/accounts/acct123/ai/v1/embeddings';
    const fetch = replayFetch([{ method: 'POST', url, response: { body: fixture('cloudflare-bge-m3.json') } }]);
    const vecs = await rungById('embed/cloudflare/@cf/baai/bge-m3', env).embed(SENTENCES, testContext({ fetch, env }));
    expect(fetch.calls[0]?.headers.authorization).toBe('Bearer cf-token');
    expect(bodyOf(fetch.calls[0])).toEqual({ model: '@cf/baai/bge-m3', input: SENTENCES });
    const raw = vectorsOf('cloudflare-bge-m3.json');
    expect(Math.abs(norm(raw[0] as number[]) - 1)).toBeGreaterThan(1e-6);
    for (const v of vecs) expect(norm(v)).toBeCloseTo(1, 12);
  });
});

describe('request shape for services without a recording', () => {
  // These lanes were not verified live (no key). The tests check only what is sent; the replay has no answer.
  it('sends Jina its retrieval adapter instead of a text prefix', async () => {
    const env = { JINA_API_KEY: 'jina' };
    const rung = rungById('embed/jina/jina-embeddings-v3', env);
    const fetch = replayFetch([]);
    const ctx = testContext({ fetch, env });
    await rung.embed(['passage text'], ctx).catch(() => undefined);
    await rung.embedQueries(['query text'], ctx).catch(() => undefined);
    expect(bodyOf(fetch.calls[0])).toMatchObject({ input: ['passage text'], task: 'retrieval.passage' });
    expect(bodyOf(fetch.calls[1])).toMatchObject({ input: ['query text'], task: 'retrieval.query' });
  });

  it('prefixes Gemini Embedding 2 queries and documents per its docs', async () => {
    const env = { GEMINI_API_KEY: 'g' };
    const rung = rungById('embed/gemini/gemini-embedding-2', env);
    const fetch = replayFetch([]);
    const ctx = testContext({ fetch, env });
    await rung.embed(['oil changes'], ctx).catch(() => undefined);
    await rung.embedQueries(['oil changes'], ctx).catch(() => undefined);
    expect(fetch.calls[0]?.url).toBe('https://generativelanguage.googleapis.com/v1beta/openai/embeddings');
    expect(bodyOf(fetch.calls[0]).input).toEqual(['title: none | text: oil changes']);
    expect(bodyOf(fetch.calls[1]).input).toEqual(['task: search result | query: oil changes']);
  });
});

describe('text helpers', () => {
  it('leaves short text alone and never cuts inside a surrogate pair', () => {
    expect(truncateForEmbedding('short text', 512)).toBe('short text');
    const emoji = '\u{1F600}'.repeat(2000);
    const cut = truncateForEmbedding(emoji, 100);
    expect(cut.length % 2).toBe(0);
    expect(estimateTokens(cut)).toBeLessThanOrEqual(80);
  });

  it('cuts text without spaces (CJK) by characters within budget', () => {
    const han = '汽车的机油'.repeat(400);
    const cut = truncateForEmbedding(han, 512);
    expect(han.startsWith(cut)).toBe(true);
    expect(estimateTokens(cut)).toBeLessThanOrEqual(512 * TOKEN_HEADROOM);
    expect(cut.length).toBeGreaterThan(300);
  });

  it('splits batches by count and by estimated tokens, keeping order', () => {
    const texts = SENTENCES.concat(SENTENCES);
    expect(splitBatches(texts, 5).map((b) => [b.start, b.items.length])).toEqual([
      [0, 5],
      [5, 5],
      [10, 5],
      [15, 1],
    ]);
    const byTokens = splitBatches(texts, 100, 40);
    expect(byTokens.flatMap((b) => b.items)).toEqual(texts);
    for (const b of byTokens) {
      if (b.items.length > 1) expect(b.items.reduce((s, t) => s + estimateTokens(t), 0)).toBeLessThanOrEqual(40);
    }
  });

  it('normalizes vectors and compares only same-size vectors', () => {
    expect(l2normalize([3, 4])).toEqual([0.6, 0.8]);
    expect(l2normalize([0, 0])).toEqual([0, 0]);
    expect(() => cosine([1, 0], [1, 0, 0])).toThrow(Vid2ContextError);
  });

  it('knows the prefix conventions of e5, nomic and Qwen3', () => {
    expect(retrievalPrefixes('Xenova/multilingual-e5-small')).toEqual({ query: 'query: ', passage: 'passage: ' });
    expect(retrievalPrefixes('nomic-embed-text:latest')).toEqual({ query: 'search_query: ', passage: 'search_document: ' });
    expect(retrievalPrefixes('Qwen3-Embedding-8B').query).toMatch(/^Instruct: .*\nQuery: $/);
    expect(retrievalPrefixes('bge-m3')).toEqual({ query: '', passage: '' });
  });
});

describe('semantic sanity on recorded vectors', () => {
  // Pairs (0,1), (2,3), (4,5) say the same thing in different words; 6 and 7 are about other topics.
  const paraphrases: [number, number][] = [
    [0, 1],
    [2, 3],
    [4, 5],
  ];
  const unrelated: [number, number][] = [
    [0, 6],
    [2, 6],
    [4, 7],
    [5, 2],
    [1, 7],
  ];
  for (const file of ['ovh-bge-m3.json', 'ovh-qwen3-embedding-8b.json', 'cloudflare-bge-m3.json']) {
    it(`${file}: every paraphrase pair beats every unrelated pair`, () => {
      const v = vectorsOf(file);
      const c = ([a, b]: [number, number]) => cosine(v[a] as number[], v[b] as number[]);
      const worstParaphrase = Math.min(...paraphrases.map(c));
      const bestUnrelated = Math.max(...unrelated.map(c));
      expect(worstParaphrase).toBeGreaterThan(bestUnrelated);
    });
  }

  it('the same model on two hosts gives nearly the same vectors, but a different model does not', () => {
    const ovh = vectorsOf('ovh-bge-m3.json');
    const cf = vectorsOf('cloudflare-bge-m3.json');
    for (let i = 0; i < SENTENCES.length; i++) expect(cosine(ovh[i] as number[], cf[i] as number[])).toBeGreaterThan(0.99);
    const qwen = vectorsOf('ovh-qwen3-embedding-8b.json');
    expect(() => cosine(ovh[0] as number[], qwen[0] as number[])).toThrow(Vid2ContextError);
  });
});

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createContext, rankRungs } from '@vid2context/core';
import { cosine } from '@vid2context/provider-embed';
import { describe, expect, it } from 'vitest';
import { poolingFor, RECOMMENDED_MODEL, type TensorLike, toVectors, transformersEmbedRungs } from '../src/index.ts';

// Real Transformers.js output recorded 2026-11-14 (see test/fixtures/README.md).
const recorded = JSON.parse(
  readFileSync(join(import.meta.dirname, 'fixtures', 'multilingual-e5-small-q8.passages.json'), 'utf8'),
) as TensorLike & { model: string };
const SENTENCES: string[] = JSON.parse(
  readFileSync(new URL('../../embed/test/fixtures/sentences.json', import.meta.url), 'utf8'),
);

describe('rung from env', () => {
  it('is off until TRANSFORMERS_EMBED_MODEL is set, and lists what it needs', () => {
    const [rung] = transformersEmbedRungs({});
    expect(rung?.id).toBe(`embed/transformers/${RECOMMENDED_MODEL}`);
    expect(rung?.requires).toEqual(['TRANSFORMERS_EMBED_MODEL']);
    expect(rankRungs(transformersEmbedRungs({}), {}, {})).toEqual([]);
  });

  it('runs locally with the configured model, known dimensions and e5 prefixes', () => {
    const env = { TRANSFORMERS_EMBED_MODEL: RECOMMENDED_MODEL };
    const [rung] = rankRungs(transformersEmbedRungs(env), { policy: 'local-only' }, env);
    expect(rung).toMatchObject({ tier: 'local', dimensions: 384, maxInputTokens: 512 });
    expect(rung?.capabilities).toContain('prefixes');
  });

  it('measures dimensions for a model it does not know', () => {
    const [rung] = transformersEmbedRungs({ TRANSFORMERS_EMBED_MODEL: 'someone/new-onnx-model' });
    expect(rung?.dimensions).toBe(0);
  });

  it('pools bge with CLS and everything else with the mean', () => {
    expect(poolingFor('Xenova/bge-small-en-v1.5')).toBe('cls');
    expect(poolingFor(RECOMMENDED_MODEL)).toBe('mean');
  });
});

describe('recorded output', () => {
  it('splits the [8, 384] tensor into eight unit vectors in order', () => {
    const vecs = toVectors(recorded);
    expect(recorded.dims).toEqual([8, 384]);
    expect(vecs).toHaveLength(8);
    for (const v of vecs) {
      expect(v).toHaveLength(384);
      expect(Math.sqrt(v.reduce((s, x) => s + x * x, 0))).toBeCloseTo(1, 5);
    }
    expect(vecs[1]?.[0]).toBe(recorded.data[384]);
  });

  it('rejects a tensor whose shape does not match its data', () => {
    expect(() => toVectors({ dims: [2, 384], data: recorded.data })).toThrow(/shape/);
  });

  it('ranks every paraphrase pair above every unrelated pair', () => {
    const v = toVectors(recorded);
    const c = (a: number, b: number) => cosine(v[a] as number[], v[b] as number[]);
    const worstParaphrase = Math.min(c(0, 1), c(2, 3), c(4, 5));
    const bestUnrelated = Math.max(c(0, 6), c(2, 6), c(4, 7), c(5, 2), c(1, 7));
    expect(worstParaphrase).toBeGreaterThan(bestUnrelated);
  });
});

// Live: downloads the model (118 MB) on first run into $VID2CONTEXT_HOME/models or .vid2context/models.
describe.skipIf(!process.env.LIVE)('Transformers.js in Node (live)', () => {
  it('embeds real sentences and matches the recording', async () => {
    const env = { TRANSFORMERS_EMBED_MODEL: RECOMMENDED_MODEL, VID2CONTEXT_HOME: process.env.VID2CONTEXT_HOME ?? '' };
    const [rung] = transformersEmbedRungs(env);
    const ctx = createContext({ runtime: 'node', env });
    const vecs = (await rung?.embed(SENTENCES, ctx)) ?? [];
    expect(vecs.map((v) => v.length)).toEqual(Array(8).fill(384));
    const rec = toVectors(recorded);
    for (const [i, v] of vecs.entries()) expect(cosine(v, rec[i] as number[])).toBeGreaterThan(0.999);
    const [q] = (await rung?.embedQueries(['which truck drinks oil between oil changes?'], ctx)) ?? [];
    const scores = vecs.map((v) => cosine(q as number[], v));
    expect(scores.indexOf(Math.max(...scores))).toBeLessThanOrEqual(1);
  }, 300_000);
});

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createContext, type Env, Registry } from '@vid2context/core';
import { describe, expect, it } from 'vitest';
import provider, { cosine, embedQuery, embedWithModel, pickEmbedModel } from '../src/index.ts';

const SENTENCES: string[] = JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures', 'sentences.json'), 'utf8'));

// Live: real OVH keyless calls (2 requests per minute per model per IP), and Cloudflare when its credentials are set.
describe.skipIf(!process.env.LIVE)('embedding rungs (live)', () => {
  const env: Env = { ...(process.env as Env) };
  const registry = new Registry([provider], 'node');
  const ctx = createContext({ runtime: 'node', env });

  it('embeds through OVH bge-m3 with no key and ranks paraphrases above unrelated text', async () => {
    const keyless: Env = { ...env, VID2CONTEXT_EMBED_MODEL: '' };
    for (const k of Object.keys(keyless)) if (/_API_KEY$|_API_TOKEN$|_EMBED_MODEL$/.test(k)) delete keyless[k];
    expect(pickEmbedModel(registry, keyless)).toBe('embed/ovh/bge-m3');
    const [a, b, c] = await embedWithModel(
      registry,
      'embed/ovh/bge-m3',
      [SENTENCES[0], SENTENCES[1], SENTENCES[6]] as string[],
      ctx,
    );
    expect(a).toHaveLength(1024);
    expect(cosine(a as number[], b as number[])).toBeGreaterThan(cosine(a as number[], c as number[]));
  }, 120_000);

  it('embeds a Qwen3-Embedding-8B query at 4096 dimensions', async () => {
    const q = await embedQuery(registry, { model: 'embed/ovh/Qwen3-Embedding-8B' }, 'which truck drinks oil?', ctx);
    expect(q).toHaveLength(4096);
  }, 120_000);

  it.skipIf(!process.env.CLOUDFLARE_API_TOKEN || !process.env.CLOUDFLARE_ACCOUNT_ID)(
    'embeds through Cloudflare Workers AI bge-m3',
    async () => {
      const vecs = await embedWithModel(registry, 'embed/cloudflare/@cf/baai/bge-m3', SENTENCES.slice(0, 2), ctx);
      expect(vecs.map((v) => v.length)).toEqual([1024, 1024]);
    },
    60_000,
  );
});

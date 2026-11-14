/**
 * Embeds three real transcript sentences with zero configuration (OVH keyless
 * bge-m3) through the Node registry, and prints the dimensions and pairwise
 * cosines. Run: npx tsx providers/embed/scripts/keyless-demo.ts
 */
import { readFileSync } from 'node:fs';
import { createContext } from '@vid2context/core';
import { createRegistry } from '@vid2context/registry/node';
import { cosine, embedWithModel, pickEmbedModel } from '../src/index.ts';

const sentences: string[] = JSON.parse(readFileSync(new URL('../test/fixtures/sentences.json', import.meta.url), 'utf8'));
const texts = [sentences[0], sentences[1], sentences[6]] as string[];

// An empty env on purpose: no keys, no local servers, only the keyless rungs.
const env = {};
const registry = createRegistry();
const ctx = createContext({ runtime: 'node', env });
/** Program output goes to stdout; logs from the rungs go to stderr. */
const out = (line: string) => process.stdout.write(`${line}\n`);

out(
  `enabled embed rungs: ${registry
    .embedRungs(env)
    .filter((r) => r.isEnabled?.(env) ?? true)
    .map((r) => r.id)
    .join(', ')}`,
);
const model = pickEmbedModel(registry, env);
const vectors = await embedWithModel(registry, model, texts, ctx);
out(`model: ${model}`);
out(`dimensions: ${vectors.map((v) => v.length).join(', ')}`);
for (const [i, t] of texts.entries()) out(`[${i}] ${t}`);
for (let i = 0; i < vectors.length; i++) {
  for (let j = i + 1; j < vectors.length; j++) {
    out(`cosine(${i}, ${j}) = ${cosine(vectors[i] as number[], vectors[j] as number[]).toFixed(4)}`);
  }
}

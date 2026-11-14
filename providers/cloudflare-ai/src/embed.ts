/**
 * Workers AI embeddings: { text: string[] } in, { data: number[][], shape } out.
 * Batches of at most 100 texts (the model's maxItems).
 */
import { type Ctx, Vid2ContextError } from '@vid2context/core';
import { runModel, type Transport } from './transport.ts';

/** Output dimensions, from the recorded bge-m3 response and the catalog's output_dimensions property (2026-11-14). */
export const EMBED_DIMENSIONS: Record<string, number> = {
  '@cf/baai/bge-m3': 1024,
  '@cf/baai/bge-large-en-v1.5': 1024,
  '@cf/baai/bge-base-en-v1.5': 768,
  '@cf/baai/bge-small-en-v1.5': 384,
};

const BATCH = 100;

export async function embedTexts(t: Transport, model: string, texts: string[], ctx: Ctx, label: string): Promise<number[][]> {
  const out: number[][] = [];
  for (let i = 0; i < texts.length; i += BATCH) {
    const batch = texts.slice(i, i + BATCH);
    const result = (await runModel(ctx, t, model, { json: { text: batch, truncate_inputs: true } }, { label })) as {
      data?: number[][];
    };
    if (!Array.isArray(result?.data) || result.data.length !== batch.length) {
      throw new Vid2ContextError('upstream', `${label}: expected ${batch.length} embeddings, got ${result?.data?.length ?? 0}.`);
    }
    out.push(...result.data);
  }
  return out;
}

/**
 * Client for OpenAI-compatible POST /embeddings. Plain fetch, so it runs on
 * Node, Workers and in the browser. OVH, Cloudflare (/ai/v1/embeddings),
 * Gemini (/v1beta/openai/embeddings), Mistral, Jina, Ollama (/v1/embeddings),
 * LM Studio and OpenAI all accept { model, input: string[] } and answer with
 * { data: [{ index, embedding }] }.
 */
import { type Ctx, errorFromResponse, fetchWithTimeout, Vid2ContextError } from '@vid2context/core';

export interface EmbedEndpoint {
  /** Full embeddings URL. */
  url: string;
  model: string;
  /** Omitted for keyless and most local endpoints. */
  key?: string;
  label: string;
  timeoutMs?: number;
}

interface EmbeddingsResponse {
  data?: { index?: number; embedding?: unknown }[];
}

/** Embed one batch. Returns vectors in input order, exactly one per input. */
export async function postEmbeddings(
  ep: EmbedEndpoint,
  input: string[],
  ctx: Ctx,
  extraBody?: Record<string, unknown>,
): Promise<number[][]> {
  const res = await fetchWithTimeout(
    ctx,
    ep.url,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(ep.key ? { authorization: `Bearer ${ep.key}` } : {}) },
      body: JSON.stringify({ model: ep.model, input, ...(extraBody ?? {}) }),
    },
    ep.timeoutMs ?? 120_000,
  );
  if (!res.ok) throw await errorFromResponse(res, `${ep.label} embeddings`);
  const json = (await res.json()) as EmbeddingsResponse;
  const data = Array.isArray(json.data) ? json.data : [];
  if (data.length !== input.length) {
    throw new Vid2ContextError('upstream', `${ep.label} embeddings: got ${data.length} vectors for ${input.length} inputs.`);
  }
  const out: number[][] = new Array(input.length);
  data.forEach((d, pos) => {
    const i = typeof d.index === 'number' ? d.index : pos;
    const v = d.embedding;
    if (!Array.isArray(v) || v.length === 0 || typeof v[0] !== 'number' || i < 0 || i >= input.length) {
      throw new Vid2ContextError('upstream', `${ep.label} embeddings: malformed vector at position ${pos}.`);
    }
    out[i] = v as number[];
  });
  for (let i = 0; i < out.length; i++) {
    if (!out[i]) throw new Vid2ContextError('upstream', `${ep.label} embeddings: no vector for input ${i}.`);
  }
  return out;
}

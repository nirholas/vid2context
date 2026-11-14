/**
 * Optional LLM rerank of the fused top candidates. One chat call through the
 * free-first LLM chain (local, then free tiers, then keyless) asks for a JSON
 * relevance score from 0 to 10 per candidate. Off by default: it costs one
 * LLM request per search and adds a second or more of latency.
 *
 * A local cross-encoder (Transformers.js) is left out on purpose: it would
 * need a 100 MB+ model download and an ONNX runtime, which is not practical
 * in Workers and slow to cold-start in the browser, while this package
 * declares all three runtimes.
 */

import type { ChainOptions, Ctx, Registry } from '@vid2context/core';
import { chat, Vid2ContextError } from '@vid2context/core';

export interface RerankCandidate {
  id: string;
  title: string;
  text: string;
}

export interface RerankResult {
  /** Score 0 to 10 per candidate id; candidates the model skipped are absent. */
  scores: Map<string, number>;
  rung: string;
  model: string;
}

/** Longest candidate text sent to the model, in characters. */
const MAX_CANDIDATE_CHARS = 700;

export function rerankMessages(query: string, candidates: RerankCandidate[]) {
  const list = candidates
    .map((c, i) => `[${i + 1}] (${c.title.slice(0, 80)})\n${c.text.slice(0, MAX_CANDIDATE_CHARS)}`)
    .join('\n\n');
  return [
    {
      role: 'system' as const,
      content:
        'You rank transcript excerpts for a search engine. For each numbered excerpt, rate how well it answers or ' +
        'discusses the query, from 0 (unrelated) to 10 (directly answers it). Excerpts are auto-captions: ignore ' +
        'spelling and missing punctuation, and count paraphrases and synonyms as matches. Reply with JSON only: ' +
        '{"scores":[{"n":1,"score":7},{"n":2,"score":0}]} with one entry per excerpt.',
    },
    { role: 'user' as const, content: `Query: ${query}\n\nExcerpts:\n\n${list}` },
  ];
}

/** Parse the model's reply into scores by candidate index (1-based). Tolerates prose or code fences around the JSON. */
export function parseRerankReply(text: string, count: number): Map<number, number> {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) {
    throw new Vid2ContextError('upstream', 'The rerank model did not return JSON.', {
      hint: 'Retry, or search without rerank.',
    });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch {
    throw new Vid2ContextError('upstream', 'The rerank model returned malformed JSON.', {
      hint: 'Retry, or search without rerank.',
    });
  }
  const out = new Map<number, number>();
  const list = (parsed as { scores?: unknown }).scores;
  if (Array.isArray(list)) {
    for (const entry of list) {
      const e = entry as { n?: unknown; id?: unknown; score?: unknown };
      const n = Number(e.n ?? e.id);
      const score = Number(e.score);
      if (Number.isInteger(n) && n >= 1 && n <= count && Number.isFinite(score)) out.set(n, Math.max(0, Math.min(10, score)));
    }
  }
  if (out.size === 0) {
    throw new Vid2ContextError('upstream', 'The rerank model returned no usable scores.', {
      hint: 'Retry, or search without rerank.',
    });
  }
  return out;
}

export async function rerank(
  registry: Registry,
  query: string,
  candidates: RerankCandidate[],
  ctx: Ctx,
  chain: ChainOptions = {},
): Promise<RerankResult> {
  const res = await chat(
    registry,
    { messages: rerankMessages(query, candidates), json: true, temperature: 0, maxTokens: 1000 + candidates.length * 24 },
    chain,
    ctx,
  );
  const byIndex = parseRerankReply(res.text, candidates.length);
  const scores = new Map<string, number>();
  for (const [n, score] of byIndex) {
    const c = candidates[n - 1];
    if (c) scores.set(c.id, score);
  }
  return { scores, rung: res.rung, model: res.model };
}

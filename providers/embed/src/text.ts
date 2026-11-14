/**
 * Text and vector helpers shared by every embedding rung: safe truncation,
 * L2 normalization, cosine similarity, batching, and the retrieval prefixes
 * some models were trained with.
 */
import { estimateTokens, Vid2ContextError } from '@vid2context/core';

/**
 * Share of a model's input window we fill. estimateTokens is a heuristic tuned
 * on OpenAI and Llama tokenizers; on a real 39,733-character transcript it said
 * 8,966 tokens where bge-m3 (XLM-RoBERTa) counted 9,382, about 5% more. 80%
 * leaves room for that and for scripts the estimate handles less well.
 */
export const TOKEN_HEADROOM = 0.8;

/** How far back from the cut point we look for whitespace before cutting mid-word (CJK text has none). */
const WORD_BOUNDARY_WINDOW = 0.2;

/**
 * Shorten `text` so it fits in `maxTokens` with headroom, cutting on a word
 * boundary when one is near. Text that already fits is returned unchanged.
 */
export function truncateForEmbedding(text: string, maxTokens: number): string {
  const budget = Math.floor(maxTokens * TOKEN_HEADROOM);
  let est = estimateTokens(text);
  if (est <= budget) return text;
  let cut = text;
  while (est > budget && cut.length > 0) {
    const target = Math.max(1, Math.floor(cut.length * (budget / est) * 0.98));
    let end = target;
    const space = cut.lastIndexOf(' ', target);
    const nl = cut.lastIndexOf('\n', target);
    const boundary = Math.max(space, nl);
    if (boundary > target * (1 - WORD_BOUNDARY_WINDOW)) end = boundary;
    // Never split a UTF-16 surrogate pair.
    const code = cut.charCodeAt(end - 1);
    if (code >= 0xd800 && code <= 0xdbff) end -= 1;
    cut = cut.slice(0, end).trimEnd();
    est = estimateTokens(cut);
  }
  return cut;
}

/** Scale a vector to unit length so cosine similarity and dot product agree. A zero vector is returned as is. */
export function l2normalize(v: number[]): number[] {
  let sum = 0;
  for (const x of v) sum += x * x;
  if (sum === 0) return v;
  const n = Math.sqrt(sum);
  return v.map((x) => x / n);
}

/** Cosine similarity of two vectors of the same length. */
export function cosine(a: number[], b: number[]): number {
  if (a.length !== b.length) {
    throw new Vid2ContextError('bad-request', `Cannot compare vectors of ${a.length} and ${b.length} dimensions.`, {
      hint: 'Vectors from different embedding models are not comparable. Embed the query with the model the index was built with.',
    });
  }
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i] as number;
    const y = b[i] as number;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  return na === 0 || nb === 0 ? 0 : dot / Math.sqrt(na * nb);
}

export interface Batch {
  /** Index of the first item in the original array. */
  start: number;
  items: string[];
}

/**
 * Split texts into consecutive batches of at most `maxBatch` items and, when
 * given, at most `maxBatchTokens` estimated tokens. Order is preserved and a
 * single oversized item still gets a batch of its own.
 */
export function splitBatches(texts: string[], maxBatch: number, maxBatchTokens?: number): Batch[] {
  const out: Batch[] = [];
  let tokens = 0;
  for (let i = 0; i < texts.length; i++) {
    const t = texts[i] as string;
    const est = maxBatchTokens ? estimateTokens(t) : 0;
    const cur = out[out.length - 1];
    if (cur && cur.items.length < maxBatch && (maxBatchTokens === undefined || tokens + est <= maxBatchTokens)) {
      cur.items.push(t);
      tokens += est;
    } else {
      out.push({ start: i, items: [t] });
      tokens = est;
    }
  }
  return out;
}

export interface RetrievalPrefixes {
  /** Prepended to search queries. */
  query: string;
  /** Prepended to indexed passages. */
  passage: string;
}

const QWEN3_QUERY = 'Instruct: Given a web search query, retrieve relevant passages that answer the query\nQuery: ';
const BGE_EN_QUERY = 'Represent this sentence for searching relevant passages: ';

/**
 * The query and passage prefixes a model was trained with, from each model's
 * card. Using them matters: e5 and nomic models score noticeably worse
 * without them. Models not listed (bge-m3, mistral-embed, OpenAI) use none.
 */
export function retrievalPrefixes(model: string): RetrievalPrefixes {
  const m = model.toLowerCase();
  if (m.includes('e5-') || m.endsWith('e5') || m.includes('/e5')) return { query: 'query: ', passage: 'passage: ' };
  if (m.includes('nomic-embed')) return { query: 'search_query: ', passage: 'search_document: ' };
  if (m.includes('qwen3-embedding') || m.includes('qwen3_embedding')) return { query: QWEN3_QUERY, passage: '' };
  if (m.includes('gemini-embedding-2')) return { query: 'task: search result | query: ', passage: 'title: none | text: ' };
  if (m.includes('mxbai-embed') || m.includes('snowflake-arctic-embed')) return { query: BGE_EN_QUERY, passage: '' };
  if (/bge-(small|base|large)-en/.test(m)) return { query: BGE_EN_QUERY, passage: '' };
  return { query: '', passage: '' };
}

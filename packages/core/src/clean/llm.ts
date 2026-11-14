/**
 * Optional LLM punctuation pass. The text is cut into chunks of about 1500
 * words (each chunk also gets a few words before it as context) and sent
 * through the normal LLM rung chain (local first, then free tiers, then
 * keyless) with an instruction to add punctuation and capitalization only.
 *
 * Every answer is verified: after lowercasing and stripping punctuation, its
 * word sequence must equal the input's. A chunk that fails keeps its original
 * text and is counted in the report, so the model can never change what was
 * said. Punctuated words are mapped back onto segments by word index, so
 * segment timings stay exact.
 */
import { Vid2ContextError } from '../errors.ts';
import { chat } from '../pipeline.ts';
import type { ChainOptions } from '../provider.ts';
import type { Registry } from '../registry.ts';
import type { Ctx, Transcript } from '../types.ts';
import { addCleanExample, type CleanLlmStats, type CleanReport, cleanSplitWords, emptyCleanReport } from './report.ts';

export interface PunctuateWithLlmOptions {
  /** Words per chunk. Default 1500. */
  chunkWords?: number;
  /** Words of preceding text sent with each chunk for context. Default 8. */
  overlapWords?: number;
  chain?: ChainOptions;
}

export interface PunctuationChunk {
  /** First word sent (includes the overlap). */
  from: number;
  /** First word this chunk owns. */
  start: number;
  /** One past the last word. */
  end: number;
}

export const PUNCTUATION_SYSTEM_PROMPT = [
  'You restore punctuation and capitalization in speech transcripts.',
  'Return exactly the same words in exactly the same order.',
  'Do not add, remove, merge, split, reorder, correct, translate or spell out any word, and keep numbers as written.',
  'Only add punctuation marks and change letter case.',
  'Reply with the punctuated text only.',
].join(' ');

/** Chunk boundaries over `words` words. */
export function planPunctuationChunks(words: number, chunkWords = 1500, overlapWords = 8): PunctuationChunk[] {
  const size = Math.max(1, chunkWords);
  const out: PunctuationChunk[] = [];
  for (let start = 0; start < words; start += size) {
    out.push({ from: Math.max(0, start - Math.max(0, overlapWords)), start, end: Math.min(words, start + size) });
  }
  return out;
}

function wordKey(word: string): string {
  return word.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
}

/**
 * Align a punctuated answer with the input words. Returns the new spelling of
 * every input word, or null when the answer's word sequence differs.
 * Input words with no letters or digits (a lone "-") keep their spelling;
 * stray punctuation tokens in the answer attach to the word before them.
 */
export function alignPunctuatedWords(input: readonly string[], answer: string): string[] | null {
  const outTokens = cleanSplitWords(
    answer
      .trim()
      .replace(/^```[a-z]*\s*/i, '')
      .replace(/\s*```$/, ''),
  );
  const keyed: string[] = [];
  for (const t of outTokens) {
    if (wordKey(t)) keyed.push(t);
    else if (keyed.length > 0) keyed[keyed.length - 1] += t;
  }
  const result = [...input];
  let k = 0;
  for (let i = 0; i < input.length; i++) {
    const want = wordKey(input[i] ?? '');
    if (!want) continue;
    const got = keyed[k];
    if (got === undefined || wordKey(got) !== want) return null;
    result[i] = got;
    k++;
  }
  return k === keyed.length ? result : null;
}

export async function punctuateWithLlm(
  transcript: Transcript,
  registry: Registry,
  ctx: Ctx,
  opts: PunctuateWithLlmOptions = {},
): Promise<{ transcript: Transcript; report: CleanReport }> {
  const report = emptyCleanReport('punctuate-llm');
  const stats: CleanLlmStats = { chunks: 0, accepted: 0, rejected: 0, failed: 0, rungs: [], attempts: [] };
  report.llm = stats;

  const words: string[] = [];
  const owner: number[] = [];
  transcript.segments.forEach((s, i) => {
    for (const w of cleanSplitWords(s.text)) {
      words.push(w);
      owner.push(i);
    }
  });
  const fixed = [...words];
  const chunks = planPunctuationChunks(words.length, opts.chunkWords, opts.overlapWords);
  stats.chunks = chunks.length;

  for (const c of chunks) {
    const input = words.slice(c.from, c.end);
    let answer: string;
    try {
      const res = await chat(
        registry,
        {
          messages: [
            { role: 'system', content: PUNCTUATION_SYSTEM_PROMPT },
            { role: 'user', content: input.join(' ') },
          ],
          temperature: 0,
          maxTokens: Math.ceil(input.length * 3) + 256,
        },
        opts.chain ?? {},
        ctx,
      );
      stats.attempts.push(...res.attempts);
      answer = res.text;
      const aligned = alignPunctuatedWords(input, answer);
      if (!aligned) {
        stats.rejected++;
        addCleanExample(report, {
          atSec: transcript.segments[owner[c.start] ?? 0]?.startSec ?? 0,
          before: input.slice(c.start - c.from, c.start - c.from + 30).join(' '),
          after: cleanSplitWords(answer).slice(0, 30).join(' '),
          rule: 'llm-rejected',
        });
        ctx.log.warn('llm punctuation changed words; keeping the original chunk', { rung: res.rung, start: c.start });
        continue;
      }
      for (let i = c.start; i < c.end; i++) fixed[i] = aligned[i - c.from] ?? words[i] ?? '';
      stats.accepted++;
      if (!stats.rungs.includes(res.rung)) stats.rungs.push(res.rung);
    } catch (err) {
      if (err instanceof Vid2ContextError && err.code === 'no-provider') throw err;
      stats.failed++;
      ctx.log.warn('llm punctuation chunk failed; keeping the original chunk', {
        start: c.start,
        error: err instanceof Error ? err.message.slice(0, 200) : String(err),
      });
    }
  }

  const perSeg = transcript.segments.map(() => [] as string[]);
  fixed.forEach((w, i) => {
    perSeg[owner[i] ?? 0]?.push(w);
  });
  const segments = transcript.segments.map((s, i) => {
    const list = perSeg[i] ?? [];
    if (list.length === 0) return { ...s };
    const text = list.join(' ');
    if (text === cleanSplitWords(s.text).join(' ')) return { ...s };
    report.rewritten++;
    addCleanExample(report, { atSec: s.startSec, before: s.text, after: text, rule: 'llm-punctuation' });
    return { ...s, text };
  });
  return { transcript: { ...transcript, segments }, report };
}

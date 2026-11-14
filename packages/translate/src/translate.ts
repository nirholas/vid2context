/**
 * translateContext(): the transcript of a video in another language, as a new
 * Transcript next to the raw one (which is never changed).
 *
 * Order of attempts, free and cheapest first:
 *   1. The source transcript is already in the target language: returned as is.
 *   2. The platform has a track in the target language, or machine-translates
 *      one (YouTube `tlang`): fetched through the pipeline in captions mode,
 *      accepted when its language matches.
 *   3. The LLM rung chain (local, free, keyless, then paid) translates the
 *      segments in chunks. Each chunk must come back with the same ids; a bad
 *      chunk is retried once with the problem explained, and on a second
 *      failure keeps its original text, recorded in the report.
 */
import {
  type Attempt,
  attemptsOf,
  type ChainOptions,
  type ChatRequest,
  type Ctx,
  chat,
  getVideoContext,
  type Registry,
  type Transcript,
  Vid2ContextError,
  type VideoContext,
} from '@vid2context/core';
import { chunkItems, chunkRequest, DEFAULT_CHUNK_TOKENS, type Item, parseItems, retryRequest, verifyItems } from './chunks.ts';
import { buildGlossary } from './glossary.ts';
import { isLanguageTag, sameLanguage } from './languages.ts';

export interface TranslateOptions {
  /** Target language, BCP-47 (`en`, `de`, `pt-BR`). */
  language: string;
  /** Terms to keep exactly as written, on top of the channel name and terms found in the title and description. */
  glossary?: string[];
  /** Try the platform's own track or translation first. Default true. */
  platform?: boolean;
  /** Allow LLM translation when the platform has nothing. Default true. */
  llm?: boolean;
  /** Rung chain options for the LLM step. */
  chain?: ChainOptions;
  /** Transcript tokens per LLM chunk. Default 1500. */
  chunkTokens?: number;
}

export interface FailedChunk {
  chunk: number;
  firstId: number;
  lastId: number;
  /** What was wrong with the last answer, or the error when no rung answered. */
  reason: string;
}

export interface TranslationReport {
  chunks: number;
  /** Chunks that needed their one retry (0-based). */
  retried: number[];
  /** Chunks that kept their original text after the retry also failed. */
  failed: FailedChunk[];
  /** Segments still in the source language because their chunk failed. */
  untranslatedSegments: number;
}

export interface TranslationResult {
  /** The new transcript in the target language. The input context is unchanged. */
  transcript: Transcript;
  /** `source`: already in the language; `platform`: the platform's track or translation; `llm`: translated by the rung chain. */
  via: 'source' | 'platform' | 'llm';
  /** Caption provider id (platform) or the rung id that translated the first chunk (llm). */
  producer: string;
  /** Every rung that answered, for llm. */
  rungs: string[];
  model?: string;
  glossary: string[];
  report: TranslationReport;
  attempts: Attempt[];
  notes: string[];
}

const emptyReport = (): TranslationReport => ({ chunks: 0, retried: [], failed: [], untranslatedSegments: 0 });

/** Try the platform: a track in the language, or its machine translation, through the pipeline in captions mode (no audio download). */
async function platformTranslation(
  registry: Registry,
  context: VideoContext,
  language: string,
  ctx: Ctx,
  attempts: Attempt[],
  notes: string[],
): Promise<Transcript | null> {
  const ref = context.metadata.ref;
  if (!registry.captions().some((p) => p.supports(ref))) return null;
  try {
    const got = await getVideoContext(registry, ref.url ?? ref.input, { language, mode: 'captions', refresh: true }, ctx);
    attempts.push(...got.attempts.filter((a) => a.stage === 'captions'));
    if (sameLanguage(got.transcript.language, language)) return got.transcript;
    notes.push(`The platform returned ${got.transcript.language} captions, not ${language}.`);
  } catch (err) {
    attempts.push(...attemptsOf(err).filter((a) => a.stage === 'captions'));
    ctx.log.info('no platform translation', { language, error: err instanceof Error ? err.message : String(err) });
  }
  return null;
}

interface ChunkOutcome {
  texts?: Map<number, string>;
  rung?: string;
  model?: string;
  retried: boolean;
  problem?: string;
}

async function ask(
  registry: Registry,
  req: ChatRequest,
  chain: ChainOptions,
  ctx: Ctx,
  attempts: Attempt[],
): Promise<{ text: string; rung: string; model: string } | { error: string; fatal: boolean }> {
  try {
    const res = await chat(registry, req, { ...chain, needs: [...(chain.needs ?? []), 'json'] }, ctx);
    attempts.push(...res.attempts);
    return { text: res.text, rung: res.rung, model: res.model };
  } catch (err) {
    attempts.push(...attemptsOf(err));
    const fatal = err instanceof Vid2ContextError && (err.code === 'no-provider' || err.code === 'bad-request');
    return { error: err instanceof Error ? err.message : String(err), fatal };
  }
}

async function translateChunk(
  registry: Registry,
  chunk: Item[],
  first: ChatRequest,
  chain: ChainOptions,
  ctx: Ctx,
  attempts: Attempt[],
): Promise<ChunkOutcome> {
  let req = first;
  let problem = '';
  for (let round = 0; round < 2; round++) {
    const res = await ask(registry, req, chain, ctx, attempts);
    if ('error' in res) {
      problem = res.error;
      if (res.fatal) return { retried: round > 0, problem };
      req = first;
      continue;
    }
    const checked = verifyItems(parseItems(res.text), chunk);
    if ('texts' in checked) return { texts: checked.texts, rung: res.rung, model: res.model, retried: round > 0 };
    problem = checked.problem;
    attempts.push({ id: res.rung, stage: 'llm', outcome: 'error', reason: 'bad-segments', detail: problem.slice(0, 300) });
    req = retryRequest(first, res.text, problem, chunk);
  }
  return { retried: true, problem };
}

/** Translate a video's transcript into `opts.language`. Returns a new Transcript; never changes `context`. */
export async function translateContext(
  registry: Registry,
  context: VideoContext,
  opts: TranslateOptions,
  ctx: Ctx,
): Promise<TranslationResult> {
  const language = opts.language?.trim() ?? '';
  if (!isLanguageTag(language)) {
    throw new Vid2ContextError('bad-request', `"${language.slice(0, 40)}" is not a language code.`, {
      hint: 'Pass a BCP-47 code such as "en", "de" or "pt-BR".',
    });
  }
  const source = context.transcript;
  const glossary = buildGlossary(context.metadata, opts.glossary ?? []);
  const attempts: Attempt[] = [];
  const notes: string[] = [];
  const base = { glossary, attempts, notes, rungs: [] as string[], report: emptyReport() };

  if (sameLanguage(source.language, language)) {
    return { ...base, transcript: source, via: 'source', producer: source.producer, model: source.model };
  }

  if (opts.platform !== false) {
    const platform = await platformTranslation(registry, context, language, ctx, attempts, notes);
    if (platform) return { ...base, transcript: platform, via: 'platform', producer: platform.producer, model: platform.model };
  }

  if (opts.llm === false) {
    throw Object.assign(
      new Vid2ContextError('no-transcript', `The platform has no ${language} transcript for ${context.metadata.ref.id}.`, {
        hint: 'Allow LLM translation (translate=1 on the HTTP API, llm: true in code).',
      }),
      { attempts },
    );
  }
  if (source.segments.length === 0) {
    throw new Vid2ContextError(
      'no-transcript',
      `The transcript of ${context.metadata.ref.id} is empty; there is nothing to translate.`,
      {
        hint: 'Retry with mode "stt" to transcribe the audio first.',
      },
    );
  }

  const items: Item[] = source.segments.map((s, id) => ({ id, text: s.text }));
  const chunks = chunkItems(items, opts.chunkTokens ?? DEFAULT_CHUNK_TOKENS);
  const chain = opts.chain ?? {};
  const texts = new Map<number, string>();
  const report: TranslationReport = { chunks: chunks.length, retried: [], failed: [], untranslatedSegments: 0 };
  const rungs: string[] = [];
  let model: string | undefined;

  for (const [index, chunk] of chunks.entries()) {
    const req = chunkRequest({
      chunk,
      target: language,
      source: source.language,
      glossary,
      origin: context.metadata.ref.url ?? context.metadata.ref.id,
    });
    const out = await translateChunk(registry, chunk, req, chain, ctx, attempts);
    if (out.retried) report.retried.push(index);
    if (out.texts && out.rung) {
      for (const [id, t] of out.texts) texts.set(id, t);
      if (!rungs.includes(out.rung)) rungs.push(out.rung);
      model ??= out.model;
      continue;
    }
    report.failed.push({
      chunk: index,
      firstId: chunk[0]?.id ?? 0,
      lastId: chunk.at(-1)?.id ?? 0,
      reason: out.problem ?? 'unknown',
    });
    report.untranslatedSegments += chunk.length;
  }

  if (texts.size === 0) {
    throw Object.assign(
      new Vid2ContextError(
        'all-rungs-failed',
        `No LLM rung translated the transcript of ${context.metadata.ref.id} into ${language}.`,
        {
          hint: 'Check `attempts`. Enable a local model (OLLAMA_MODEL) or a free key (GROQ_API_KEY, GEMINI_API_KEY): see docs/providers.md.',
        },
      ),
      { attempts },
    );
  }
  if (report.failed.length > 0) {
    notes.push(
      `${report.untranslatedSegments} of ${items.length} segments kept their original text: ${report.failed.length} chunk(s) failed twice.`,
    );
  }

  const transcript: Transcript = {
    ref: source.ref,
    language,
    origin: source.origin,
    producer: rungs[0] ?? 'llm',
    ...(model ? { model } : {}),
    translated: true,
    segments: source.segments.map((s, id) => ({ ...s, text: texts.get(id) ?? s.text })),
    createdAt: new Date().toISOString(),
  };
  return { ...base, transcript, via: 'llm', producer: transcript.producer, rungs, model, report };
}

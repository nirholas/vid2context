/**
 * translateVideo(): load a video's source transcript (from the library when
 * saved, else through the pipeline, saved unchanged), translate it with
 * translateContext, and render the translation with a core formatter. Shared
 * by the MCP tool (mcp.ts) and the HTTP route (http.ts).
 *
 * The source transcript is never replaced: the library keeps it as fetched,
 * and the JSON result carries it next to the translation as `sourceTranscript`.
 */
import {
  type Attempt,
  type Ctx,
  type Formatter,
  formatTimestamp,
  formatters,
  getVideoContext,
  type Registry,
  type Storage,
  type Transcript,
  type TranscriptMode,
  Vid2ContextError,
  type VideoContext,
} from '@vid2context/core';
import { languageName } from './languages.ts';
import { type TranslationReport, type TranslationResult, translateContext } from './translate.ts';

/**
 * Where saved contexts come from: a Storage, a factory that opens one per call
 * (the HTTP server's `storage(ctx)`), or null to skip the library. Omitted: the
 * registry's enabled storage provider, if any.
 */
export type StorageSource = Storage | null | ((ctx: Ctx) => Promise<Storage | null>);

export interface TranslateVideoDeps {
  registry: Registry;
  ctx: Ctx;
  storage?: StorageSource;
}

export interface TranslateVideoOptions {
  /** Target language, BCP-47. */
  language: string;
  /** A formatter id from the core `formatters` map. Default `text`. */
  format?: string;
  timestamps?: boolean;
  /** How to get the source transcript. Default `auto`. */
  mode?: TranscriptMode;
  /** Ignore the library copy of the source and rebuild it. */
  refresh?: boolean;
  /** Allow LLM translation when the platform has no track. Default true. */
  llm?: boolean;
}

export const TRANSCRIPT_MODES = ['auto', 'captions', 'stt', 'video'] as const satisfies readonly TranscriptMode[];

/** What a caller needs to know about how the translation was made. */
export interface TranslationSummary {
  videoId: string;
  title: string;
  url?: string;
  /** Target language. */
  language: string;
  /** `source`: already in the language; `platform`: the platform's track or machine translation (YouTube `tlang`); `llm`: the rung chain. */
  via: TranslationResult['via'];
  producer: string;
  rungs: string[];
  model?: string;
  glossary: string[];
  report: TranslationReport;
  notes: string[];
  /** The source transcript, which stays stored unchanged. */
  source: { language: string; origin: Transcript['origin']; producer: string; segments: number };
  /** Every provider and rung tried for the translation. */
  attempts: Attempt[];
}

export interface TranslateVideoResult {
  formatter: Formatter;
  /** The translation rendered by the formatter (the `json` formatter gets `json` below instead). */
  body: string;
  /** The VideoContext with the translated transcript, its attempts appended to the source's. */
  context: VideoContext;
  sourceTranscript: Transcript;
  summary: TranslationSummary;
  /** Everything, for JSON output: the summary, the translated context and the untouched source transcript. */
  json: TranslationSummary & { context: VideoContext; sourceTranscript: Transcript };
}

export function formatterFor(id: string | undefined): Formatter {
  const f = formatters[id ?? 'text'];
  if (!f) {
    throw new Vid2ContextError('bad-request', `Unknown format "${String(id).slice(0, 40)}".`, {
      hint: `Available formats: ${Object.keys(formatters).join(', ')}.`,
    });
  }
  return f;
}

async function openStorage(deps: TranslateVideoDeps): Promise<Storage | null> {
  const s = deps.storage;
  if (s === undefined) return deps.registry.openStorage(deps.ctx);
  if (typeof s === 'function') return s(deps.ctx);
  return s;
}

/** One summary line for text output, so the reader knows the transcript is a translation and how it was made. */
export function summaryLine(s: TranslationSummary): string {
  const how =
    s.via === 'source'
      ? 'the source is already in this language'
      : s.via === 'platform'
        ? `the platform's own track or machine translation (${s.producer})`
        : `LLM translation (${s.rungs.join(', ') || s.producer}${s.model ? `, ${s.model}` : ''})`;
  const kept = s.report.untranslatedSegments > 0 ? ` ${s.report.untranslatedSegments} segment(s) kept their original text.` : '';
  return `Translation: ${s.source.language} to ${s.language} (${languageName(s.language)}) via ${how}. The ${s.source.language} source transcript is kept unchanged.${kept}`;
}

/** A header naming the video, so an agent always knows the source of a text transcript. */
export function header(c: VideoContext, s: TranslationSummary): string {
  const m = c.metadata;
  const lines = [
    `Title: ${m.title}`,
    m.channel ? `Channel: ${m.channel.name}` : undefined,
    m.ref.url ? `URL: ${m.ref.url}` : undefined,
    m.durationSec ? `Duration: ${formatTimestamp(m.durationSec)}` : undefined,
    `Transcript: ${c.transcript.origin}, ${c.transcript.language}${c.transcript.translated ? ', machine-translated' : ''} (${c.transcript.producer})`,
    summaryLine(s),
  ];
  return `${lines.filter(Boolean).join('\n')}\n\n`;
}

export async function translateVideo(
  input: string,
  opts: TranslateVideoOptions,
  deps: TranslateVideoDeps,
): Promise<TranslateVideoResult> {
  const formatter = formatterFor(opts.format);
  if (!input.trim()) {
    throw new Vid2ContextError('bad-request', 'Missing the video to translate.', {
      hint: 'Pass a video URL, a YouTube id or a local file path.',
    });
  }
  const storage = await openStorage(deps);
  // Load the source in its spoken language: asking for the target here would make it look already translated.
  const source = await getVideoContext(
    deps.registry,
    input,
    { mode: opts.mode ?? 'auto', storage, refresh: opts.refresh },
    deps.ctx,
  );
  const res = await translateContext(deps.registry, source, { language: opts.language, llm: opts.llm }, deps.ctx);
  const context: VideoContext = { ...source, transcript: res.transcript, attempts: [...source.attempts, ...res.attempts] };
  const m = source.metadata;
  const summary: TranslationSummary = {
    videoId: m.ref.id,
    title: m.title,
    ...(m.ref.url ? { url: m.ref.url } : {}),
    language: res.transcript.language,
    via: res.via,
    producer: res.producer,
    rungs: res.rungs,
    ...(res.model ? { model: res.model } : {}),
    glossary: res.glossary,
    report: res.report,
    notes: res.notes,
    source: {
      language: source.transcript.language,
      origin: source.transcript.origin,
      producer: source.transcript.producer,
      segments: source.transcript.segments.length,
    },
    attempts: res.attempts,
  };
  const body = formatter.render(context, { timestamps: opts.timestamps });
  return {
    formatter,
    body,
    context,
    sourceTranscript: source.transcript,
    summary,
    json: { ...summary, context, sourceTranscript: source.transcript },
  };
}

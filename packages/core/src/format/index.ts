/**
 * Output formats. Every surface (CLI, MCP, HTTP, web) lists `formatters` and
 * renders through `render`, so a formatter added here shows up everywhere.
 */
import { Vid2ContextError } from '../errors.ts';
import { formatTimestamp, segmentsToText } from '../segments.ts';
import type { VideoContext } from '../types.ts';
import { markdown } from './markdown.ts';
import { pack } from './pack.ts';
import { srt } from './srt.ts';
import { vtt } from './vtt.ts';

export interface FormatOptions {
  /** Prefix lines with timestamps where the format allows. */
  timestamps?: boolean;
  /** Token budget for formats that size themselves (pack), measured with estimateTokens. */
  maxTokens?: number;
  /** Include fetched comments. markdown: off unless true. pack: on unless false. */
  includeComments?: boolean;
  /** Include on-screen visual notes. markdown: off unless true. pack: on unless false. */
  includeVisual?: boolean;
  /** Make timestamps links into the video where the platform allows. Default true. */
  linkTimestamps?: boolean;
}

export interface Formatter {
  id: string;
  description: string;
  mimeType: string;
  extension: string;
  render(context: VideoContext, opts: FormatOptions): string;
  /** One document from several videos. Only formats that can combine videos implement it. */
  renderMany?(contexts: VideoContext[], opts: FormatOptions): string;
}

const text: Formatter = {
  id: 'text',
  description: 'Plain transcript text. With timestamps, one "[m:ss] line" per caption.',
  mimeType: 'text/plain; charset=utf-8',
  extension: 'txt',
  render(context, opts) {
    const segs = context.transcript.segments;
    if (!opts.timestamps) return `${segmentsToText(segs)}\n`;
    const long = (context.metadata.durationSec ?? segs.at(-1)?.endSec ?? 0) >= 3600;
    return `${segs.map((s) => `[${formatTimestamp(s.startSec, long)}] ${s.text.trim()}`).join('\n')}\n`;
  },
};

const json: Formatter = {
  id: 'json',
  description: 'The full VideoContext as JSON: metadata, chapters, timed segments, and how it was produced.',
  mimeType: 'application/json',
  extension: 'json',
  render(context) {
    return `${JSON.stringify(context, null, 2)}\n`;
  },
};

export const formatters: Record<string, Formatter> = { text, json, markdown, srt, vtt, pack };

function formatterFor(format: string): Formatter {
  const f = formatters[format];
  if (!f) {
    throw new Vid2ContextError('bad-request', `Unknown format "${format}".`, {
      hint: `Available formats: ${Object.keys(formatters).join(', ')}.`,
    });
  }
  return f;
}

export function render(context: VideoContext, format: string, opts: FormatOptions = {}): string {
  return formatterFor(format).render(context, opts);
}

/** Render several videos as one document. Throws for formats that only render one video. */
export function renderMany(contexts: VideoContext[], format: string, opts: FormatOptions = {}): string {
  const f = formatterFor(format);
  if (!f.renderMany) {
    const many = Object.values(formatters)
      .filter((x) => x.renderMany)
      .map((x) => x.id);
    throw new Vid2ContextError('bad-request', `Format "${format}" renders one video at a time.`, {
      hint: `Formats that accept several videos: ${many.join(', ')}. Or render each video separately.`,
    });
  }
  return f.renderMany(contexts, opts);
}

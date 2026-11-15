/**
 * Output formats. Every surface (CLI, MCP, HTTP, web) lists `formatters` and
 * renders through `render`, so a formatter added here shows up everywhere.
 */
import { Vid2ContextError } from '../errors.ts';
import { formatTimestamp, segmentsToText } from '../segments.ts';
import type { Transcript, VideoContext } from '../types.ts';
import { ass } from './ass.ts';
import { csv } from './csv.ts';
import { lrc } from './lrc.ts';
import { markdown } from './markdown.ts';
import { pack } from './pack.ts';
import { cleanText } from './paragraphs.ts';
import { sbv } from './sbv.ts';
import { alignSecondary } from './secondary.ts';
import { srt } from './srt.ts';
import { applyOffset } from './timing.ts';
import { ttml } from './ttml.ts';
import { vtt } from './vtt.ts';

export { LINE_CHARS_RANGE, LINES_RANGE, MAX_LINE, MAX_LINES } from './cues.ts';
export { alignSecondary } from './secondary.ts';
export { shiftSegments } from './timing.ts';

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
  /**
   * Shift every timestamp by this many seconds (negative moves earlier), to
   * line subtitles up with a cut or re-encoded copy of the video. Cues that
   * end at or before 0 are dropped; a cue that starts before 0 is clamped to
   * start at 0. Applies to the timed formats (srt, vtt, ass, ttml, sbv, lrc,
   * csv, and text with timestamps); see `Formatter.timed`.
   */
  offsetSec?: number;
  /** Longest caption line in characters for the cue formats. Default 42, clamped to 10..200. */
  maxLineChars?: number;
  /** Most lines per caption cue for the cue formats. Default 2, clamped to 1..4. */
  maxLines?: number;
  /**
   * A second transcript of the same video, usually a translation, for
   * bilingual (dual-language) output. This is how translated tracks are
   * combined: each secondary segment goes to the primary segment it overlaps
   * most in time (or the nearest one), and its text is shown under the
   * primary text. Cue formats (srt, vtt, ass, ttml, sbv) add it as extra
   * lines in each cue (ass in a smaller Secondary style); text adds a line
   * under each segment; csv adds a `secondary_text` column. See
   * `Formatter.bilingual`.
   */
  secondary?: Transcript;
}

export interface Formatter {
  id: string;
  description: string;
  mimeType: string;
  extension: string;
  render(context: VideoContext, opts: FormatOptions): string;
  /** One document from several videos. Only formats that can combine videos implement it. */
  renderMany?(contexts: VideoContext[], opts: FormatOptions): string;
  /**
   * When `offsetSec` applies: 'always' for subtitle and data formats,
   * 'timestamps' only when `timestamps` is on (text). Absent: never, because
   * the format's times are links into the video (markdown, pack) or raw data (json).
   */
  timed?: 'always' | 'timestamps';
  /** True when the format shows `secondary` (bilingual output). */
  bilingual?: boolean;
}

const text: Formatter = {
  id: 'text',
  description: 'Plain transcript text. With timestamps, one "[m:ss] line" per caption.',
  mimeType: 'text/plain; charset=utf-8',
  extension: 'txt',
  timed: 'timestamps',
  bilingual: true,
  render(context, opts) {
    const all = context.transcript.segments;
    const speakers = all.some((s) => s.speaker);
    if (!opts.secondary && !speakers) {
      if (!opts.timestamps) return `${segmentsToText(all)}\n`;
      const long = (context.metadata.durationSec ?? all.at(-1)?.endSec ?? 0) >= 3600;
      return `${all.map((s) => `[${formatTimestamp(s.startSec, long)}] ${s.text.trim()}`).join('\n')}\n`;
    }
    // Speakers or a second language: one entry per caption (or per speaker turn).
    const segs = all.filter((s) => s.text.trim());
    const second = opts.secondary ? alignSecondary(segs, opts.secondary.segments) : [];
    const long = (context.metadata.durationSec ?? segs.at(-1)?.endSec ?? 0) >= 3600;
    const out: string[] = [];
    let last: string | undefined;
    segs.forEach((s, i) => {
      const turn = s.speaker && s.speaker !== last ? `${cleanText(s.speaker)}: ` : '';
      const newTurn = s.speaker !== last;
      last = s.speaker;
      const body = s.text.trim().replace(/\s+/g, ' ');
      const sec = second[i];
      if (opts.timestamps) {
        const ts = `[${formatTimestamp(s.startSec, long)}] `;
        out.push(`${ts}${turn}${body}`);
        if (sec) out.push(`${' '.repeat(ts.length)}${sec}`);
      } else if (opts.secondary) {
        out.push(`${out.length ? '\n' : ''}${turn}${body}`);
        if (sec) out.push(sec);
      } else if (newTurn || !out.length) out.push(`${out.length ? '\n' : ''}${turn}${body}`);
      else out[out.length - 1] += ` ${body}`;
    });
    return `${out.join('\n')}\n`;
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

/**
 * Apply `offsetSec` once, before any timed formatter renders, so every caller
 * (render, the bundle, a surface calling `formatters[id].render`) gets it.
 */
function withOffset(f: Formatter): Formatter {
  if (!f.timed) return f;
  const base = f.render.bind(f);
  return {
    ...f,
    render(context, opts = {}) {
      if (f.timed === 'timestamps' && !opts.timestamps) return base(context, opts);
      const [c, o] = applyOffset(context, opts);
      return base(c, o);
    },
  };
}

export const formatters: Record<string, Formatter> = Object.fromEntries(
  [text, json, markdown, srt, vtt, pack, ass, ttml, sbv, lrc, csv].map((f) => [f.id, withOffset(f)]),
);

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

/**
 * The videos a brief or extraction reads, labelled V1, V2, ... so models can
 * cite them with a short, unambiguous id, and rendered as fenced untrusted
 * blocks of timestamped lines.
 */
import { fenceUntrusted, formatTimestamp, timestampUrl, Vid2ContextError, type VideoContext } from '@vid2context/core';
import { compactLines, type Line } from './text.ts';
import type { SourceSummary } from './types.ts';

export interface Source {
  /** V1, V2, ... in input order. */
  label: string;
  context: VideoContext;
  summary: SourceSummary;
  lines: Line[];
}

export interface SourceSet {
  sources: Source[];
  /** Resolve a label (V1), a ref id (youtube:abc) or a native id (abc). */
  find(id: unknown): Source | undefined;
}

export function summarizeSource(context: VideoContext): SourceSummary {
  const m = context.metadata;
  return {
    videoId: m.ref.id,
    ref: m.ref,
    title: m.title,
    channel: m.channel?.name,
    durationSec: m.durationSec,
    publishedAt: m.publishedAt,
    url: m.ref.url,
    origin: context.transcript.origin,
    language: context.transcript.language,
  };
}

export function sourceSet(contexts: VideoContext[]): SourceSet {
  if (contexts.length === 0) {
    throw new Vid2ContextError('bad-request', 'No videos to read.', {
      hint: 'Pass at least one video (inputs or urls), or a collection that has videos in it.',
    });
  }
  const seen = new Set<string>();
  const sources: Source[] = [];
  for (const context of contexts) {
    const id = context.metadata.ref.id;
    if (seen.has(id)) continue;
    seen.add(id);
    sources.push({
      label: `V${sources.length + 1}`,
      context,
      summary: summarizeSource(context),
      lines: compactLines(context.transcript.segments),
    });
  }
  const byKey = new Map<string, Source>();
  for (const s of sources) {
    byKey.set(s.label.toLowerCase(), s);
    byKey.set(s.summary.videoId.toLowerCase(), s);
    byKey.set(s.summary.ref.nativeId.toLowerCase(), s);
  }
  return {
    sources,
    find: (id) => (typeof id === 'string' ? byKey.get(id.trim().toLowerCase()) : undefined),
  };
}

export type TimeStyle = 'seconds' | 'clock';

/** `[83]` for models that must return seconds, `[1:23]` for agents that cite m:ss. */
export function renderLine(l: Line, style: TimeStyle): string {
  return style === 'seconds' ? `[${Math.floor(l.startSec)}] ${l.text}` : `[${formatTimestamp(l.startSec)}] ${l.text}`;
}

/** Header facts about a source, written by us (ids, link form, duration), plus its uploader-written title. */
function header(s: Source, part?: { index: number; total: number }): string {
  const m = s.context.metadata;
  const link = timestampUrl(m.ref, 0);
  const rows = [
    `Source ${s.label} (videoId ${s.summary.videoId})${part && part.total > 1 ? `, part ${part.index + 1} of ${part.total}` : ''}`,
    `Title: ${m.title}`,
    m.channel?.name ? `Channel: ${m.channel.name}` : '',
    m.durationSec ? `Duration: ${formatTimestamp(m.durationSec)}` : '',
    m.publishedAt ? `Published: ${m.publishedAt.slice(0, 10)}` : '',
    `Transcript: ${s.context.transcript.origin}, ${s.context.transcript.language}`,
    link ? `Timestamp link: ${link.replace(/0(s?)$/, '<seconds>$1')}` : '',
  ];
  return rows.filter(Boolean).join('\n');
}

/**
 * One source (or one chunk of it) as a fenced untrusted block. The title and
 * transcript are third-party text, so both sit inside the fence; the label
 * and id also appear in the fence's source attribute.
 */
export function renderSource(
  s: Source,
  opts: { style: TimeStyle; lines?: Line[]; part?: { index: number; total: number } },
): { block: string; system: string } {
  const lines = opts.lines ?? s.lines;
  const body = `${header(s, opts.part)}\n\n${lines.map((l) => renderLine(l, opts.style)).join('\n')}`;
  const fenced = fenceUntrusted(body, 'transcript', `${s.label} ${s.summary.videoId}`);
  return { block: fenced.block, system: fenced.system };
}

/**
 * The data the transcript viewer renders, shared by the MCP tool (which
 * builds it) and the viewer bundle (which reads it). Runtime-neutral: this
 * file is bundled into the viewer HTML, so it imports only pure helpers.
 *
 * Segments travel as [startSec, endSec, text] tuples. Some hosts (ChatGPT)
 * show `structuredContent` to the model as well as to the viewer, so the
 * shape is kept small: trimmed metadata, no per-segment keys.
 */
import { type Chapter, formatTimestamp, timestampUrl, type VideoContext } from '@vid2context/core';

/** The MCP Apps resource the viewer is served from. */
export const VIEWER_URI = 'ui://vid2context/transcript-viewer';

export type SegmentTuple = [startSec: number, endSec: number, text: string];

export interface ViewerMetadata {
  /** Ref id, e.g. "youtube:cCPsdFdlshc". */
  id: string;
  title: string;
  url?: string;
  channel?: string;
  durationSec?: number;
  publishedAt?: string;
  /** How the transcript was produced (creator-captions, auto-captions, stt, ...). */
  origin: VideoContext['transcript']['origin'];
  /** BCP-47 language of the transcript text. */
  language: string;
  translated?: boolean;
}

export interface ViewerData {
  metadata: ViewerMetadata;
  chapters: Chapter[];
  segments: SegmentTuple[];
  /**
   * A link template that opens the video at a moment: replace "{t}" with
   * whole seconds. Null when the source has no deep-link form (local files).
   */
  timestampBase: string | null;
}

/** The marker in `timestampBase` that stands for whole seconds. */
export const TIME_MARKER = '{t}';

// A value no real URL contains, used to turn core's timestampUrl into a template.
const PROBE_SEC = 987654321;

const round2 = (n: number): number => Math.round(n * 100) / 100;

/** Build the viewer data for one video context. Raw segment text is kept as is. */
export function toViewerData(context: VideoContext): ViewerData {
  const m = context.metadata;
  const t = context.transcript;
  const probe = timestampUrl(m.ref, PROBE_SEC);
  const metadata: ViewerMetadata = {
    id: m.ref.id,
    title: m.title,
    origin: t.origin,
    language: t.language,
  };
  if (m.ref.url) metadata.url = m.ref.url;
  if (m.channel?.name) metadata.channel = m.channel.name;
  if (m.durationSec !== undefined) metadata.durationSec = m.durationSec;
  if (m.publishedAt) metadata.publishedAt = m.publishedAt;
  if (t.translated) metadata.translated = true;
  return {
    metadata,
    chapters: m.chapters.map((c) => (c.endSec === undefined ? { title: c.title, startSec: c.startSec } : { ...c })),
    segments: t.segments.map((s): SegmentTuple => [round2(s.startSec), round2(s.endSec), s.text]),
    timestampBase: probe?.includes(String(PROBE_SEC)) ? probe.replace(String(PROBE_SEC), TIME_MARKER) : null,
  };
}

/** The link that opens the video at `sec`, or undefined when there is none. */
export function timestampLink(base: string | null, sec: number): string | undefined {
  if (!base) return undefined;
  return base.replace(TIME_MARKER, String(Math.max(0, Math.floor(sec))));
}

/** Escape the characters that would end Markdown link text early. */
function escapeLinkText(s: string): string {
  return s.replace(/([\\[\]])/g, '\\$1');
}

/** A Markdown citation: `[Title @ m:ss](url)`, or `[Title @ m:ss]` without a link. */
export function citation(title: string, sec: number, base: string | null): string {
  const label = `[${escapeLinkText(title)} @ ${formatTimestamp(sec)}]`;
  const url = timestampLink(base, sec);
  return url ? `${label}(${url})` : label;
}

const isNum = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);

/**
 * Check data that arrived from the host before rendering it. Hosts relay
 * `structuredContent` as is, so the viewer treats it as untrusted input.
 */
export function isViewerData(x: unknown): x is ViewerData {
  if (!x || typeof x !== 'object') return false;
  const d = x as Record<string, unknown>;
  const m = d.metadata as Record<string, unknown> | undefined;
  if (!m || typeof m !== 'object' || typeof m.title !== 'string' || typeof m.id !== 'string') return false;
  if (d.timestampBase !== null && typeof d.timestampBase !== 'string') return false;
  if (!Array.isArray(d.chapters) || !Array.isArray(d.segments)) return false;
  for (const c of d.chapters) {
    if (!c || typeof c !== 'object' || typeof c.title !== 'string' || !isNum(c.startSec)) return false;
  }
  for (const s of d.segments) {
    if (!Array.isArray(s) || s.length < 3 || !isNum(s[0]) || !isNum(s[1]) || typeof s[2] !== 'string') return false;
  }
  return true;
}

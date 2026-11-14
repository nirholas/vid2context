/**
 * The data the transcript viewer renders, shared by the MCP tool (which
 * builds it, see context.ts) and the viewer bundle (which reads it).
 *
 * This file is bundled into the viewer HTML, so it has no runtime imports:
 * pulling in @vid2context/core would make the committed bundle change
 * whenever any core module changes. `formatTimestamp` is therefore a copy of
 * core's, and test/data.test.ts checks that both give the same output.
 *
 * Segments travel as [startSec, endSec, text] tuples. Some hosts (ChatGPT)
 * show `structuredContent` to the model as well as to the viewer, so the
 * shape is kept small: trimmed metadata, no per-segment keys.
 */
import type { Chapter, VideoContext } from '@vid2context/core';

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

/** 75 -> "1:15", 3723 -> "1:02:03". The same output as core's formatTimestamp. */
export function formatTimestamp(sec: number): string {
  const total = Math.max(0, Math.floor(sec));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const ss = String(total % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
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

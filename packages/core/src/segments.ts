import type { Segment, VideoRef } from './types.ts';

/** 75 -> "1:15", 3723 -> "1:02:03". `forceHours` pads to h:mm:ss. */
export function formatTimestamp(sec: number, forceHours = false): string {
  const total = Math.max(0, Math.floor(sec));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const ss = String(s).padStart(2, '0');
  if (h > 0 || forceHours) return `${h}:${String(m).padStart(2, '0')}:${ss}`;
  return `${m}:${ss}`;
}

/** A link that opens the media at `sec`, or undefined when the platform has no deep-link form. */
export function timestampUrl(ref: VideoRef, sec: number): string | undefined {
  const t = Math.max(0, Math.floor(sec));
  if (ref.platform === 'youtube' && ref.kind === 'video') return `https://www.youtube.com/watch?v=${ref.nativeId}&t=${t}s`;
  if (ref.platform === 'vimeo' && ref.url) return `${ref.url}#t=${t}s`;
  if (ref.url && /^https?:/i.test(ref.url)) return `${ref.url}#t=${t}`;
  return undefined;
}

/** Collapse whitespace and join segment text into one string. */
export function segmentsToText(segments: Segment[]): string {
  return segments
    .map((s) => s.text.trim())
    .filter(Boolean)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Segments overlapping [fromSec, toSec). */
export function sliceSegments(segments: Segment[], fromSec: number, toSec: number): Segment[] {
  return segments.filter((s) => s.endSec > fromSec && s.startSec < toSec);
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

/** Decode the HTML/XML entities that appear in caption payloads. */
export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? Number.parseInt(e.slice(2), 16) : Number.parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

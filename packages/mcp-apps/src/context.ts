/**
 * Builds the viewer data from a VideoContext (server side only: it uses
 * core's timestampUrl, so the deep-link format stays defined in one place).
 */
import { timestampUrl, type VideoContext } from '@vid2context/core';
import { type SegmentTuple, TIME_MARKER, type ViewerData, type ViewerMetadata } from './data.ts';

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

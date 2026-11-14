/**
 * The JSON shape the MCP tool and the HTTP route return for a lookup: every
 * segment with its time range, a timestamp link and, when a transcript is
 * at hand, how much of the transcript it covers. Always carries the
 * SponsorBlock attribution the data license requires.
 */
import { type Ctx, formatTimestamp, type Transcript, timestampUrl, type VideoRef } from '@vid2context/core';
import { applySkips } from './apply.ts';
import {
  type SkipLookup,
  type SkipSegment,
  SPONSORBLOCK_ATTRIBUTION,
  sponsorBlockEnabled,
  unionSeconds,
} from './sponsorblock.ts';

export interface SegmentReport extends SkipSegment {
  /** "m:ss-m:ss", for citing. */
  time: string;
  durationSec: number;
  /** Opens the video at the segment start, when the platform has deep links. */
  url?: string;
  /** Present when a transcript was available. */
  transcript?: {
    /** Transcript lines inside this segment (at least half their duration). */
    lines: number;
    /** Share of the transcript's words in those lines, 0 to 1. */
    share: number;
    /** The first words of those lines. */
    preview: string;
  };
}

export interface SkipReport {
  videoId: string;
  source: 'sponsorblock';
  attribution: string;
  segments: SegmentReport[];
  /** Seconds of video covered by the segments (their union). */
  coveredSec: number;
  /** Share of the video's duration covered, when the duration is known. */
  coveredShare?: number;
  /** Share of the transcript's words inside the segments, when a transcript was available. */
  transcriptShare?: number;
  highlight?: SegmentReport;
  fullVideo?: SkipSegment;
  chapters?: SkipSegment[];
  /** Why the result is empty or partial, in plain words. */
  note?: string;
}

const round = (n: number, places = 3): number => Math.round(n * 10 ** places) / 10 ** places;
const words = (s: string): number => (s.trim() ? s.trim().split(/\s+/).length : 0);

function preview(text: string, max = 160): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const space = cut.lastIndexOf(' ');
  return `${space > max / 2 ? cut.slice(0, space) : cut}...`;
}

function describe(ref: VideoRef, s: SkipSegment): SegmentReport {
  const out: SegmentReport = {
    ...s,
    time: s.endSec > s.startSec ? `${formatTimestamp(s.startSec)}-${formatTimestamp(s.endSec)}` : formatTimestamp(s.startSec),
    durationSec: round(s.endSec - s.startSec),
  };
  const url = timestampUrl(ref, s.startSec);
  if (url) out.url = url;
  return out;
}

/** Why a lookup returned nothing, for the `note` field. */
export function emptyNote(lookup: SkipLookup, ref: VideoRef, ctx: Ctx): string | undefined {
  if (lookup.looked) {
    if (lookup.segments.length > 0) return undefined;
    return lookup.fullVideo
      ? `SponsorBlock labels the whole video as ${lookup.fullVideo.category}; there are no spans to skip.`
      : 'SponsorBlock has no segments in these categories for this video.';
  }
  if (ref.platform !== 'youtube') return `SponsorBlock covers YouTube videos only; ${ref.platform} has no community segments.`;
  if (!sponsorBlockEnabled(ctx)) return 'SponsorBlock lookups are off (VID2CONTEXT_SPONSORBLOCK=0).';
  return 'No categories were asked for.';
}

export function buildReport(
  ref: VideoRef,
  lookup: SkipLookup,
  opts: { ctx: Ctx; transcript?: Transcript; durationSec?: number; note?: string },
): SkipReport {
  const segments = lookup.segments.map((s) => describe(ref, s));
  const coveredSec = round(unionSeconds(lookup.segments));
  const report: SkipReport = {
    videoId: lookup.videoId,
    source: 'sponsorblock',
    attribution: SPONSORBLOCK_ATTRIBUTION,
    segments,
    coveredSec,
  };
  if (opts.durationSec && opts.durationSec > 0) report.coveredShare = round(coveredSec / opts.durationSec);

  if (opts.transcript && lookup.segments.length > 0) {
    const marked = applySkips(opts.transcript, lookup.segments, { mode: 'mark' });
    const total = words(opts.transcript.segments.map((s) => s.text).join(' '));
    let inside = 0;
    marked.removed.forEach((r, i) => {
      const w = words(r.text);
      inside += w;
      const target = segments[i];
      if (target) target.transcript = { lines: r.lines, share: total ? round(w / total) : 0, preview: preview(r.text) };
    });
    report.transcriptShare = total ? round(inside / total) : 0;
  }

  if (lookup.highlight) report.highlight = describe(ref, lookup.highlight);
  if (lookup.fullVideo) report.fullVideo = lookup.fullVideo;
  if (lookup.chapters.length > 0) report.chapters = lookup.chapters;
  const note = opts.note ?? emptyNote(lookup, ref, opts.ctx);
  if (note) report.note = note;
  return report;
}

/**
 * Outlines: what sections a video has and what each costs in tokens, so an
 * agent can decide what to fetch before fetching it.
 */
import type { Chapter, VideoContext, VideoMetadata } from '../types.ts';
import { mediaEnd, rangeTokens, sectionSpans } from './spans.ts';

export interface OutlineSection {
  /** Position in start order; pass it to `getSection` as `chapter`. */
  index: number;
  title: string;
  startSec: number;
  endSec: number;
  tokens: number;
  /** `chapters` for the video's own chapters, `time` for synthetic sections of about five minutes. */
  source: 'chapters' | 'time';
}

export interface TranscriptOutline {
  title: string;
  durationSec: number;
  /** Sum of the section token counts. */
  totalTokens: number;
  sections: OutlineSection[];
}

/**
 * Sections with token estimates. Videos with chapters list them; videos
 * without get synthetic sections of about five minutes, cut on sentence ends
 * or pauses and titled by time range ("12:00 to 17:03"). Each segment counts
 * toward the section its start falls in, so section tokens add up to the total.
 */
export function transcriptOutline(context: VideoContext): TranscriptOutline {
  const segs = context.transcript.segments;
  const sections = sectionSpans(context).map((s) => ({
    index: s.index,
    title: s.title,
    startSec: s.startSec,
    endSec: s.endSec,
    tokens: rangeTokens(segs, s.first, s.last),
    source: s.source,
  }));
  return {
    title: context.metadata.title,
    durationSec: mediaEnd(context),
    totalTokens: sections.reduce((sum, s) => sum + s.tokens, 0),
    sections,
  };
}

/** The `GET /outline` response body from docs/contracts/http-api.md. */
export interface ApiOutline {
  metadata: VideoMetadata;
  chapters: (Chapter & { tokens: number })[];
  totalTokens: number;
}

/** `transcriptOutline` in the shape `GET /outline` and `get_outline` return. Synthetic sections appear as chapters. */
export function outlineForApi(context: VideoContext): ApiOutline {
  const o = transcriptOutline(context);
  return {
    metadata: context.metadata,
    chapters: o.sections.map((s) => ({ title: s.title, startSec: s.startSec, endSec: s.endSec, tokens: s.tokens })),
    totalTokens: o.totalTokens,
  };
}

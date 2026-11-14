import { formatTimestamp } from '@vid2context/core';
import type { LiveEvent } from './types.ts';

type SegmentEvent = Extract<LiveEvent, { type: 'segment' }>;

/** "[12:34:56 | 17:05:31Z] text": stream time, plus wall-clock UTC when the stream carries it. */
export function formatLiveLine(e: SegmentEvent): string {
  const clock = e.at ? ` | ${e.at.slice(11, 19)}Z` : '';
  return `[${formatTimestamp(e.segment.startSec)}${clock}] ${e.segment.text}`;
}

/** The last `n` lines of a rolling transcript, oldest first. */
export function latestLines(events: SegmentEvent[], n: number): string {
  return events.slice(-n).map(formatLiveLine).join('\n');
}

/**
 * Time chunks for citation: pieces of about 30 to 90 seconds, so every `[n]`
 * points at a short stretch of the video. Built on core's chunkTranscript in
 * time mode (60 second target: windows of 36 to 84 seconds, cut on sentence
 * ends or pauses of a second or more, never splitting a segment).
 */
import { chunkTranscript, type Segment, type VideoContext } from '@vid2context/core';

export interface TimeChunk {
  videoId: string;
  /** Position within its video, from 0. Neighbours have consecutive indexes. */
  index: number;
  startSec: number;
  endSec: number;
  text: string;
  tokens: number;
  segments: Segment[];
}

export const TARGET_CHUNK_SEC = 60;
/** chunkTranscript's time mode never makes a window longer than 1.4 times the target. */
export const MAX_CHUNK_SEC = TARGET_CHUNK_SEC * 1.4;
/** Large enough that only time decides the cuts (90 seconds of fast speech is about 400 tokens). */
const CHUNK_MAX_TOKENS = 2000;

export function chunkByTime(context: VideoContext): TimeChunk[] {
  const videoId = context.metadata.ref.id;
  const segs = context.transcript.segments;
  return chunkTranscript(context, { by: 'time', targetSec: TARGET_CHUNK_SEC, maxTokens: CHUNK_MAX_TOKENS })
    .filter((c) => c.text.length > 0)
    .map((c, index) => ({
      videoId,
      index,
      startSec: c.startSec,
      endSec: c.endSec,
      text: c.text,
      tokens: c.tokens,
      segments: segs.slice(c.segmentRange[0], c.segmentRange[1] + 1),
    }));
}

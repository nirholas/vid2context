/**
 * Time shifting for the timed formats (`offsetSec`). Applied once, before a
 * formatter renders, to the primary transcript and the secondary one alike.
 */
import { Vid2ContextError } from '../errors.ts';
import type { Segment, VideoContext } from '../types.ts';
import type { FormatOptions } from './index.ts';

/**
 * Shift every segment by `offsetSec` seconds (negative moves earlier).
 * Segments that end at or before 0 are dropped; a segment that starts before
 * 0 and ends after it is clamped to start at 0. Returns new segment objects;
 * the input is not changed. An offset of 0 returns copies of the segments.
 */
export function shiftSegments(segments: Segment[], offsetSec: number): Segment[] {
  if (typeof offsetSec !== 'number' || !Number.isFinite(offsetSec)) {
    throw new Vid2ContextError('bad-request', 'offsetSec must be a number of seconds.', {
      hint: 'Pass offsetSec as seconds, for example 2.5 to show subtitles later or -1 to show them earlier.',
    });
  }
  const out: Segment[] = [];
  for (const s of segments) {
    const end = s.endSec + offsetSec;
    if (end <= 0) continue;
    out.push({ ...s, startSec: Math.max(0, s.startSec + offsetSec), endSec: end });
  }
  return out;
}

/** The context and options with `offsetSec` applied to both transcripts; unchanged when there is no offset. */
export function applyOffset(context: VideoContext, opts: FormatOptions): [VideoContext, FormatOptions] {
  const offset = opts.offsetSec;
  if (offset === undefined || offset === 0) return [context, opts];
  const shifted: VideoContext = {
    ...context,
    transcript: { ...context.transcript, segments: shiftSegments(context.transcript.segments, offset) },
  };
  const secondary = opts.secondary ? { ...opts.secondary, segments: shiftSegments(opts.secondary.segments, offset) } : undefined;
  return [shifted, secondary ? { ...opts, secondary } : opts];
}

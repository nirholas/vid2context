/**
 * Expected size of one download, from the quality list `mediaOptions` builds.
 * Used for the disk-space preflight. Runtime-neutral.
 */
import type { MediaOptions } from './formats.ts';
import type { DownloadRequest, VideoContainer } from './options.ts';

/** Estimated bytes of the finished file, or undefined when the site gives no sizes or bitrates. */
export function estimateBytes(
  req: Pick<DownloadRequest, 'kind' | 'format' | 'quality'>,
  options: Pick<MediaOptions, 'video' | 'audio' | 'durationSec'>,
  section?: { fromSec: number; toSec?: number },
): number | undefined {
  let whole: number | undefined;
  if (req.kind === 'video') {
    // `video` is ordered best first; the request gets the first at or below its limit.
    const limit = req.quality === 'best' ? Number.POSITIVE_INFINITY : Number(req.quality);
    const choice =
      options.video.find((v) => v.quality === req.quality) ??
      options.video.find((v) => v.height <= limit) ??
      options.video.at(-1);
    whole = choice?.sizes[req.format as VideoContainer];
  } else {
    whole =
      options.audio.find((a) => a.format === req.format && a.quality === req.quality)?.sizeBytes ??
      options.audio.find((a) => a.format === req.format)?.sizeBytes;
  }
  if (whole === undefined) return undefined;
  const duration = options.durationSec;
  if (!section || !duration) return whole;
  const kept = Math.max(0, Math.min(section.toSec ?? duration, duration) - section.fromSec);
  return Math.round(whole * (kept / duration));
}

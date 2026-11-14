/**
 * The best thumbnail. The ANDROID and IOS player responses list thumbnails
 * up to sddefault (640x480) and never maxresdefault (1280x720), and whether
 * maxres exists cannot be told from the response: on 2026-11-14, 5 of 14
 * sampled videos that list sddefault had no maxresdefault, and a 360p upload
 * had one. So one HEAD request to the image CDN (not innertube, run in
 * parallel with the `next` request) decides; any failure falls back to the
 * largest listed thumbnail.
 */
import { type Ctx, fetchWithTimeout } from '@vid2context/core';

export interface Thumbnail {
  url: string;
  width?: number;
  height?: number;
}

export function largestThumbnail(thumbs: Thumbnail[] | undefined): string | undefined {
  let best: Thumbnail | undefined;
  for (const t of thumbs ?? []) {
    if (!best || (t.width ?? 0) * (t.height ?? 0) > (best.width ?? 0) * (best.height ?? 0)) best = t;
  }
  return best?.url;
}

export const maxresUrl = (videoId: string): string => `https://i.ytimg.com/vi/${videoId}/maxresdefault.jpg`;

/** The maxresdefault URL when the CDN has it, else undefined. Never throws. */
export async function findMaxres(videoId: string, ctx: Ctx): Promise<string | undefined> {
  const url = maxresUrl(videoId);
  try {
    const res = await fetchWithTimeout(ctx, url, { method: 'HEAD' }, 10_000);
    await res.body?.cancel();
    return res.ok ? url : undefined;
  } catch (err) {
    ctx.log.debug('youtube: maxres thumbnail check failed', { videoId, error: err instanceof Error ? err.message : String(err) });
    return undefined;
  }
}

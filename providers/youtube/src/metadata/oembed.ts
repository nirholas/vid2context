/**
 * YouTube's oEmbed endpoint: title, channel name and URL, and a thumbnail.
 * Keyless, and a different service from innertube: on 2026-11-14 it answered
 * from a GCP VM whose player requests got the bot check and whose caption
 * downloads got HTTP 429. So it is the last source of a title when the player
 * is blocked, and it deliberately bypasses the YouTube circuit breaker (a
 * block on innertube says nothing about oEmbed).
 *
 * 401 means embedding is disabled for the video, 404 that it does not exist
 * or is private; both return undefined, like any other failure. It never throws.
 */
import { type Ctx, fetchWithTimeout } from '@vid2context/core';

export interface OEmbedInfo {
  title: string;
  authorName?: string;
  /** The channel's handle URL, for example https://www.youtube.com/@jawed. */
  authorUrl?: string;
  thumbnailUrl?: string;
}

export const oembedUrl = (videoId: string): string =>
  `https://www.youtube.com/oembed?url=${encodeURIComponent(`https://www.youtube.com/watch?v=${videoId}`)}&format=json`;

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);

export function parseOEmbed(body: unknown): OEmbedInfo | undefined {
  if (!body || typeof body !== 'object') return undefined;
  const o = body as Record<string, unknown>;
  const title = str(o.title);
  if (!title) return undefined;
  return {
    title,
    authorName: str(o.author_name),
    authorUrl: str(o.author_url),
    thumbnailUrl: str(o.thumbnail_url),
  };
}

export async function fetchOEmbed(videoId: string, ctx: Ctx): Promise<OEmbedInfo | undefined> {
  try {
    const res = await fetchWithTimeout(ctx, oembedUrl(videoId), { headers: { accept: 'application/json' } }, 10_000);
    if (!res.ok) {
      await res.body?.cancel();
      ctx.log.debug('youtube: oEmbed answered without data', { videoId, status: res.status });
      return undefined;
    }
    return parseOEmbed(await res.json());
  } catch (err) {
    ctx.log.debug('youtube: oEmbed request failed', { videoId, error: err instanceof Error ? err.message : String(err) });
    return undefined;
  }
}

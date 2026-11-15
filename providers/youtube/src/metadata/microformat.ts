/**
 * The WEB player's microformat (playerMicroformatRenderer). The ANDROID and
 * IOS player responses that captions use do not carry it, and `next` does
 * not either, but it is the only keyless place for the category, the exact
 * publish and upload timestamps, the unlisted flag, YouTube's own Shorts
 * flag (isShortsEligible) and the live broadcast start and end times.
 *
 * The WEB player answers UNPLAYABLE ("The page needs to be reloaded") without
 * a PO token, but still returns videoDetails and the microformat (checked on
 * 2026-11-15 for every video in test/fixtures/metadata/). Its thumbnail list
 * holds maxresdefault exactly when that image exists, which replaces the CDN
 * HEAD check. It is still a second player request, so it runs only with
 * YOUTUBE_METADATA_MICROFORMAT=1; by default metadata keeps to one player
 * request shared with captions.
 */
import type { Ctx } from '@vid2context/core';
import { innertubeRequest } from '../resilience/transport.ts';
import { webClient } from './next.ts';
import { largestThumbnail, type Thumbnail } from './thumbnail.ts';

export interface MicroformatInfo {
  /** "Comedy", "Music", "Education". */
  category?: string;
  /** ISO 8601 with time and offset, "2025-06-16T04:00:04-07:00". */
  publishDate?: string;
  /** ISO 8601 with time and offset. Differs from publishDate for videos uploaded private and published later. */
  uploadDate?: string;
  isShortsEligible?: boolean;
  isUnlisted?: boolean;
  isFamilySafe?: boolean;
  likeCount?: number;
  viewCount?: number;
  /** "@name", from ownerProfileUrl. */
  channelHandle?: string;
  /** The largest microformat thumbnail: maxresdefault when it exists. */
  thumbnailUrl?: string;
  /** Live and premiere broadcasts: ISO 8601 start and end, and whether it is live right now. */
  liveStartedAt?: string;
  liveEndedAt?: string;
  isLiveNow?: boolean;
}

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
const bool = (v: unknown): boolean | undefined => (typeof v === 'boolean' ? v : undefined);
const num = (v: unknown): number | undefined => {
  const n = typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : undefined;
  return n !== undefined && Number.isFinite(n) ? n : undefined;
};

/** Read the microformat from a WEB player response; undefined when it has none. Pure. */
export function parseMicroformat(player: unknown): MicroformatInfo | undefined {
  const m = isObj(player) && isObj(player.microformat) ? player.microformat.playerMicroformatRenderer : undefined;
  if (!isObj(m)) return undefined;
  const thumbs = isObj(m.thumbnail) && Array.isArray(m.thumbnail.thumbnails) ? (m.thumbnail.thumbnails as Thumbnail[]) : [];
  const live = isObj(m.liveBroadcastDetails) ? m.liveBroadcastDetails : undefined;
  const handle = str(m.ownerProfileUrl) && /\/(@[^/?#]+)/.exec(m.ownerProfileUrl as string)?.[1];
  return {
    category: str(m.category),
    publishDate: str(m.publishDate),
    uploadDate: str(m.uploadDate),
    isShortsEligible: bool(m.isShortsEligible),
    isUnlisted: bool(m.isUnlisted),
    isFamilySafe: bool(m.isFamilySafe),
    likeCount: num(m.likeCount),
    viewCount: num(m.viewCount),
    channelHandle: handle || undefined,
    thumbnailUrl: largestThumbnail(thumbs),
    liveStartedAt: str(live?.startTimestamp),
    liveEndedAt: str(live?.endTimestamp),
    isLiveNow: bool(live?.isLiveNow),
  };
}

/** POST /youtubei/v1/player as WEB. Returns the raw JSON; parseMicroformat reads it. */
export function fetchWebPlayer(videoId: string, ctx: Ctx): Promise<unknown> {
  return innertubeRequest('player', { videoId, contentCheckOk: true, racyCheckOk: true }, webClient(ctx), ctx, {
    stage: 'metadata',
  });
}

/** The microformat, or undefined (logged) when the request fails or the response has none. Never throws. */
export async function loadMicroformat(videoId: string, ctx: Ctx): Promise<MicroformatInfo | undefined> {
  try {
    const info = parseMicroformat(await fetchWebPlayer(videoId, ctx));
    if (!info) ctx.log.debug('youtube: WEB player response had no microformat', { videoId });
    return info;
  } catch (err) {
    ctx.log.warn('youtube: WEB player (microformat) request failed; category and timestamps left out', {
      videoId,
      error: err instanceof Error ? err.message.slice(0, 200) : String(err),
    });
    return undefined;
  }
}

/**
 * YouTube metadata: one player response (shared with captions through the
 * player cache), then in parallel at most one `next` request for the
 * watch-page fields and one HEAD request to the image CDN for the maxres
 * thumbnail. With YOUTUBE_METADATA_MICROFORMAT=1, a WEB player request for
 * the microformat (category, exact timestamps, Shorts and unlisted flags,
 * live start and end) takes the HEAD request's place. Metadata succeeds whenever the player returns videoDetails,
 * including age-restricted, members-only, live and upcoming videos; those
 * states land in `extra` and the transcript stage reports them as errors.
 *
 * Every field and its source is listed in docs/guides/youtube.md,
 * "Metadata and chapters".
 */
import { type Chapter, type Ctx, Vid2ContextError, type VideoMetadata, type VideoRef } from '@vid2context/core';
import { originalLanguage } from '../captions/tracks.ts';
import { playabilityError } from '../resilience/errors.ts';
import { getPlayer, type PlayerResponse } from '../resilience/player.ts';
import { type ChapterSource, parseDescriptionChapters, withEnds } from './chapters.ts';
import { extractLinks } from './links.ts';
import { loadMicroformat, type MicroformatInfo, parseMicroformat } from './microformat.ts';
import { fetchNext } from './next.ts';
import { fetchOEmbed, type OEmbedInfo } from './oembed.ts';
import { findMaxres, largestThumbnail, type Thumbnail } from './thumbnail.ts';
import { parseWatch, type WatchInfo } from './watch.ts';

export { type ChapterSource, cleanTitle, parseChapterLine, parseClock, parseDescriptionChapters, withEnds } from './chapters.ts';
export { extractLinks } from './links.ts';
export { fetchWebPlayer, loadMicroformat, type MicroformatInfo, parseMicroformat } from './microformat.ts';
export { DEFAULT_WEB_VERSION, fetchNext, webClient } from './next.ts';
export { fetchOEmbed, type OEmbedInfo, oembedUrl, parseOEmbed } from './oembed.ts';
export { findMaxres, largestThumbnail, maxresUrl } from './thumbnail.ts';
export { parseDateText, parseWatch, type WatchInfo } from './watch.ts';

/** Player fields metadata reads beyond the shared PlayerResponse type. */
type Player = PlayerResponse & {
  streamingData?: {
    formats?: { width?: number; height?: number }[];
    adaptiveFormats?: { width?: number; height?: number }[];
  };
};

/** YouTube Shorts are at most 3 minutes long (since October 2024). */
const SHORT_MAX_SEC = 180;

/**
 * A Short, by the first signal available: the input used the /shorts/ URL
 * form; else the WEB player microformat's isShortsEligible (true for
 * 0U0O-P43MNQ and false for every other recorded video, 2026-11-15); else
 * the video is vertical (every video stream taller than wide) and at most
 * 3 minutes long. The ANDROID player and the WEB `next` response carry no
 * Shorts flag (checked on 2026-11-14 with 0U0O-P43MNQ).
 */
export function detectShort(
  ref: VideoRef,
  player: Player,
  durationSec: number | undefined,
  microformat?: MicroformatInfo,
): boolean {
  if (/\/shorts\//i.test(ref.input)) return true;
  if (microformat?.isShortsEligible !== undefined) return microformat.isShortsEligible;
  if (!durationSec || durationSec > SHORT_MAX_SEC || player.videoDetails?.isLiveContent) return false;
  const streams = [...(player.streamingData?.formats ?? []), ...(player.streamingData?.adaptiveFormats ?? [])].filter(
    (f) => f.width && f.height,
  );
  return streams.length > 0 && streams.every((f) => (f.height ?? 0) > (f.width ?? 0));
}

/** The scheduled start of an upcoming live stream or premiere, ISO 8601. */
function scheduledStart(player: Player): string | undefined {
  const raw =
    player.playabilityStatus?.liveStreamability?.liveStreamabilityRenderer?.offlineSlate?.liveStreamOfflineSlateRenderer
      ?.scheduledStartTime;
  const sec = Number(raw);
  return raw && Number.isFinite(sec) && sec > 0 ? new Date(sec * 1000).toISOString() : undefined;
}

const AGE_REASON = /inappropriate|age.?restrict|confirm your age/i;
const MEMBERS_REASON = /members|join this channel/i;

/** Chapters by precedence: creator timestamps in the description, then YouTube's chapter markers, then auto key moments. */
export function pickChapters(
  description: string | undefined,
  durationSec: number | undefined,
  watch: WatchInfo | undefined,
): { chapters: Chapter[]; source?: ChapterSource } {
  const fromDescription = parseDescriptionChapters(description, durationSec);
  if (fromDescription.length > 0) return { chapters: fromDescription, source: 'description' };
  if (watch && watch.descriptionMarkers.length > 0)
    return { chapters: withEnds(watch.descriptionMarkers, durationSec), source: 'markers' };
  if (watch && watch.autoChapters.length > 0)
    return { chapters: withEnds(watch.autoChapters, durationSec), source: 'key-moments' };
  return { chapters: [] };
}

const handleUrl = (handle: string | undefined) => (handle ? `https://www.youtube.com/${handle}` : undefined);

/** Drop undefined values so JSON output stays clean. */
function compact(o: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));
}

export interface MetadataExtras {
  /** The parsed `next` response, when that request succeeded. */
  watch?: WatchInfo;
  /** The WEB player microformat, when that request succeeded. */
  microformat?: MicroformatInfo;
  /** The maxresdefault URL, when the CDN confirmed it exists (checked only without a microformat). */
  maxresThumbnail?: string;
}

/** The best thumbnail: a confirmed maxres, else the largest one listed by either player response. */
function bestThumbnail(player: Player, extras: MetadataExtras): string | undefined {
  if (extras.maxresThumbnail) return extras.maxresThumbnail;
  const listed: Thumbnail[] = [...(player.videoDetails?.thumbnail?.thumbnails ?? [])];
  const mf = extras.microformat?.thumbnailUrl;
  if (mf && /\/maxresdefault\./.test(mf)) return mf;
  const own = largestThumbnail(listed);
  return own ?? mf;
}

/** Build VideoMetadata from a player response plus the optional watch-page data. Pure: no I/O. */
export function toMetadata(ref: VideoRef, player: Player, extras: MetadataExtras = {}): VideoMetadata {
  const d = player.videoDetails;
  const { watch, microformat } = extras;
  const status = player.playabilityStatus?.status;
  const reason = player.playabilityStatus?.reason ?? '';
  const durationSec = Number(d?.lengthSeconds) || undefined;
  const isLive = d?.isLive === true;
  const isUpcoming = d?.isUpcoming === true;
  const { chapters, source } = pickChapters(d?.shortDescription, durationSec, watch);
  const links = extractLinks(d?.shortDescription);
  const channelId = d?.channelId ?? watch?.channelId;
  const channelName = d?.author ?? watch?.channelName;
  const viewCount = Number(d?.viewCount);

  const meta: VideoMetadata = {
    ref,
    title: d?.title ?? ref.url ?? ref.input,
    description: d?.shortDescription,
    durationSec,
    // An upcoming stream's publishDate is when its page was created, not when it airs.
    publishedAt: (isUpcoming ? undefined : microformat?.publishDate) ?? watch?.publishedAt,
    thumbnailUrl: bestThumbnail(player, extras),
    language: originalLanguage(player),
    tags: d?.keywords,
    chapters,
    isLive,
    extra: compact({
      viewCount: d?.viewCount !== undefined && Number.isFinite(viewCount) ? viewCount : undefined,
      likeCount: watch?.likeCount ?? microformat?.likeCount,
      liveViewers: watch?.liveViewers,
      dateText: watch?.dateText,
      uploadDate: microformat?.uploadDate,
      category: microformat?.category,
      channelHandle: watch?.channelHandle ?? microformat?.channelHandle,
      channelHandleUrl: handleUrl(watch?.channelHandle ?? microformat?.channelHandle),
      subscriberCountText: watch?.subscriberCountText,
      isShort: detectShort(ref, player, durationSec, microformat),
      isLive,
      isUpcoming,
      premiereAt: isUpcoming ? scheduledStart(player) : undefined,
      isLiveContent: d?.isLiveContent,
      liveStartedAt: isUpcoming ? undefined : microformat?.liveStartedAt,
      liveEndedAt: microformat?.liveEndedAt,
      isUnlisted: microformat?.isUnlisted,
      ageRestricted: status !== 'OK' && AGE_REASON.test(reason),
      membersOnly: (status !== 'OK' && MEMBERS_REASON.test(reason)) || watch?.membersOnly === true,
      playability: status,
      chapterSource: source,
      links: links.length > 0 ? links : undefined,
    }),
  };
  if (channelName) {
    meta.channel = {
      name: channelName,
      id: channelId,
      url: channelId ? `https://www.youtube.com/channel/${channelId}` : undefined,
    };
  }
  return meta;
}

async function loadWatch(videoId: string, ctx: Ctx): Promise<WatchInfo | undefined> {
  try {
    return parseWatch(await fetchNext(videoId, ctx));
  } catch (err) {
    const code = err instanceof Vid2ContextError ? err.code : undefined;
    ctx.log.warn('youtube: next request failed; returning player metadata only', {
      videoId,
      code,
      error: err instanceof Error ? err.message.slice(0, 200) : String(err),
    });
    return undefined;
  }
}

/**
 * Metadata without a player response, for when YouTube blocks the player
 * from this IP. `next` (the watch page's data) and oEmbed often still answer:
 * on 2026-11-14 a GCP VM got HTTP 429 on every caption download and the bot
 * check on the player at times, while both kept working. Pure: no I/O.
 *
 * Missing compared to toMetadata: duration, tags, the spoken language and
 * Shorts detection (only the player has them). `extra.metadataSource` says
 * which sources answered and `extra.playerBlocked` is true.
 */
export function fallbackMetadata(
  ref: VideoRef,
  watch: WatchInfo | undefined,
  oembed: OEmbedInfo | undefined,
  maxres?: string,
): VideoMetadata | null {
  const title = watch?.title ?? oembed?.title;
  if (!title) return null;
  const description = watch?.description;
  const { chapters, source } = pickChapters(description, undefined, watch);
  const links = extractLinks(description);
  const channelName = watch?.channelName ?? oembed?.authorName;
  const handleFromUrl = oembed?.authorUrl && /\/(@[^/?#]+)/.exec(oembed.authorUrl)?.[1];
  const channelHandle = watch?.channelHandle ?? (handleFromUrl || undefined);
  const sources = [watch ? 'next' : undefined, oembed ? 'oembed' : undefined].filter(Boolean).join('+');
  const meta: VideoMetadata = {
    ref,
    title,
    description,
    publishedAt: watch?.publishedAt,
    thumbnailUrl: maxres ?? oembed?.thumbnailUrl,
    chapters,
    isLive: watch?.liveViewers !== undefined ? true : undefined,
    extra: compact({
      viewCount: watch?.viewCount,
      likeCount: watch?.likeCount,
      liveViewers: watch?.liveViewers,
      dateText: watch?.dateText,
      channelHandle,
      channelHandleUrl: channelHandle ? `https://www.youtube.com/${channelHandle}` : undefined,
      subscriberCountText: watch?.subscriberCountText,
      membersOnly: watch?.membersOnly === true ? true : undefined,
      chapterSource: source,
      links: links.length > 0 ? links : undefined,
      metadataSource: sources,
      playerBlocked: true,
    }),
  };
  if (channelName) {
    const id = watch?.channelId;
    meta.channel = {
      name: channelName,
      id,
      url: id ? `https://www.youtube.com/channel/${id}` : (oembed?.authorUrl ?? undefined),
    };
  }
  return meta;
}

/** When the player is blocked: metadata from `next` and oEmbed, or the original block when neither answers. */
async function metadataWithoutPlayer(ref: VideoRef, ctx: Ctx, blocked: Vid2ContextError): Promise<VideoMetadata> {
  const [watch, oembed, maxres] = await Promise.all([
    loadWatch(ref.nativeId, ctx),
    fetchOEmbed(ref.nativeId, ctx),
    findMaxres(ref.nativeId, ctx),
  ]);
  const meta = fallbackMetadata(ref, watch, oembed, maxres);
  if (!meta) throw blocked;
  ctx.log.warn('youtube: player blocked; metadata from the watch page data and oEmbed', {
    videoId: ref.nativeId,
    sources: meta.extra?.metadataSource,
  });
  return meta;
}

/** YOUTUBE_METADATA_MICROFORMAT=1 (or true, yes, on) adds the WEB player request. Off by default to keep the request budget. */
export const microformatEnabled = (ctx: Ctx): boolean =>
  /^(?:1|true|yes|on)$/i.test(ctx.env.YOUTUBE_METADATA_MICROFORMAT?.trim() ?? '');

/**
 * youtube.getMetadata. Throws when the player gives no videoDetails (removed,
 * private), or when YouTube blocks the player and neither `next` nor oEmbed
 * answers either.
 */
export async function getYouTubeMetadata(ref: VideoRef, ctx: Ctx): Promise<VideoMetadata> {
  let player: Player;
  try {
    player = (await getPlayer(ref.nativeId, ctx)) as Player;
  } catch (err) {
    if (err instanceof Vid2ContextError && err.code === 'blocked') return metadataWithoutPlayer(ref, ctx, err);
    throw err;
  }
  if (!player.videoDetails) {
    throw (
      playabilityError(player, ref.nativeId) ??
      new Vid2ContextError('not-found', `YouTube ${ref.nativeId}: the player returned no video details.`, {
        hint: 'Check the video id or URL; the video may have been removed.',
      })
    );
  }
  // A microformat in the shared player response costs nothing; the WEB player request is opt-in.
  const own = parseMicroformat(player);
  const [watch, microformat] = await Promise.all([
    loadWatch(ref.nativeId, ctx),
    own ?? (microformatEnabled(ctx) ? loadMicroformat(ref.nativeId, ctx) : undefined),
  ]);
  const maxresThumbnail = microformat ? undefined : await findMaxres(ref.nativeId, ctx);
  return toMetadata(ref, player, { watch, microformat, maxresThumbnail });
}

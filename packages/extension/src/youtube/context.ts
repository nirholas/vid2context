/**
 * Build a `VideoContext` from what the watch page already holds: metadata
 * from the player response's `videoDetails`, chapters from the provider's
 * description parser, and the transcript from the chosen caption track.
 */
import type { Attempt, Segment, VideoContext, VideoMetadata, VideoRef } from '@vid2context/core';
import { chooseTrack, matchYouTube, parseDescriptionChapters, spokenLanguage } from '@vid2context/provider-youtube';
import { type CaptionTrack, captionTracks, defaultTrackIndex, type WatchPlayerResponse } from './player.ts';

export type TrackChoice = NonNullable<ReturnType<typeof chooseTrack>>;

/** The provider's track choice for this page (spoken language first, creator captions before auto). */
export function pickTrack(player: WatchPlayerResponse, language?: string): TrackChoice | null {
  return chooseTrack(captionTracks(player), language ? { language } : {}, defaultTrackIndex(player));
}

export function watchRef(videoId: string): VideoRef {
  const ref = matchYouTube(`https://www.youtube.com/watch?v=${videoId}`);
  if (!ref) throw new Error(`Not a YouTube video id: ${videoId}`);
  return ref;
}

function isoDate(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const t = Date.parse(raw);
  return Number.isFinite(t) ? new Date(t).toISOString() : undefined;
}

export function metadataFrom(player: WatchPlayerResponse, ref: VideoRef): VideoMetadata {
  const d = player.videoDetails;
  const durationSec = Number(d?.lengthSeconds) || undefined;
  const thumbs = d?.thumbnail?.thumbnails ?? [];
  const largest = [...thumbs].sort((a, b) => (b.width ?? 0) - (a.width ?? 0))[0];
  const micro = player.microformat?.playerMicroformatRenderer;
  const meta: VideoMetadata = {
    ref,
    title: d?.title ?? ref.url ?? ref.input,
    chapters: parseDescriptionChapters(d?.shortDescription, durationSec),
  };
  if (d?.shortDescription) meta.description = d.shortDescription;
  if (durationSec) meta.durationSec = durationSec;
  const publishedAt = isoDate(micro?.publishDate ?? micro?.uploadDate);
  if (publishedAt) meta.publishedAt = publishedAt;
  if (largest?.url) meta.thumbnailUrl = largest.url;
  const language = spokenLanguage(captionTracks(player));
  if (language) meta.language = language;
  if (d?.keywords?.length) meta.tags = d.keywords;
  if (d?.isLive) meta.isLive = true;
  if (d?.author) {
    meta.channel = {
      name: d.author,
      ...(d.channelId ? { id: d.channelId, url: `https://www.youtube.com/channel/${d.channelId}` } : {}),
    };
  }
  const viewCount = d?.viewCount === undefined ? undefined : Number(d.viewCount);
  meta.extra = {
    ...(viewCount !== undefined && Number.isFinite(viewCount) ? { viewCount } : {}),
    ...(micro?.category ? { category: micro.category } : {}),
    playability: player.playabilityStatus?.status,
  };
  return meta;
}

export interface BuildInput {
  player: WatchPlayerResponse;
  choice: TrackChoice;
  segments: Segment[];
  /** Milliseconds the caption download took, for the attempt record. */
  ms?: number;
  usedPoToken?: boolean;
  /** Creation time; tests pass a fixed one. */
  now?: Date;
}

export function buildVideoContext(input: BuildInput): VideoContext {
  const videoId = input.player.videoDetails?.videoId;
  if (!videoId) throw new Error('The player response has no videoDetails.videoId.');
  const ref = watchRef(videoId);
  const track: CaptionTrack = input.choice.track;
  const attempt: Attempt = {
    id: 'youtube-captions',
    stage: 'captions',
    outcome: 'ok',
    detail: `Fetched in the browser by the vid2context extension (${track.languageCode}${input.usedPoToken ? ', with the player token' : ''}).`,
    ...(input.ms !== undefined ? { ms: input.ms } : {}),
  };
  return {
    metadata: metadataFrom(input.player, ref),
    transcript: {
      ref,
      language: input.choice.translateTo ?? track.languageCode,
      origin: input.choice.origin,
      producer: 'youtube-captions',
      ...(input.choice.translateTo ? { translated: true } : {}),
      segments: input.segments,
      createdAt: (input.now ?? new Date()).toISOString(),
    },
    attempts: [attempt],
  };
}

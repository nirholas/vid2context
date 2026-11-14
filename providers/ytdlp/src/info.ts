/**
 * Mapping from yt-dlp's info JSON (-J) to vid2context types. Field names are
 * yt-dlp's documented output template fields.
 */
import type { Chapter, Comment, VideoMetadata, VideoRef } from '@vid2context/core';
import { matchUrl } from './refs.ts';

export interface YtDlpThumbnail {
  url?: string;
  width?: number;
  height?: number;
  preference?: number;
}

export interface YtDlpSubtitle {
  ext?: string;
  name?: string;
}

export interface YtDlpComment {
  id?: string;
  parent?: string;
  text?: string;
  like_count?: number | null;
  author?: string;
  author_id?: string;
  author_is_uploader?: boolean;
  is_pinned?: boolean;
  timestamp?: number | null;
}

export interface YtDlpInfo {
  _type?: string;
  id?: string;
  title?: string;
  fulltitle?: string;
  description?: string | null;
  duration?: number | null;
  upload_date?: string | null;
  timestamp?: number | null;
  release_timestamp?: number | null;
  uploader?: string | null;
  uploader_id?: string | null;
  uploader_url?: string | null;
  channel?: string | null;
  channel_id?: string | null;
  channel_url?: string | null;
  thumbnail?: string | null;
  thumbnails?: YtDlpThumbnail[] | null;
  tags?: string[] | null;
  categories?: string[] | null;
  language?: string | null;
  is_live?: boolean | null;
  live_status?: string | null;
  chapters?: { start_time?: number; end_time?: number; title?: string }[] | null;
  view_count?: number | null;
  like_count?: number | null;
  comment_count?: number | null;
  extractor?: string;
  extractor_key?: string;
  webpage_url?: string;
  original_url?: string;
  ie_key?: string;
  url?: string;
  subtitles?: Record<string, YtDlpSubtitle[]> | null;
  automatic_captions?: Record<string, YtDlpSubtitle[]> | null;
  comments?: YtDlpComment[] | null;
  entries?: (YtDlpInfo | null)[] | null;
}

/** "20050424" -> "2005-04-24". */
export function uploadDateToIso(d: string | null | undefined): string | undefined {
  const m = /^(\d{4})(\d{2})(\d{2})$/.exec(d ?? '');
  return m ? `${m[1]}-${m[2]}-${m[3]}` : undefined;
}

function publishedAt(info: YtDlpInfo): string | undefined {
  const ts = info.timestamp ?? info.release_timestamp;
  if (typeof ts === 'number' && Number.isFinite(ts)) return new Date(ts * 1000).toISOString();
  return uploadDateToIso(info.upload_date);
}

function bestThumbnail(info: YtDlpInfo): string | undefined {
  if (info.thumbnail) return info.thumbnail;
  const thumbs = (info.thumbnails ?? []).filter((t) => t.url);
  thumbs.sort((a, b) => (b.preference ?? 0) - (a.preference ?? 0) || (b.width ?? 0) - (a.width ?? 0));
  return thumbs[0]?.url;
}

function chaptersOf(info: YtDlpInfo): Chapter[] {
  return (info.chapters ?? [])
    .filter((c) => typeof c.start_time === 'number')
    .map((c, i) => ({
      title: c.title?.trim() || `Chapter ${i + 1}`,
      startSec: c.start_time as number,
      ...(typeof c.end_time === 'number' ? { endSec: c.end_time } : {}),
    }));
}

function channelOf(info: YtDlpInfo): VideoMetadata['channel'] {
  const name = info.channel ?? info.uploader;
  if (!name) return undefined;
  const id = info.channel_id ?? info.uploader_id ?? undefined;
  const url = info.channel_url ?? info.uploader_url ?? undefined;
  return { name, ...(id ? { id } : {}), ...(url ? { url } : {}) };
}

export function toMetadata(ref: VideoRef, info: YtDlpInfo): VideoMetadata {
  const meta: VideoMetadata = {
    ref,
    title: info.title || info.fulltitle || ref.url || ref.input,
    chapters: chaptersOf(info),
  };
  const channel = channelOf(info);
  if (channel) meta.channel = channel;
  if (info.description) meta.description = info.description;
  if (typeof info.duration === 'number' && info.duration > 0) meta.durationSec = info.duration;
  const published = publishedAt(info);
  if (published) meta.publishedAt = published;
  const thumb = bestThumbnail(info);
  if (thumb) meta.thumbnailUrl = thumb;
  if (info.language) meta.language = info.language;
  if (info.tags && info.tags.length > 0) meta.tags = info.tags;
  if (typeof info.is_live === 'boolean') meta.isLive = info.is_live;
  const extra: Record<string, unknown> = {};
  if (info.extractor_key) extra.extractor = info.extractor_key;
  if (info.webpage_url) extra.webpageUrl = info.webpage_url;
  if (info.id) extra.extractorId = info.id;
  if (typeof info.view_count === 'number') extra.viewCount = info.view_count;
  if (typeof info.like_count === 'number') extra.likeCount = info.like_count;
  if (typeof info.comment_count === 'number') extra.commentCount = info.comment_count;
  if (info.categories && info.categories.length > 0) extra.categories = info.categories;
  if (info.live_status) extra.liveStatus = info.live_status;
  if (Object.keys(extra).length > 0) meta.extra = extra;
  return meta;
}

/** Flat yt-dlp comments (each with a `parent`) to a tree of at most `limit` comments counted across all levels. */
export function toComments(raw: YtDlpComment[], limit: number): Comment[] {
  const byId = new Map<string, Comment>();
  const roots: Comment[] = [];
  let count = 0;
  for (const c of raw) {
    if (count >= limit) break;
    if (!c.id || typeof c.text !== 'string') continue;
    const comment: Comment = { id: c.id, author: c.author ?? c.author_id ?? '', text: c.text };
    if (typeof c.like_count === 'number') comment.likes = c.like_count;
    if (typeof c.timestamp === 'number') comment.publishedAt = new Date(c.timestamp * 1000).toISOString();
    if (c.author_is_uploader) comment.isCreator = true;
    if (c.is_pinned) comment.isPinned = true;
    const parent = c.parent && c.parent !== 'root' ? byId.get(c.parent) : undefined;
    if (parent) {
      parent.replies ??= [];
      parent.replies.push(comment);
    } else {
      roots.push(comment);
    }
    byId.set(c.id, comment);
    count++;
  }
  return roots;
}

/** A --flat-playlist entry to a ref, preferring its page URL. */
export function entryRef(entry: YtDlpInfo): VideoRef | null {
  for (const candidate of [entry.webpage_url, entry.url, entry.original_url]) {
    if (candidate && /^https?:\/\//i.test(candidate)) {
      const ref = matchUrl(candidate);
      if (ref) return ref;
    }
  }
  if (entry.id && entry.ie_key === 'Youtube') {
    return matchUrl(`https://www.youtube.com/watch?v=${entry.id}`);
  }
  return null;
}

/**
 * One normalized shape for an X post, parsed from X's syndication endpoint
 * (`cdn.syndication.twimg.com/tweet-result`, the JSON behind X's embedded
 * posts), the FxTwitter API, or x.com's GraphQL `TweetResultByRestId` (guest
 * token, only with X_BEARER_TOKEN). All list every MP4 rendition of a video
 * with its bitrate; widths and heights come from the rendition URL
 * (`.../vid/avc1/1280x720/...mp4`).
 */

export type XMediaType = 'video' | 'gif' | 'photo';

export interface XVariant {
  url: string;
  /** Bits per second; absent (or 0) for GIFs. */
  bitrate?: number;
  width?: number;
  height?: number;
  /** Shorter side plus "p" ("720p"), when the size is known. */
  quality?: string;
}

export interface XMedia {
  type: XMediaType;
  durationSec?: number;
  width?: number;
  height?: number;
  thumbnailUrl?: string;
  /** MP4 renditions, highest bitrate first. Empty for photos. */
  variants: XVariant[];
  /** The HLS playlist, when X lists one. */
  hls?: string;
}

export interface XPost {
  id: string;
  /** Display text: no leading reply mentions, no trailing media link, t.co links expanded. */
  text: string;
  author: { name: string; handle: string; id?: string };
  /** ISO 8601. */
  createdAt?: string;
  /** X's guess at the text language (not the spoken one). */
  lang?: string;
  hashtags: string[];
  likes?: number;
  replies?: number;
  reposts?: number;
  views?: number;
  replyTo?: string;
  /** The id of the post this one quotes. Neither service sends the quoted post's media, so it is fetched on its own. */
  quotedId?: string;
  /** Every media item in post order (photos too, so /video/<n> positions line up). */
  media: XMedia[];
  via: 'syndication' | 'fxtwitter' | 'graphql';
}

const SIZE = /\/(\d{2,5})x(\d{2,5})\//;

export function variantOf(url: string, bitrate?: number): XVariant {
  const m = SIZE.exec(url);
  const width = m ? Number(m[1]) : undefined;
  const height = m ? Number(m[2]) : undefined;
  return {
    url,
    ...(bitrate ? { bitrate } : {}),
    ...(width && height ? { width, height, quality: `${Math.min(width, height)}p` } : {}),
  };
}

function byBitrateDesc(a: XVariant, b: XVariant): number {
  return (b.bitrate ?? 0) - (a.bitrate ?? 0) || (b.height ?? 0) - (a.height ?? 0);
}

export function decodeEntities(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

function iso(v: unknown): string | undefined {
  if (typeof v !== 'string' && typeof v !== 'number') return undefined;
  const d = new Date(typeof v === 'number' ? v * 1000 : v);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

// ---------------------------------------------------------------- syndication

interface SynVariant {
  bitrate?: number;
  content_type?: string;
  url?: string;
}

interface SynMedia {
  type?: string;
  media_url_https?: string;
  original_info?: { width?: number; height?: number };
  video_info?: { duration_millis?: number; variants?: SynVariant[] };
}

export interface SyndicationTweet {
  __typename?: string;
  id_str?: string;
  text?: string;
  lang?: string;
  created_at?: string;
  display_text_range?: [number, number];
  favorite_count?: number;
  conversation_count?: number;
  in_reply_to_screen_name?: string;
  user?: { id_str?: string; name?: string; screen_name?: string };
  entities?: {
    urls?: { url?: string; expanded_url?: string }[];
    hashtags?: { text?: string }[];
    media?: { url?: string }[];
  };
  mediaDetails?: SynMedia[];
  tombstone?: { text?: { text?: string } };
  quoted_tweet?: { id_str?: string };
}

function synMedia(m: SynMedia): XMedia {
  const type: XMediaType = m.type === 'animated_gif' ? 'gif' : m.type === 'video' ? 'video' : 'photo';
  const all = m.video_info?.variants ?? [];
  const variants = all
    .filter((v) => v.content_type === 'video/mp4' && v.url)
    .map((v) => variantOf(v.url as string, v.bitrate))
    .sort(byBitrateDesc);
  const hls = all.find((v) => v.content_type === 'application/x-mpegURL')?.url;
  const ms = num(m.video_info?.duration_millis);
  return {
    type,
    ...(ms ? { durationSec: ms / 1000 } : {}),
    ...(m.original_info?.width && m.original_info.height ? { width: m.original_info.width, height: m.original_info.height } : {}),
    ...(m.media_url_https ? { thumbnailUrl: m.media_url_https } : {}),
    variants: type === 'photo' ? [] : variants,
    ...(hls ? { hls } : {}),
  };
}

/** The display text: X's display range (code points), media links dropped, t.co links expanded. */
function synText(t: Pick<SyndicationTweet, 'text' | 'display_text_range' | 'entities'>): string {
  const chars = Array.from(t.text ?? '');
  const [start, end] = t.display_text_range ?? [0, chars.length];
  let text = chars.slice(start, end).join('');
  for (const m of t.entities?.media ?? []) if (m.url) text = text.split(m.url).join('');
  for (const u of t.entities?.urls ?? []) if (u.url && u.expanded_url) text = text.split(u.url).join(u.expanded_url);
  return decodeEntities(text).trim();
}

export function fromSyndication(t: SyndicationTweet): XPost {
  return {
    id: t.id_str ?? '',
    text: synText(t),
    author: { name: t.user?.name ?? t.user?.screen_name ?? '', handle: t.user?.screen_name ?? '', id: t.user?.id_str },
    createdAt: iso(t.created_at),
    lang: t.lang,
    hashtags: (t.entities?.hashtags ?? []).map((h) => h.text).filter((h): h is string => Boolean(h)),
    likes: num(t.favorite_count),
    replies: num(t.conversation_count),
    ...(t.in_reply_to_screen_name ? { replyTo: t.in_reply_to_screen_name } : {}),
    ...(t.quoted_tweet?.id_str ? { quotedId: t.quoted_tweet.id_str } : {}),
    media: (t.mediaDetails ?? []).map(synMedia),
    via: 'syndication',
  };
}

// ---------------------------------------------------------------- graphql

/** `legacy` of a GraphQL tweet: the v1.1 tweet object, the same shape syndication sends with `full_text` for `text`. */
interface GqlLegacy {
  id_str?: string;
  full_text?: string;
  lang?: string;
  created_at?: string;
  display_text_range?: [number, number];
  favorite_count?: number;
  reply_count?: number;
  retweet_count?: number;
  in_reply_to_screen_name?: string;
  quoted_status_id_str?: string;
  entities?: SyndicationTweet['entities'];
  extended_entities?: { media?: SynMedia[] };
}

interface GqlUser {
  rest_id?: string;
  /** Where X keeps the name and handle since 2025. */
  core?: { name?: string; screen_name?: string };
  /** Where they were before. */
  legacy?: { name?: string; screen_name?: string };
}

/** `data.tweetResult.result` of `TweetResultByRestId`. */
export interface GqlTweetResult {
  __typename?: string;
  rest_id?: string;
  /** Set when the result is a `TweetWithVisibilityResults` wrapper. */
  tweet?: GqlTweetResult;
  core?: { user_results?: { result?: GqlUser } };
  legacy?: GqlLegacy;
  views?: { count?: string };
  /** Present on `TweetTombstone` results. */
  tombstone?: { text?: { text?: string } };
}

export function fromGraphQL(result: GqlTweetResult): XPost {
  const t = result.tweet ?? result;
  const legacy = t.legacy ?? {};
  const user = t.core?.user_results?.result;
  const name = user?.core?.name ?? user?.legacy?.name;
  const handle = user?.core?.screen_name ?? user?.legacy?.screen_name ?? '';
  const views = Number(t.views?.count);
  return {
    id: legacy.id_str ?? t.rest_id ?? '',
    text: synText({ text: legacy.full_text, display_text_range: legacy.display_text_range, entities: legacy.entities }),
    author: { name: name ?? handle, handle, id: user?.rest_id },
    createdAt: iso(legacy.created_at),
    lang: legacy.lang,
    hashtags: (legacy.entities?.hashtags ?? []).map((h) => h.text).filter((h): h is string => Boolean(h)),
    likes: num(legacy.favorite_count),
    replies: num(legacy.reply_count),
    reposts: num(legacy.retweet_count),
    ...(Number.isFinite(views) && t.views?.count ? { views } : {}),
    ...(legacy.in_reply_to_screen_name ? { replyTo: legacy.in_reply_to_screen_name } : {}),
    ...(legacy.quoted_status_id_str ? { quotedId: legacy.quoted_status_id_str } : {}),
    media: (legacy.extended_entities?.media ?? []).map(synMedia),
    via: 'graphql',
  };
}

// ---------------------------------------------------------------- fxtwitter

interface FxFormat {
  url?: string;
  bitrate?: number;
  container?: string;
}

interface FxMedia {
  type?: string;
  url?: string;
  thumbnail_url?: string;
  duration?: number;
  width?: number;
  height?: number;
  formats?: FxFormat[];
}

export interface FxTweet {
  id?: string;
  text?: string;
  lang?: string;
  created_timestamp?: number;
  likes?: number;
  replies?: number;
  retweets?: number;
  views?: number;
  replying_to?: string | null;
  author?: { id?: string; name?: string; screen_name?: string };
  raw_text?: { facets?: { type?: string; original?: string }[] };
  media?: { all?: FxMedia[] };
  quote?: { id?: string } | null;
}

function fxMedia(m: FxMedia): XMedia {
  const type: XMediaType = m.type === 'gif' ? 'gif' : m.type === 'video' ? 'video' : 'photo';
  const formats = m.formats ?? [];
  const variants = formats
    .filter((f) => f.container === 'mp4' && f.url)
    .map((f) => variantOf(f.url as string, f.bitrate))
    .sort(byBitrateDesc);
  const hls = formats.find((f) => f.container === 'm3u8')?.url;
  return {
    type,
    ...(num(m.duration) ? { durationSec: m.duration } : {}),
    ...(m.width && m.height ? { width: m.width, height: m.height } : {}),
    ...(m.thumbnail_url || type === 'photo' ? { thumbnailUrl: m.thumbnail_url ?? m.url } : {}),
    variants: type === 'photo' ? [] : variants,
    ...(hls ? { hls } : {}),
  };
}

export function fromFxTwitter(t: FxTweet): XPost {
  const hashtags = (t.raw_text?.facets ?? []).filter((f) => f.type === 'hashtag' && f.original).map((f) => f.original as string);
  return {
    id: t.id ?? '',
    text: decodeEntities(t.text ?? '').trim(),
    author: { name: t.author?.name ?? t.author?.screen_name ?? '', handle: t.author?.screen_name ?? '', id: t.author?.id },
    createdAt: iso(t.created_timestamp),
    lang: t.lang,
    hashtags,
    likes: num(t.likes),
    replies: num(t.replies),
    reposts: num(t.retweets),
    views: num(t.views),
    ...(t.replying_to ? { replyTo: t.replying_to } : {}),
    ...(t.quote?.id ? { quotedId: t.quote.id } : {}),
    media: (t.media?.all ?? []).map(fxMedia),
    via: 'fxtwitter',
  };
}

// ---------------------------------------------------------------- helpers

const URLISH = /https?:\/\/\S+/g;

/** A short title from the post text: its first line without links, at most 100 characters. */
export function titleOf(post: XPost): string {
  const line =
    post.text
      .split('\n')
      .map((l) => l.replace(URLISH, '').replace(/\s+/g, ' ').trim())
      .find(Boolean) ?? '';
  if (!line) return post.author.handle ? `Video by @${post.author.handle}` : `X post ${post.id}`;
  const chars = Array.from(line);
  if (chars.length <= 100) return line;
  const cut = chars.slice(0, 100).join('');
  const space = cut.lastIndexOf(' ');
  return `${(space > 60 ? cut.slice(0, space) : cut).replace(/[\s,.;:]+$/, '')}...`;
}

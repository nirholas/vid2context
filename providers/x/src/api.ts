/**
 * Fetching a post. First X's own syndication endpoint (the JSON behind
 * embedded posts: no key, no login, no cookies). When that fails, the
 * FxTwitter API (`api.fxtwitter.com`, a public keyless service that also
 * reads some posts syndication refuses). `X_FXTWITTER=0` turns the fallback
 * off; `X_FXTWITTER_BASE_URL` points it at a self-hosted FxEmbed instance.
 *
 * Results are cached per ctx, so metadata and audio for one post cost one request.
 */
import { type Ctx, errorFromResponse, fetchWithTimeout, Vid2ContextError } from '@vid2context/core';
import { type FxTweet, fromFxTwitter, fromSyndication, type SyndicationTweet, type XMedia, type XPost } from './post.ts';
import { postUrl, type XTarget } from './url.ts';

export const SYNDICATION = 'https://cdn.syndication.twimg.com/tweet-result';
export const FXTWITTER = 'https://api.fxtwitter.com';

const NOT_FOUND_HINT =
  'Only public posts can be read. The post may be deleted, from a protected or suspended account, or the link may be wrong.';

/** The token X's embed widget sends with each lookup, derived from the post id. */
export function syndicationToken(postId: string): string {
  return ((Number(postId) / 1e15) * Math.PI).toString(36).replace(/(0+|\.)/g, '');
}

export function syndicationUrl(postId: string): string {
  return `${SYNDICATION}?id=${postId}&lang=en&token=${syndicationToken(postId)}`;
}

function notFound(postId: string): Vid2ContextError {
  return new Vid2ContextError('not-found', `X post ${postId} was not found.`, { status: 404, hint: NOT_FOUND_HINT });
}

export async function fetchSyndication(postId: string, ctx: Ctx): Promise<XPost> {
  const res = await fetchWithTimeout(ctx, syndicationUrl(postId), { headers: { accept: 'application/json' } });
  if (res.status === 404) {
    await res.body?.cancel().catch(() => undefined);
    throw notFound(postId);
  }
  if (!res.ok) throw await errorFromResponse(res, 'X syndication');
  const body = (await res.json()) as SyndicationTweet;
  if (body.__typename === 'TweetTombstone') {
    throw new Vid2ContextError('unavailable', `X will not show post ${postId}: ${body.tombstone?.text?.text ?? 'unavailable'}`, {
      hint: 'Age-restricted and withheld posts need a logged-in account. On Node, yt-dlp with browser cookies can read them.',
    });
  }
  if (!body.id_str) throw notFound(postId);
  return fromSyndication(body);
}

export function fxtwitterEnabled(ctx: Ctx): boolean {
  return ctx.env.X_FXTWITTER !== '0';
}

export async function fetchFxTwitter(postId: string, ctx: Ctx): Promise<XPost> {
  const base = (ctx.env.X_FXTWITTER_BASE_URL || FXTWITTER).replace(/\/+$/, '');
  const res = await fetchWithTimeout(ctx, `${base}/i/status/${postId}`, { headers: { accept: 'application/json' } });
  if (res.status === 404) {
    await res.body?.cancel().catch(() => undefined);
    throw notFound(postId);
  }
  if (!res.ok) throw await errorFromResponse(res, 'FxTwitter');
  const body = (await res.json()) as { code?: number; tweet?: FxTweet | null };
  if (!body.tweet?.id) throw notFound(postId);
  return fromFxTwitter(body.tweet);
}

async function load(postId: string, ctx: Ctx): Promise<XPost> {
  try {
    return await fetchSyndication(postId, ctx);
  } catch (err) {
    if (!fxtwitterEnabled(ctx)) throw err;
    ctx.log.debug('x syndication failed, trying FxTwitter', { postId, error: String(err) });
    try {
      return await fetchFxTwitter(postId, ctx);
    } catch (fxErr) {
      ctx.log.debug('x FxTwitter failed too', { postId, error: String(fxErr) });
      // The first lane's error says more (a tombstone reason, a rate limit) unless it was a bare not-found.
      if (err instanceof Vid2ContextError && err.code === 'not-found' && fxErr instanceof Vid2ContextError) throw fxErr;
      throw err;
    }
  }
}

const cache = new WeakMap<Ctx, Map<string, Promise<XPost>>>();

export function getPost(postId: string, ctx: Ctx): Promise<XPost> {
  let perCtx = cache.get(ctx);
  if (!perCtx) {
    perCtx = new Map();
    cache.set(ctx, perCtx);
  }
  const hit = perCtx.get(postId);
  if (hit) return hit;
  const pending = load(postId, ctx);
  perCtx.set(postId, pending);
  pending.catch(() => perCtx.delete(postId));
  return pending;
}

export interface ResolvedVideo {
  /** The post that holds the video: the linked post, or the post it quotes. */
  post: XPost;
  media: XMedia;
  position: number;
  /** The linked post, when the video came from the post it quotes. */
  quotedBy?: XPost;
}

/**
 * The video a target means. When the linked post has no video of its own
 * and quotes another post, the quoted post's video is used (one level: a
 * quote of a quote is not followed further).
 */
export async function resolveVideo(target: XTarget, ctx: Ctx): Promise<ResolvedVideo> {
  const post = await getPost(target.postId, ctx);
  try {
    return { post, ...pickMedia(post, target) };
  } catch (err) {
    const noVideo = err instanceof Vid2ContextError && err.code === 'unavailable' && !target.media;
    if (!noVideo || !post.quotedId) throw err;
    const quoted = await getPost(post.quotedId, ctx).catch((qErr: unknown) => {
      ctx.log.debug('x quoted post lookup failed', { postId: post.quotedId, error: String(qErr) });
      throw err;
    });
    try {
      return { post: quoted, ...pickMedia(quoted, { postId: quoted.id }), quotedBy: post };
    } catch {
      throw new Vid2ContextError('unavailable', `Neither X post ${post.id} nor the post it quotes (${quoted.id}) has a video.`, {
        hint: 'Link the post that holds the video itself.',
      });
    }
  }
}

/** The media item a target names: its explicit position, else the post's first video or GIF. */
export function pickMedia(post: XPost, target: XTarget): { media: XMedia; position: number } {
  if (target.media) {
    const media = post.media[target.media - 1];
    if (!media) {
      throw new Vid2ContextError('not-found', `X post ${post.id} has no media item ${target.media}.`, {
        hint: `It has ${post.media.length} media item${post.media.length === 1 ? '' : 's'}. Try ${postUrl(post.id)}.`,
      });
    }
    if (media.type === 'photo') {
      throw new Vid2ContextError('unavailable', `Media item ${target.media} of X post ${post.id} is a photo, not a video.`, {
        hint: 'Link a post, or a /video/<n> position, that holds a video.',
      });
    }
    return { media, position: target.media };
  }
  const index = post.media.findIndex((m) => m.type !== 'photo');
  const media = post.media[index];
  if (!media) {
    throw new Vid2ContextError('unavailable', `X post ${post.id} has no video.`, {
      hint: post.media.length
        ? 'The post has only images. If the video is in a quoted post, use the quoted post link.'
        : 'The post is text only. If the video is in a quoted post or a reply, use that post link.',
    });
  }
  return { media, position: index + 1 };
}

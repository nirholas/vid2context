/**
 * Fetching a post, first lane that answers wins:
 *
 *   1. X's own syndication endpoint (the JSON behind embedded posts: no key,
 *      no login, no cookies).
 *   2. The FxTwitter API (`api.fxtwitter.com`, a public keyless service that
 *      also reads some posts syndication refuses). `X_FXTWITTER=0` turns it
 *      off; `X_FXTWITTER_BASE_URL` points it at a self-hosted FxEmbed instance.
 *   3. x.com's GraphQL `TweetResultByRestId` with a guest token, only when
 *      `X_BEARER_TOKEN` (or `TWITTER_BEARER_TOKEN`) is set: the lane xactions
 *      (nirholas/xactions, `src/video/edgeExtractor.js`) runs for
 *      xactions.app/video, for when both keyless lanes are rate limited or down.
 *      `X_GRAPHQL_QUERY_ID` overrides the operation id when X rotates it.
 *
 * Results are cached per ctx, so metadata and audio for one post cost one request.
 */
import { type Ctx, errorFromResponse, fetchWithTimeout, Vid2ContextError } from '@vid2context/core';
import {
  type FxTweet,
  fromFxTwitter,
  fromGraphQL,
  fromSyndication,
  type GqlTweetResult,
  type SyndicationTweet,
  type XMedia,
  type XPost,
} from './post.ts';
import { postUrl, type XTarget } from './url.ts';

export const SYNDICATION = 'https://cdn.syndication.twimg.com/tweet-result';
export const FXTWITTER = 'https://api.fxtwitter.com';
export const X_API = 'https://api.x.com';
/** The `TweetResultByRestId` operation id x.com's web client used on 2026-11-19 (as in xactions). */
export const GRAPHQL_TWEET_QUERY_ID = 'GZsN2Pc4knAoit6pXa4HSA';

/**
 * Every lane names its client. Cloudflare Workers' fetch sends no user-agent, and without one X's syndication
 * endpoint answers 400 and FxTwitter 401 (checked 2026-11-19, which is how the public Worker failed every X link).
 * Node's default `user-agent: node` is refused by X's guest activation with 404. video.twimg.com needs none.
 */
export const USER_AGENT = 'vid2context/0.1 (+https://github.com/nirholas/vid2context)';
const JSON_HEADERS = { accept: 'application/json', 'user-agent': USER_AGENT };

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
  const res = await fetchWithTimeout(ctx, syndicationUrl(postId), { headers: JSON_HEADERS });
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
  const res = await fetchWithTimeout(ctx, `${base}/i/status/${postId}`, { headers: JSON_HEADERS });
  if (res.status === 404) {
    await res.body?.cancel().catch(() => undefined);
    throw notFound(postId);
  }
  if (!res.ok) throw await errorFromResponse(res, 'FxTwitter');
  const body = (await res.json()) as { code?: number; tweet?: FxTweet | null };
  if (!body.tweet?.id) throw notFound(postId);
  return fromFxTwitter(body.tweet);
}

// ---------------------------------------------------------------- graphql

/** The bearer token for the GraphQL lane, or '' when it is off. */
export function bearerToken(ctx: Ctx): string {
  return ctx.env.X_BEARER_TOKEN || ctx.env.TWITTER_BEARER_TOKEN || '';
}

export function graphqlEnabled(ctx: Ctx): boolean {
  return bearerToken(ctx) !== '';
}

/** Feature flags and field toggles as x.com's web client sends them (copied from xactions). X answers 400 without them. */
const GRAPHQL_FEATURES = {
  creator_subscriptions_tweet_preview_api_enabled: true,
  premium_content_api_read_enabled: false,
  communities_web_enable_tweet_community_results_fetch: true,
  c9s_tweet_anatomy_moderator_badge_enabled: true,
  responsive_web_grok_analyze_button_fetch_trends_enabled: false,
  responsive_web_grok_analyze_post_followups_enabled: false,
  responsive_web_jetfuel_frame: false,
  responsive_web_grok_share_attachment_enabled: false,
  responsive_web_grok_annotations_enabled: false,
  articles_preview_enabled: true,
  responsive_web_edit_tweet_api_enabled: true,
  graphql_is_translatable_rweb_tweet_is_translatable_enabled: true,
  view_counts_everywhere_api_enabled: true,
  longform_notetweets_consumption_enabled: true,
  responsive_web_twitter_article_tweet_consumption_enabled: true,
  responsive_web_grok_show_grok_translated_post: false,
  responsive_web_grok_analysis_button_from_backend: false,
  post_ctas_fetch_enabled: false,
  freedom_of_speech_not_reach_fetch_enabled: true,
  standardized_nudges_misinfo: true,
  tweet_with_visibility_results_prefer_gql_limited_actions_policy_enabled: true,
  longform_notetweets_rich_text_read_enabled: true,
  longform_notetweets_inline_media_enabled: true,
  profile_label_improvements_pcf_label_in_post_enabled: true,
  responsive_web_profile_redirect_enabled: false,
  rweb_tipjar_consumption_enabled: true,
  verified_phone_label_enabled: false,
  responsive_web_grok_image_annotation_enabled: false,
  responsive_web_grok_imagine_annotation_enabled: false,
  responsive_web_grok_community_note_auto_translation_is_enabled: false,
  responsive_web_graphql_skip_user_profile_image_extensions_enabled: false,
  responsive_web_graphql_timeline_navigation_enabled: true,
  responsive_web_enhance_cards_enabled: false,
};

const GRAPHQL_FIELD_TOGGLES = {
  withArticleRichContentState: true,
  withArticlePlainText: false,
  withArticleSummaryText: false,
  withArticleVoiceOver: false,
  withGrokAnalyze: false,
  withDisallowedReplyControls: false,
  withPayments: false,
  withAuxiliaryUserLabels: false,
};

export function graphqlUrl(postId: string, ctx: Ctx): string {
  const queryId = ctx.env.X_GRAPHQL_QUERY_ID || GRAPHQL_TWEET_QUERY_ID;
  const variables = { tweetId: postId, withCommunity: false, includePromotedContent: false, withVoice: false };
  const q = (v: unknown) => encodeURIComponent(JSON.stringify(v));
  return `${X_API}/graphql/${queryId}/TweetResultByRestId?variables=${q(variables)}&features=${q(GRAPHQL_FEATURES)}&fieldToggles=${q(GRAPHQL_FIELD_TOGGLES)}`;
}

/** Guest tokens last about three hours; one is reused for 2.5 hours per bearer token. */
const GUEST_TTL_MS = 2.5 * 3600_000;
const guestTokens = new Map<string, { token: string; until: number }>();

/** Forget cached guest tokens (tests). */
export function clearGuestTokens(): void {
  guestTokens.clear();
}

function webHeaders(bearer: string): Record<string, string> {
  return {
    authorization: `Bearer ${bearer}`,
    referer: 'https://x.com/',
    origin: 'https://x.com',
    accept: 'application/json',
    'user-agent': USER_AGENT,
  };
}

export async function guestToken(ctx: Ctx): Promise<string> {
  const bearer = bearerToken(ctx);
  const hit = guestTokens.get(bearer);
  if (hit && hit.until > Date.now()) return hit.token;
  const res = await fetchWithTimeout(ctx, `${X_API}/1.1/guest/activate.json`, { method: 'POST', headers: webHeaders(bearer) });
  if (!res.ok) throw await errorFromResponse(res, 'X guest token');
  const body = (await res.json()) as { guest_token?: string };
  if (!body.guest_token) {
    throw new Vid2ContextError('upstream', 'X answered the guest token request without a token.', {
      hint: 'Check X_BEARER_TOKEN: it must be the bearer token of an X web or app client.',
    });
  }
  guestTokens.set(bearer, { token: body.guest_token, until: Date.now() + GUEST_TTL_MS });
  return body.guest_token;
}

/** Statuses that say the guest token itself was refused or worn out: a fresh token can fix them. */
const TOKEN_REFUSED = new Set([401, 403, 429]);

export async function fetchGraphQL(postId: string, ctx: Ctx): Promise<XPost> {
  const ask = async () =>
    fetchWithTimeout(ctx, graphqlUrl(postId, ctx), {
      headers: {
        ...webHeaders(bearerToken(ctx)),
        'x-guest-token': await guestToken(ctx),
        'x-twitter-active-user': 'yes',
        'x-twitter-client-language': 'en',
      },
    });
  let res = await ask();
  if (TOKEN_REFUSED.has(res.status)) {
    // X can revoke or rate-limit a guest token long before it expires. Drop it and try once with a new one, so one
    // bad token does not keep the lane down for the 2.5 hours it would otherwise stay cached.
    // (No recorded refusal backs this path: on 2026-11-19 X answered even missing and made-up guest tokens with 200.)
    await res.body?.cancel().catch(() => undefined);
    guestTokens.delete(bearerToken(ctx));
    res = await ask();
    if (TOKEN_REFUSED.has(res.status)) guestTokens.delete(bearerToken(ctx));
  }
  if (res.status === 404) {
    // X answers an operation id it no longer knows with 404 "Query not found" (recorded 2026-11-19). That is a stale
    // X_GRAPHQL_QUERY_ID, not a missing post (a missing post is a 200 with an empty tweetResult).
    await res.body?.cancel().catch(() => undefined);
    throw new Vid2ContextError('upstream', 'X GraphQL does not know the TweetResultByRestId operation id; X has rotated it.', {
      status: 404,
      hint: "Set X_GRAPHQL_QUERY_ID to the current id from x.com's web client, or unset X_BEARER_TOKEN to skip this lane.",
    });
  }
  if (!res.ok) throw await errorFromResponse(res, 'X GraphQL');
  const body = (await res.json()) as { data?: { tweetResult?: { result?: GqlTweetResult } } };
  const result = body.data?.tweetResult?.result;
  if (!result) throw notFound(postId);
  if (result.__typename === 'TweetTombstone') {
    throw new Vid2ContextError(
      'unavailable',
      `X will not show post ${postId}: ${result.tombstone?.text?.text ?? 'unavailable'}`,
      {
        hint: 'Age-restricted and withheld posts need a logged-in account. On Node, yt-dlp with browser cookies can read them.',
      },
    );
  }
  // Only a Tweet (or a TweetWithVisibilityResults wrapping one) with its v1.1 body is a post. Anything else, such as
  // the TweetUnavailable X sends guests for age-restricted or protected posts, must not pass as an empty post.
  const tweet = result.__typename === 'TweetWithVisibilityResults' ? result.tweet : result;
  if (!tweet?.legacy || (tweet.__typename !== undefined && tweet.__typename !== 'Tweet')) {
    const why = result.reason ?? tweet?.__typename ?? result.__typename ?? 'no post in the answer';
    throw new Vid2ContextError('unavailable', `X will not show post ${postId} to a guest (${why}).`, {
      hint: 'Age-restricted and protected posts need a logged-in account. On Node, yt-dlp with browser cookies can read them.',
    });
  }
  return fromGraphQL(result);
}

// ---------------------------------------------------------------- lanes

async function load(postId: string, ctx: Ctx): Promise<XPost> {
  const lanes: [string, () => Promise<XPost>][] = [['syndication', () => fetchSyndication(postId, ctx)]];
  if (fxtwitterEnabled(ctx)) lanes.push(['FxTwitter', () => fetchFxTwitter(postId, ctx)]);
  if (graphqlEnabled(ctx)) lanes.push(['GraphQL', () => fetchGraphQL(postId, ctx)]);
  const errors: { lane: string; err: unknown }[] = [];
  for (const [name, run] of lanes) {
    try {
      return await run();
    } catch (err) {
      ctx.log.debug(`x ${name} failed`, { postId, error: String(err) });
      errors.push({ lane: name, err });
    }
  }
  // The first lane's error says more (a tombstone reason, a rate limit) unless it was a bare not-found; then the
  // first later lane that knows more wins. The GraphQL lane only overrides a not-found with a verdict on the post
  // itself (unavailable): its own failures (a stale operation id, a refused bearer token) are about configuration,
  // and must not hide that both keyless lanes agree the post does not exist.
  const [first] = errors.map((e) => e.err);
  if (first instanceof Vid2ContextError && first.code === 'not-found') {
    const telling = errors.find(
      ({ lane, err }) =>
        err instanceof Vid2ContextError && err.code !== 'not-found' && (lane !== 'GraphQL' || err.code === 'unavailable'),
    );
    if (telling) throw telling.err;
    const keyless = errors.filter(({ lane }) => lane !== 'GraphQL').at(-1)?.err;
    if (keyless instanceof Vid2ContextError) throw keyless;
  }
  throw first;
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

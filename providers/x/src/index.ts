/**
 * X (Twitter) source. Keyless: the post comes from X's public syndication
 * endpoint (FxTwitter as a fallback, then x.com's GraphQL with a guest token
 * when X_BEARER_TOKEN is set), the video's MP4 renditions are listed
 * in `metadata.extra.variants` as direct links (every quality X serves,
 * highest first), and audio for speech-to-text is the lowest-bitrate
 * audio-only HLS rendition (see audio.ts), else the smallest MP4, both
 * capped by VID2CONTEXT_MAX_MEDIA_MB. X posts carry no
 * captions, so the transcript always comes from speech-to-text.
 * Plain fetch, Node and Workers (X's endpoint refuses browser origins).
 */
import { type AudioInput, defineProvider, type SourceProvider, Vid2ContextError, type VideoMetadata } from '@vid2context/core';
import { resolveVideo } from './api.ts';
import { downloadAudio } from './audio.ts';
import { titleOf } from './post.ts';
import { matchX, parseRef, postUrl } from './url.ts';

export {
  bearerToken,
  clearGuestTokens,
  FXTWITTER,
  fetchFxTwitter,
  fetchGraphQL,
  fetchSyndication,
  fxtwitterEnabled,
  GRAPHQL_TWEET_QUERY_ID,
  getPost,
  graphqlEnabled,
  graphqlUrl,
  guestToken,
  pickMedia,
  type ResolvedVideo,
  resolveVideo,
  SYNDICATION,
  syndicationToken,
  syndicationUrl,
  X_API,
} from './api.ts';
export { audioRenditions, downloadAudio, downloadSegments, type HlsAudio, hlsAudio, mediaSegments } from './audio.ts';
export {
  decodeEntities,
  fromFxTwitter,
  fromGraphQL,
  fromSyndication,
  type GqlTweetResult,
  titleOf,
  variantOf,
  type XMedia,
  type XMediaType,
  type XPost,
  type XVariant,
} from './post.ts';
export { matchX, parseRef, postRef, postUrl, type XTarget } from './url.ts';

function targetOf(ref: Parameters<SourceProvider['getMetadata']>[0]) {
  const target = parseRef(ref);
  if (!target) throw new Vid2ContextError('bad-request', `Not an X ref: ${ref.id}`);
  return target;
}

export const xSource: SourceProvider = defineProvider({
  id: 'x',
  kind: 'source',
  name: 'X (Twitter)',
  runtimes: ['node', 'workers'],
  match: matchX,
  async getMetadata(ref, ctx): Promise<VideoMetadata> {
    const target = targetOf(ref);
    const { post, media, position, quotedBy } = await resolveVideo(target, ctx);
    const handle = post.author.handle;
    // Same id (the cache key). The URL is the linked post, with its author's handle and the media position.
    const linked = quotedBy ?? post;
    const linkedHandle = linked.author.handle;
    const linkedPosition = quotedBy ? 1 : position;
    return {
      ref: {
        ...ref,
        url: linkedHandle ? canonical(linkedHandle, target.postId, linkedPosition) : postUrl(target.postId, linkedPosition),
      },
      title: titleOf(post),
      ...(handle || post.author.name
        ? {
            channel: {
              name: post.author.name || `@${handle}`,
              ...(post.author.id ? { id: post.author.id } : {}),
              ...(handle ? { url: `https://x.com/${handle}` } : {}),
            },
          }
        : {}),
      ...(post.text ? { description: post.text } : {}),
      ...(media.durationSec ? { durationSec: media.durationSec } : {}),
      ...(post.createdAt ? { publishedAt: post.createdAt } : {}),
      ...(media.thumbnailUrl ? { thumbnailUrl: media.thumbnailUrl } : {}),
      ...(post.hashtags.length ? { tags: post.hashtags } : {}),
      chapters: [],
      extra: {
        postId: post.id,
        ...(handle ? { handle } : {}),
        mediaType: media.type,
        mediaPosition: position,
        mediaCount: post.media.length,
        ...(media.width && media.height ? { width: media.width, height: media.height } : {}),
        variants: media.variants,
        ...(media.hls ? { hls: media.hls } : {}),
        ...(post.lang ? { textLanguage: post.lang } : {}),
        ...(post.likes !== undefined ? { likes: post.likes } : {}),
        ...(post.replies !== undefined ? { replies: post.replies } : {}),
        ...(post.reposts !== undefined ? { reposts: post.reposts } : {}),
        ...(post.views !== undefined ? { views: post.views } : {}),
        ...(post.replyTo ? { replyTo: post.replyTo } : {}),
        ...(quotedBy
          ? {
              quotedBy: {
                postId: quotedBy.id,
                ...(quotedBy.author.handle ? { handle: quotedBy.author.handle } : {}),
                ...(quotedBy.text ? { text: quotedBy.text } : {}),
              },
              videoUrl: handle ? canonical(handle, post.id, position) : postUrl(post.id, position),
            }
          : {}),
        via: post.via,
      },
    };
  },
  canProvideAudio: (ref) => ref.platform === 'x' && ref.kind === 'video' && parseRef(ref) !== null,
  async getAudio(ref, ctx): Promise<AudioInput> {
    const { post, media } = await resolveVideo(targetOf(ref), ctx);
    if (media.type === 'gif') {
      throw new Vid2ContextError('unavailable', `X post ${post.id} holds a GIF, which has no sound to transcribe.`, {
        hint: 'GIFs on X are silent MP4 loops. Use --mode video with a multimodal rung to describe what is on screen.',
      });
    }
    return downloadAudio(media, ctx, ref.nativeId, `the audio of X post ${post.id}`);
  },
});

function canonical(handle: string, postId: string, position: number): string {
  return `https://x.com/${handle}/status/${postId}${position > 1 ? `/video/${position}` : ''}`;
}

export default xSource;

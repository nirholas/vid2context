/**
 * YouTube comments, keyless, through innertube `next`:
 *
 *   1. `next` for the video gives the comments section's continuation token
 *      (and the Top/Newest sort menu).
 *   2. Each continuation returns about 20 top-level threads and a token for
 *      the next page. Paging stops as soon as `limit` threads are in hand.
 *   3. Replies are fetched for a bounded set of threads: the ones the creator
 *      replied in first, then the most liked. A creator reply is always kept.
 *
 * Comments disabled, members-only or age-gated videos and videos with no
 * comments give `[]` and an info log. Only an unavailable video is an error.
 */
import { type Comment, type Ctx, type Env, Vid2ContextError, type VideoRef } from '@vid2context/core';
import { getPlayer, playabilityError } from '../innertube.ts';
import {
  findCommentSection,
  findSortTokens,
  type Json,
  type ParsedThread,
  parseCommentsPage,
  parseRepliesPage,
} from './parse.ts';
import { nextRequest } from './request.ts';

export type CommentSort = 'top' | 'newest';

export interface CommentOptions {
  /** Top-level comments to return. Default 50, max 500. */
  limit?: number;
  /** Default: YOUTUBE_COMMENTS_SORT, else 'top'. */
  sort?: CommentSort;
}

export const DEFAULT_LIMIT = 50;
export const MAX_LIMIT = 500;
export const DEFAULT_REPLIES = 5;
export const MAX_REPLIES = 100;
/** At most this many threads get their replies fetched (one request each, usually). */
export const MAX_REPLY_THREADS = 20;
/** Besides threads the creator replied in, the most liked threads with replies. */
export const MOST_LIKED_THREADS = 5;
/** Reply pages read per thread (10 replies each) while looking for a creator reply. */
export const MAX_REPLY_PAGES = 3;

export interface CommentSettings {
  limit: number;
  sort: CommentSort;
  /** Replies kept per thread; 0 turns reply fetching off. */
  replies: number;
}

function intSetting(name: string, raw: string | undefined, fallback: number, max: number): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) {
    throw new Vid2ContextError('bad-request', `${name} must be a whole number, got "${raw}".`, {
      hint: `Set ${name} to a number from 0 to ${max}, or remove it to use ${fallback}.`,
    });
  }
  return Math.min(n, max);
}

/** Resolve options and env into concrete settings. */
export function commentSettings(opts: CommentOptions, env: Env): CommentSettings {
  const rawLimit = opts.limit ?? DEFAULT_LIMIT;
  const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(Math.floor(rawLimit), 1), MAX_LIMIT) : DEFAULT_LIMIT;
  const sort = opts.sort ?? (env.YOUTUBE_COMMENTS_SORT?.trim().toLowerCase() || 'top');
  if (sort !== 'top' && sort !== 'newest') {
    throw new Vid2ContextError('bad-request', `Unknown YouTube comment sort "${sort}".`, {
      hint: 'Use YOUTUBE_COMMENTS_SORT=top or YOUTUBE_COMMENTS_SORT=newest.',
    });
  }
  const replies = intSetting('YOUTUBE_COMMENT_REPLIES', env.YOUTUBE_COMMENT_REPLIES, DEFAULT_REPLIES, MAX_REPLIES);
  return { limit, sort, replies };
}

/** Why a video's `next` response had no comments section. Throws when the video itself is unavailable. */
async function noSectionReason(videoId: string, ctx: Ctx): Promise<string> {
  const player = await getPlayer(videoId, ctx);
  const err = playabilityError(player, videoId);
  if (!err) return 'YouTube returned no comments section';
  const reason = player.playabilityStatus?.reason ?? '';
  if (err.code !== 'blocked' && /age|inappropriate|member/i.test(reason)) return reason;
  throw err;
}

async function fetchThreads(token: string, limit: number, videoId: string, ctx: Ctx): Promise<ParsedThread[]> {
  const threads: ParsedThread[] = [];
  const maxPages = Math.ceil(limit / 10) + 2;
  let next: string | undefined = token;
  for (let pages = 0; next && threads.length < limit && pages < maxPages; pages++) {
    ctx.signal?.throwIfAborted();
    let page: Json;
    try {
      page = await nextRequest({ continuation: next }, ctx);
    } catch (err) {
      if (pages === 0 || ctx.signal?.aborted) throw err;
      ctx.log.warn(`YouTube ${videoId}: comment paging stopped after ${threads.length} comments`, {
        error: err instanceof Error ? err.message : String(err),
      });
      break;
    }
    const parsed = parseCommentsPage(page);
    threads.push(...parsed.threads);
    next = parsed.next;
  }
  return threads.slice(0, limit);
}

/** Threads to expand: creator-replied first, then the most liked, bounded. */
export function pickReplyThreads(threads: ParsedThread[]): ParsedThread[] {
  const withReplies = threads.filter((t) => t.replyCount > 0 && t.replyToken);
  const creator = withReplies.filter((t) => t.creatorReplied);
  const liked = withReplies
    .filter((t) => !t.creatorReplied)
    .sort((a, b) => (b.comment.likes ?? 0) - (a.comment.likes ?? 0))
    .slice(0, MOST_LIKED_THREADS);
  return [...creator, ...liked].slice(0, MAX_REPLY_THREADS);
}

/** Keep at most `max` replies in their original order, creator replies first in priority. */
export function selectReplies(replies: Comment[], max: number): Comment[] {
  const keep = new Set(
    replies
      .filter((c) => c.isCreator)
      .slice(0, Math.max(max, 1))
      .map((c) => c.id),
  );
  for (const c of replies) {
    if (keep.size >= max) break;
    keep.add(c.id);
  }
  return replies.filter((c) => keep.has(c.id));
}

async function fetchReplies(thread: ParsedThread, max: number, ctx: Ctx): Promise<Comment[]> {
  const collected: Comment[] = [];
  let token = thread.replyToken;
  for (let pages = 0; token && pages < MAX_REPLY_PAGES; pages++) {
    ctx.signal?.throwIfAborted();
    const parsed = parseRepliesPage(await nextRequest({ continuation: token }, ctx));
    collected.push(...parsed.replies);
    const missingCreator = thread.creatorReplied && !collected.some((c) => c.isCreator);
    if (collected.length >= max && !missingCreator) break;
    token = parsed.next;
  }
  return selectReplies(collected, max);
}

async function attachReplies(threads: ParsedThread[], max: number, videoId: string, ctx: Ctx): Promise<void> {
  for (const thread of pickReplyThreads(threads)) {
    try {
      const replies = await fetchReplies(thread, max, ctx);
      if (replies.length > 0) thread.comment.replies = replies;
    } catch (err) {
      if (ctx.signal?.aborted) throw err;
      ctx.log.warn(`YouTube ${videoId}: stopped fetching replies`, { error: err instanceof Error ? err.message : String(err) });
      return;
    }
  }
}

/** Top comments of a YouTube video, mapped to the core Comment type. */
export async function getYouTubeComments(ref: VideoRef, ctx: Ctx, opts: CommentOptions = {}): Promise<Comment[]> {
  if (ref.platform !== 'youtube' || ref.kind !== 'video') {
    throw new Vid2ContextError('unsupported-input', `Comments need a YouTube video, got ${ref.id}.`, {
      hint: 'Pass the URL of a single YouTube video; playlists and channels have no comments of their own.',
    });
  }
  const { limit, sort, replies } = commentSettings(opts, ctx.env);
  const videoId = ref.nativeId;
  const next = await nextRequest({ videoId }, ctx);
  const section = findCommentSection(next);
  if (!section.token) {
    const reason = section.found ? section.message : await noSectionReason(videoId, ctx);
    ctx.log.info(`YouTube ${videoId}: no comments (${reason})`);
    return [];
  }

  let token = section.token;
  if (sort === 'newest') {
    const newest = findSortTokens(next).newest;
    if (newest) token = newest;
    else ctx.log.warn(`YouTube ${videoId}: no comment sort menu found, returning Top comments`);
  }

  const threads = await fetchThreads(token, limit, videoId, ctx);
  if (threads.length === 0) {
    ctx.log.info(`YouTube ${videoId}: no comments (the video has none yet)`);
    return [];
  }
  if (replies > 0) await attachReplies(threads, replies, videoId, ctx);
  const comments = threads.map((t) => t.comment);
  return [...comments.filter((c) => c.isPinned), ...comments.filter((c) => !c.isPinned)];
}

export { findCommentSection, findSortTokens, parseCommentsPage, parseCount, parseRepliesPage, relativeToIso } from './parse.ts';

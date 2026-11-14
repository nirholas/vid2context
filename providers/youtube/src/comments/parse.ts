/**
 * Parsers for the comments parts of innertube `next` responses. Pure
 * functions over raw JSON, so they are tested directly on recorded responses.
 *
 * YouTube sends comments in two shapes, both seen live on 2026-11-14:
 *   entity    (WEB)   a thread holds a `commentViewModel` with keys; the data
 *                     (text, author, counts) sits in `frameworkUpdates`
 *                     entity mutations (`commentEntityPayload`).
 *   renderer  (MWEB)  a thread holds a classic `commentRenderer` with all the
 *                     data inline.
 * Every function here accepts either shape.
 */
import type { Comment } from '@vid2context/core';

/** Raw innertube JSON. Parsers walk it defensively. */
export type Json = Record<string, unknown>;

const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
const obj = (v: unknown): Json => (isObj(v) ? v : {});
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

/** Every value stored under `key`, depth first. */
export function findAll(o: unknown, key: string, out: unknown[] = []): unknown[] {
  if (Array.isArray(o)) {
    for (const v of o) findAll(v, key, out);
  } else if (isObj(o)) {
    for (const [k, v] of Object.entries(o)) {
      if (k === key) out.push(v);
      findAll(v, key, out);
    }
  }
  return out;
}

/** The first continuation token anywhere inside `o`. */
export function tokenIn(o: unknown): string | undefined {
  for (const cmd of findAll(o, 'continuationCommand')) {
    const token = str(obj(cmd).token);
    if (token) return token;
  }
  return undefined;
}

/** Plain text of a YouTube text object: `{ simpleText }` or `{ runs: [{ text }] }`. */
export function textOf(v: unknown): string {
  const o = obj(v);
  if (typeof o.simpleText === 'string') return o.simpleText;
  return arr(o.runs)
    .map((r) => str(obj(r).text) ?? '')
    .join('');
}

/**
 * Parse a displayed count ("987", "1.2K", "3M", "1,234") to a number. The
 * WEB client shows a single space for zero likes, which parses to 0.
 * Returns undefined for text that is not a count.
 */
export function parseCount(text: string | undefined): number | undefined {
  if (text === undefined) return undefined;
  const t = text.replace(/[,\s]/g, '');
  if (t === '') return 0;
  const m = /^(\d+(?:\.\d+)?)([KMB])?$/i.exec(t);
  if (!m) return undefined;
  const mult = { K: 1e3, M: 1e6, B: 1e9 }[(m[2] ?? '').toUpperCase() as 'K' | 'M' | 'B'] ?? 1;
  return Math.round(Number(m[1]) * mult);
}

const UNIT_SEC: Record<string, number> = {
  second: 1,
  minute: 60,
  hour: 3600,
  day: 86400,
  week: 7 * 86400,
  month: 30 * 86400,
  year: 365 * 86400,
};

/**
 * Turn YouTube's relative time ("2 years ago", "3 weeks ago (edited)") into an
 * approximate ISO 8601 value. Units of a day or longer give a date only
 * (YYYY-MM-DD), so the result never claims more precision than the source.
 */
export function relativeToIso(text: string | undefined, now: number = Date.now()): string | undefined {
  const m = /(\d+)\s*(second|minute|hour|day|week|month|year)s?\s+ago/i.exec(text ?? '');
  const sec = UNIT_SEC[(m?.[2] ?? '').toLowerCase()];
  if (!m || !sec) return undefined;
  const iso = new Date(now - Number(m[1]) * sec * 1000).toISOString();
  return sec >= 86400 ? iso.slice(0, 10) : iso;
}

/** The real destination of a comment link (YouTube wraps external links in /redirect?q=). */
function linkTarget(url: string): string | undefined {
  try {
    const u = new URL(url, 'https://www.youtube.com');
    return u.pathname === '/redirect' ? (u.searchParams.get('q') ?? undefined) : u.href;
  } catch {
    return undefined;
  }
}

/** Replace a shortened URL label with the full URL. Link labels that are not URLs are left alone. */
function expandLink(display: string, url: string | undefined): string {
  const target = url ? linkTarget(url) : undefined;
  if (!target || !/^https?:\/\//i.test(target) || display === target || /\s/.test(display.trim())) return display;
  const bare = (s: string) => s.replace(/^https?:\/\//i, '').replace(/(\.\.\.|\u2026)$/, '');
  return bare(target).startsWith(bare(display)) ? target : display;
}

const clean = (t: string) => t.replace(/\u200b/g, '').trim();

/** Entity text: `content` plus `commandRuns` (UTF-16 offsets, which JS strings use too). */
function entityText(content: Json): string {
  let text = str(content.content) ?? '';
  const links = arr(content.commandRuns)
    .map(obj)
    .map((r) => ({
      start: Number(r.startIndex ?? 0),
      length: Number(r.length ?? 0),
      url: str(obj(obj(obj(r.onTap).innertubeCommand).urlEndpoint).url),
    }))
    .filter((r) => r.url)
    .sort((a, b) => b.start - a.start);
  for (const { start, length, url } of links) {
    const display = text.slice(start, start + length);
    const full = expandLink(display, url);
    if (full !== display) text = text.slice(0, start) + full + text.slice(start + length);
  }
  return clean(text);
}

/** Renderer text: runs joined, with link runs expanded. Emoji runs carry the character as text. */
function rendererText(v: unknown): string {
  const runs = arr(obj(v).runs).map(obj);
  if (runs.length === 0) return clean(textOf(v));
  return clean(runs.map((r) => expandLink(str(r.text) ?? '', str(obj(obj(r.navigationEndpoint).urlEndpoint).url))).join(''));
}

interface Mapped {
  comment: Comment;
  replyCount: number;
}

function build(c: {
  id: string;
  author: string;
  text: string;
  likes?: number;
  published?: string;
  isCreator: boolean;
  isPinned: boolean;
  now: number;
}): Comment {
  const out: Comment = { id: c.id, author: c.author, text: c.text };
  if (c.likes !== undefined) out.likes = c.likes;
  const publishedAt = relativeToIso(c.published, c.now);
  if (publishedAt) out.publishedAt = publishedAt;
  if (c.isCreator) out.isCreator = true;
  if (c.isPinned) out.isPinned = true;
  return out;
}

/** Map entity mutations by key. */
export function entityMap(page: Json): Map<string, Json> {
  const map = new Map<string, Json>();
  for (const m of arr(obj(obj(page.frameworkUpdates).entityBatchUpdate).mutations)) {
    const key = str(obj(m).entityKey);
    if (key) map.set(key, obj(obj(m).payload));
  }
  return map;
}

function fromViewModel(vm: Json, ents: Map<string, Json>, pinned: boolean, now: number): Mapped | null {
  const payload = obj(ents.get(str(vm.commentKey) ?? '')?.commentEntityPayload);
  const props = obj(payload.properties);
  const author = obj(payload.author);
  const toolbar = obj(payload.toolbar);
  const id = str(props.commentId) ?? str(vm.commentId);
  if (!id || !isObj(payload.properties)) return null;
  return {
    comment: build({
      id,
      author: str(author.displayName) ?? '',
      text: entityText(obj(props.content)),
      likes: parseCount(str(toolbar.likeCountNotliked)),
      published: str(props.publishedTime),
      isCreator: author.isCreator === true,
      isPinned: pinned || typeof vm.pinnedText === 'string',
      now,
    }),
    replyCount: parseCount(str(toolbar.replyCount)) ?? 0,
  };
}

function fromRenderer(r: Json, now: number): Mapped | null {
  const id = str(r.commentId);
  if (!id) return null;
  return {
    comment: build({
      id,
      author: textOf(r.authorText),
      text: rendererText(r.contentText),
      likes: parseCount(isObj(r.voteCount) ? textOf(r.voteCount) : ''),
      published: textOf(r.publishedTimeText),
      isCreator: r.authorIsChannelOwner === true,
      isPinned: isObj(r.pinnedCommentBadge),
      now,
    }),
    replyCount: typeof r.replyCount === 'number' ? r.replyCount : 0,
  };
}

/** A `commentViewModel` is nested twice inside threads and once on reply pages. */
function viewModelOf(v: unknown): Json | undefined {
  const vm = obj(v);
  const inner = isObj(vm.commentViewModel) ? vm.commentViewModel : vm;
  return typeof inner.commentKey === 'string' ? inner : undefined;
}

/** All `continuationItems` of a continuation response, in order. */
function continuationItems(page: Json): Json[] {
  const out: Json[] = [];
  for (const e of arr(page.onResponseReceivedEndpoints)) {
    for (const v of Object.values(obj(e))) {
      if (isObj(v) && Array.isArray(v.continuationItems)) out.push(...v.continuationItems.map(obj));
    }
  }
  return out;
}

/** Token of the trailing "load more" item, if the page has one. */
function nextToken(items: Json[]): string | undefined {
  const last = items.at(-1);
  return last && isObj(last.continuationItemRenderer) ? tokenIn(last.continuationItemRenderer) : undefined;
}

export interface ParsedThread {
  /** The top-level comment, without replies. */
  comment: Comment;
  replyCount: number;
  /** Continuation token for the first page of replies. */
  replyToken?: string;
  /** YouTube marks threads the creator replied in (entity shape only). */
  creatorReplied: boolean;
}

export interface ParsedPage {
  threads: ParsedThread[];
  next?: string;
}

/** One page of top-level comment threads. */
export function parseCommentsPage(page: Json, now: number = Date.now()): ParsedPage {
  const ents = entityMap(page);
  const items = continuationItems(page);
  const threads: ParsedThread[] = [];
  for (const item of items) {
    if (!isObj(item.commentThreadRenderer)) continue;
    const th = item.commentThreadRenderer;
    const pinned = th.renderingPriority === 'RENDERING_PRIORITY_PINNED_COMMENT';
    const vm = viewModelOf(th.commentViewModel);
    const mapped = vm ? fromViewModel(vm, ents, pinned, now) : fromRenderer(obj(obj(th.comment).commentRenderer), now);
    if (!mapped) continue;
    const replies = obj(obj(th.replies).commentRepliesRenderer);
    threads.push({
      comment: mapped.comment,
      replyCount: mapped.replyCount,
      replyToken: tokenIn(replies),
      creatorReplied: 'viewRepliesCreatorThumbnail' in replies,
    });
  }
  return { threads, next: nextToken(items) };
}

export interface ParsedReplies {
  replies: Comment[];
  next?: string;
}

/** One page of replies to a thread. */
export function parseRepliesPage(page: Json, now: number = Date.now()): ParsedReplies {
  const ents = entityMap(page);
  const items = continuationItems(page);
  const replies: Comment[] = [];
  for (const item of items) {
    const vm = viewModelOf(item.commentViewModel);
    const mapped = vm
      ? fromViewModel(vm, ents, false, now)
      : isObj(item.commentRenderer)
        ? fromRenderer(item.commentRenderer, now)
        : null;
    if (mapped) replies.push(mapped.comment);
  }
  return { replies, next: nextToken(items) };
}

export interface CommentSection {
  /** False when the response has no comments section at all. */
  found: boolean;
  /** Continuation token for the first page of comments. */
  token?: string;
  /** The message YouTube shows instead of comments ("Comments are turned off."). */
  message?: string;
}

/** Locate the comments section of a `next` response for a video. */
export function findCommentSection(next: Json): CommentSection {
  const sections = findAll(next, 'itemSectionRenderer')
    .map(obj)
    .filter((s) => s.sectionIdentifier === 'comment-item-section');
  // The watch page loads the section with targetId "comments-section"; do the same.
  const section = sections.find((s) => s.targetId === 'comments-section') ?? sections[0];
  if (!section) return { found: false };
  const token = tokenIn(section.contents);
  if (token) return { found: true, token };
  // The message ends with a "Learn more" link run; keep only the plain runs.
  const message = findAll(section, 'messageRenderer')
    .map((m) =>
      arr(obj(obj(m).text).runs)
        .map(obj)
        .filter((r) => !r.navigationEndpoint)
        .map((r) => str(r.text) ?? '')
        .join('')
        .trim(),
    )
    .find(Boolean);
  return { found: true, message: message || 'the comments section has no comments to load' };
}

/**
 * Tokens of the comments sort menu (Top, Newest). The menu sits in the
 * comments engagement panel of the `next` response, or in the header of the
 * first comments page. Other panels (live chat) have their own sort menus, so
 * only those two places are searched.
 */
export function findSortTokens(o: Json): { top?: string; newest?: string } {
  const scopes = [
    ...findAll(o, 'engagementPanelSectionListRenderer').filter((p) => obj(p).targetId === 'engagement-panel-comments-section'),
    ...findAll(o, 'commentsHeaderRenderer'),
  ];
  for (const scope of scopes) {
    for (const menu of findAll(scope, 'sortFilterSubMenuRenderer')) {
      const items = arr(obj(menu).subMenuItems).map(obj);
      if (items.length < 2) continue;
      const titled = (re: RegExp) => items.find((i) => re.test(str(i.title) ?? ''));
      return {
        top: tokenIn((titled(/^top/i) ?? items[0])?.serviceEndpoint),
        newest: tokenIn((titled(/^newest/i) ?? items[1])?.serviceEndpoint),
      };
    }
  }
  return {};
}

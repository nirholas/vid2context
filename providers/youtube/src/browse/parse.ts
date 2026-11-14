/**
 * Parse innertube browse and search pages into list items. Written for this
 * repo against responses recorded in test/fixtures (no code copied). YouTube
 * ships several renderer generations side by side, so the parser walks the
 * tree and recognises each item renderer by name instead of following one
 * fixed path.
 */
import type { Json } from './request.ts';

export type ListItem = { type: 'video'; id: string; available: boolean } | { type: 'playlist'; id: string };

export interface ListPage {
  items: ListItem[];
  /** Token for the next page of the same list, when there is one. */
  next?: string;
  /** Text of every alert on the page, with its type (ERROR, INFO, WARNING). */
  alerts: { type: string; text: string }[];
}

export interface ParseOptions {
  /** Initial page (walk `contents`) or continuation page (walk the append actions). */
  continuation: boolean;
  /**
   * Search pages put the next-page token beside the item section rather than
   * beside the items. Browse pages put a token for unrelated content (related
   * playlists) at that level, so it is only followed for search.
   */
  sectionLevelNext?: boolean;
  /** Skip shelves (search: "People also watched", shorts shelves). */
  skipShelves?: boolean;
}

const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
const UNAVAILABLE_TITLES = /^\[(private|deleted) video\]$/i;
const SHELVES = new Set([
  'shelfRenderer',
  'reelShelfRenderer',
  'horizontalCardListRenderer',
  'gridShelfViewModel',
  'adSlotRenderer',
  'searchPyvRenderer',
  'promotedSparklesWebRenderer',
]);
const VIDEO_RENDERERS = new Set([
  'videoRenderer',
  'gridVideoRenderer',
  'compactVideoRenderer',
  'playlistVideoRenderer',
  'playlistPanelVideoRenderer',
  'videoWithContextRenderer',
  'reelItemRenderer',
]);
const PLAYLIST_LOCKUPS = new Set([
  'LOCKUP_CONTENT_TYPE_PLAYLIST',
  'LOCKUP_CONTENT_TYPE_ALBUM',
  'LOCKUP_CONTENT_TYPE_PODCAST',
]);
const CONTINUATIONS = new Set(['continuationItemRenderer', 'continuationItemViewModel']);

function obj(v: unknown): Json | undefined {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : undefined;
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

/** Plain text of a YouTube text object: simpleText, runs, or the view-model `content`. */
export function textOf(v: unknown): string | undefined {
  if (typeof v === 'string') return v;
  const o = obj(v);
  if (!o) return undefined;
  if (typeof o.simpleText === 'string') return o.simpleText;
  if (typeof o.content === 'string') return o.content;
  if (Array.isArray(o.runs)) return o.runs.map((r) => str(obj(r)?.text) ?? '').join('');
  return undefined;
}

/** First string found under `key` anywhere inside `v` (depth-first). */
export function findString(v: unknown, key: string): string | undefined {
  if (Array.isArray(v)) {
    for (const x of v) {
      const s = findString(x, key);
      if (s) return s;
    }
    return undefined;
  }
  const o = obj(v);
  if (!o) return undefined;
  const direct = str(o[key]);
  if (direct) return direct;
  for (const x of Object.values(o)) {
    const s = findString(x, key);
    if (s) return s;
  }
  return undefined;
}

function continuationToken(renderer: Json): string | undefined {
  const cmd = obj(renderer.continuationCommand) ?? obj(renderer.continuationEndpoint) ?? renderer;
  return findString(cmd, 'token');
}

/** One array element as a list item, unwrapping richItemRenderer. */
function itemOf(el: Json): ListItem | null {
  const wrapped = obj(obj(el.richItemRenderer)?.content);
  const node = wrapped ?? el;
  for (const [key, value] of Object.entries(node)) {
    const r = obj(value);
    if (!r) continue;
    if (VIDEO_RENDERERS.has(key)) {
      const id = str(r.videoId);
      if (!id || !VIDEO_ID.test(id)) return null;
      const title = textOf(r.title) ?? textOf(r.headline);
      const unavailable = r.isPlayable === false || (title !== undefined && UNAVAILABLE_TITLES.test(title.trim()));
      return { type: 'video', id, available: !unavailable };
    }
    if (key === 'lockupViewModel') {
      const id = str(r.contentId);
      const type = str(r.contentType);
      if (!id) return null;
      if (type === 'LOCKUP_CONTENT_TYPE_VIDEO' && VIDEO_ID.test(id)) {
        // Unavailable videos come back as lockups without a title.
        const title = textOf(obj(obj(r.metadata)?.lockupMetadataViewModel)?.title)?.trim();
        return { type: 'video', id, available: Boolean(title) && !UNAVAILABLE_TITLES.test(title ?? '') };
      }
      if (type && PLAYLIST_LOCKUPS.has(type)) return { type: 'playlist', id };
      return null;
    }
    if (key === 'shortsLockupViewModel') {
      const id = findString(obj(r.onTap), 'videoId') ?? str(r.entityId)?.replace(/^shorts-shelf-item-/, '');
      return id && VIDEO_ID.test(id) ? { type: 'video', id, available: true } : null;
    }
    if (key === 'gridPlaylistRenderer' || key === 'playlistRenderer') {
      const id = str(r.playlistId);
      return id ? { type: 'playlist', id } : null;
    }
  }
  return null;
}

interface Walk {
  items: ListItem[];
  itemNext?: string;
  sectionNext?: string;
  skipShelves: boolean;
}

function walk(v: unknown, w: Walk): void {
  if (Array.isArray(v)) {
    let hasItems = false;
    const tokens: string[] = [];
    for (const el of v) {
      const o = obj(el);
      if (!o) continue;
      const item = itemOf(o);
      if (item) {
        w.items.push(item);
        hasItems = true;
        continue;
      }
      const cont = Object.entries(o).find(([k]) => CONTINUATIONS.has(k));
      if (cont) {
        const token = continuationToken(obj(cont[1]) ?? {});
        if (token) tokens.push(token);
        continue;
      }
      walk(o, w);
    }
    const token = tokens[0];
    if (token && hasItems) w.itemNext ??= token;
    else if (token) w.sectionNext ??= token;
    return;
  }
  const o = obj(v);
  if (!o) return;
  for (const [key, value] of Object.entries(o)) {
    if (w.skipShelves && SHELVES.has(key)) continue;
    walk(value, w);
  }
}

function alertsOf(json: Json): ListPage['alerts'] {
  const out: ListPage['alerts'] = [];
  const list = Array.isArray(json.alerts) ? json.alerts : [];
  for (const a of list) {
    for (const value of Object.values(obj(a) ?? {})) {
      const r = obj(value);
      const text = textOf(r?.text);
      if (r && text) out.push({ type: str(r.type) ?? 'INFO', text });
    }
  }
  return out;
}

export function parsePage(json: Json, opts: ParseOptions): ListPage {
  const w: Walk = { items: [], skipShelves: opts.skipShelves ?? false };
  if (opts.continuation) {
    for (const key of ['onResponseReceivedActions', 'onResponseReceivedEndpoints', 'onResponseReceivedCommands']) {
      walk(json[key], w);
    }
  } else {
    walk(json.contents, w);
  }
  const next = w.itemNext ?? (opts.sectionLevelNext ? w.sectionNext : undefined);
  return { items: w.items, ...(next ? { next } : {}), alerts: alertsOf(json) };
}

/** Count from an alert such as "3 unavailable videos are hidden". */
export function hiddenCount(alerts: ListPage['alerts']): number {
  let n = 0;
  for (const a of alerts) {
    const m = /(\d[\d,]*) unavailable videos? (?:is|are) hidden/i.exec(a.text);
    if (m?.[1]) n += Number(m[1].replace(/,/g, ''));
  }
  return n;
}

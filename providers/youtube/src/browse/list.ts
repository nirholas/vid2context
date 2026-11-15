/**
 * Expand playlist, channel and search refs into video refs through innertube
 * browse and search, following continuation tokens page by page. Paging is
 * lazy: a page is only requested when the consumer asks for more items, so a
 * limit stops the requests as soon as it is reached.
 */
import { type Ctx, Vid2ContextError, type VideoRef } from '@vid2context/core';
import { type ChannelTab, channelTabOf, parseSearchRef, playlistRef, SEARCH_DEFAULT, SEARCH_MAX, videoRef } from '../url.ts';
import { hiddenCount, type ListItem, type ListPage, type ParseOptions, parsePage } from './parse.ts';
import { type Endpoint, innertubeWeb, type Json } from './request.ts';

/** Browse params that make a playlist include its unavailable entries, so they can be counted and skipped. */
export const SHOW_UNAVAILABLE = 'wgYCCAA%3D';
/** Search filter: type = video. */
export const SEARCH_VIDEOS = 'EgIQAQ%3D%3D';

/**
 * Per-tab upload playlists derived from the channel id (UC... becomes
 * UU..., UULF..., UUSH..., UULV...). One playlist request replaces a tab
 * request plus resolution, and gives a stable newest-first order.
 */
const UPLOAD_PREFIX: Partial<Record<ChannelTab | 'all', string>> = {
  all: 'UU',
  videos: 'UULF',
  shorts: 'UUSH',
  streams: 'UULV',
};

const NOT_FOUND_ALERT = /does not exist|not exist|private|been removed|terminated/i;
const REGION_ALERT = /country|region|not available in your/i;

interface PageSpec {
  endpoint: Endpoint;
  body: Json;
  parse: Omit<ParseOptions, 'continuation'>;
  /** What to call the thing in not-found errors: "playlist PL...". */
  what: string;
}

function alertError(page: ListPage, spec: PageSpec): Vid2ContextError | null {
  const err = page.alerts.find((a) => a.type === 'ERROR');
  if (!err) return null;
  const msg = `YouTube ${spec.what}: ${err.text}`;
  if (REGION_ALERT.test(err.text)) {
    return new Vid2ContextError('unavailable', msg, {
      hint: 'This list is blocked in the region YouTube sees for this machine.',
    });
  }
  if (NOT_FOUND_ALERT.test(err.text)) {
    return new Vid2ContextError('not-found', msg, {
      hint: 'Check the URL. Private, deleted and mistyped playlists or channels cannot be listed.',
    });
  }
  return new Vid2ContextError('unavailable', msg, {
    hint: 'YouTube refused to show this list; open it in a browser to see why.',
  });
}

/** Fetch the first page and fail on error alerts. Kept separate so callers can fall back before yielding. */
async function firstPage(spec: PageSpec, ctx: Ctx): Promise<ListPage> {
  const json = await innertubeWeb(spec.endpoint, spec.body, ctx);
  const page = parsePage(json, { ...spec.parse, continuation: false });
  const err = alertError(page, spec);
  if (err) throw err;
  return page;
}

/** Yield the first page's items, then every continuation page's, until the list ends. */
async function* pagesFrom(first: ListPage, spec: PageSpec, ctx: Ctx, counts: Counts): AsyncGenerator<ListItem> {
  counts.hidden += hiddenCount(first.alerts);
  yield* first.items;
  const seenTokens = new Set<string>();
  let next = first.next;
  while (next && !seenTokens.has(next)) {
    ctx.signal?.throwIfAborted();
    seenTokens.add(next);
    const json = await innertubeWeb(spec.endpoint, { continuation: next }, ctx);
    const page = parsePage(json, { ...spec.parse, continuation: true });
    yield* page.items;
    next = page.next;
  }
}

async function* pages(spec: PageSpec, ctx: Ctx, counts: Counts): AsyncGenerator<ListItem> {
  yield* pagesFrom(await firstPage(spec, ctx), spec, ctx, counts);
}

interface Counts {
  /** Unavailable entries seen as items. */
  skipped: number;
  /** Unavailable entries YouTube hid and only counted in an alert. */
  hidden: number;
}

function playlistSpec(list: string): PageSpec {
  return {
    endpoint: 'browse',
    body: { browseId: `VL${list}`, params: SHOW_UNAVAILABLE },
    parse: {},
    what: `playlist ${list}`,
  };
}

/** Resolve a channel URL (with its tab) to a browse id and the tab's params. */
async function resolveChannel(url: string, ctx: Ctx): Promise<{ browseId: string; params?: string }> {
  let json: Json;
  try {
    json = await innertubeWeb('navigation/resolve_url', { url }, ctx);
  } catch (err) {
    if (err instanceof Vid2ContextError && err.code === 'not-found') {
      throw new Vid2ContextError('not-found', `YouTube channel ${url} does not exist.`, {
        status: 404,
        hint: 'Check the handle or channel name; open the URL in a browser to confirm it exists.',
      });
    }
    throw err;
  }
  const endpoint = (json.endpoint ?? {}) as { browseEndpoint?: { browseId?: string; params?: string } };
  const browseId = endpoint.browseEndpoint?.browseId;
  if (!browseId?.startsWith('UC')) {
    throw new Vid2ContextError('not-found', `YouTube did not resolve ${url} to a channel.`, {
      hint: 'Check the handle or channel name; open the URL in a browser to confirm it exists.',
    });
  }
  return { browseId, ...(endpoint.browseEndpoint?.params ? { params: endpoint.browseEndpoint.params } : {}) };
}

function channelUrl(id: string, tab: ChannelTab): string {
  return `https://www.youtube.com/channel/${id}/${tab}`;
}

async function* channelItems(ref: VideoRef, ctx: Ctx, counts: Counts): AsyncGenerator<ListItem> {
  const tab = channelTabOf(ref);
  const browseTab: ChannelTab = tab ?? 'videos';
  let channelId = /^UC[A-Za-z0-9_-]{22}$/.test(ref.nativeId) ? ref.nativeId : undefined;
  let resolved: { browseId: string; params?: string } | undefined;
  if (!channelId) {
    const base = ref.url?.replace(/\/(videos|shorts|streams|playlists|featured)$/, '') ?? '';
    resolved = await resolveChannel(`${base}/${browseTab}`, ctx);
    channelId = resolved.browseId;
  }

  const prefix = UPLOAD_PREFIX[tab ?? 'all'];
  if (prefix) {
    const list = `${prefix}${channelId.slice(2)}`;
    const spec = playlistSpec(list);
    let first: ListPage | undefined;
    try {
      first = await firstPage(spec, ctx);
    } catch (err) {
      if (!(err instanceof Vid2ContextError && err.code === 'not-found')) throw err;
      ctx.log.debug('youtube: upload playlist missing, listing the channel tab instead', { list, tab: browseTab });
    }
    if (first) {
      yield* pagesFrom(first, spec, ctx, counts);
      return;
    }
  }

  resolved ??= await resolveChannel(channelUrl(channelId, browseTab), ctx);
  const tabSpec: PageSpec = {
    endpoint: 'browse',
    body: { browseId: channelId, ...(resolved.params ? { params: resolved.params } : {}) },
    parse: {},
    what: `channel ${ref.nativeId}`,
  };
  const first = await firstPage(tabSpec, ctx);
  if (first.selectedTab && first.selectedTab !== browseTab) {
    ctx.log.info('youtube: this channel has no such tab, nothing to list', { channel: ref.nativeId, tab: browseTab });
    return;
  }
  for await (const item of pagesFrom(first, tabSpec, ctx, counts)) {
    if (browseTab === 'playlists') {
      if (item.type !== 'playlist') continue;
      try {
        yield* pages(playlistSpec(item.id), ctx, counts);
      } catch (err) {
        if (!(err instanceof Vid2ContextError && (err.code === 'not-found' || err.code === 'unavailable'))) throw err;
        ctx.log.warn('youtube: skipping a playlist on the channel playlists tab', { list: item.id, reason: err.message });
      }
    } else {
      yield item;
    }
  }
}

function searchItems(query: string, ctx: Ctx, counts: Counts): AsyncGenerator<ListItem> {
  return pages(
    {
      endpoint: 'search',
      body: { query, params: SEARCH_VIDEOS },
      parse: { sectionLevelNext: true, skipShelves: true },
      what: `search "${query}"`,
    },
    ctx,
    counts,
  );
}

/** `listItems` for the YouTube source: playlists, channels (with tabs) and ytsearch inputs. */
export async function* listYouTube(ref: VideoRef, ctx: Ctx, opts: { limit?: number } = {}): AsyncGenerator<VideoRef> {
  let limit = opts.limit && opts.limit > 0 ? opts.limit : Number.POSITIVE_INFINITY;
  let source: AsyncGenerator<ListItem>;
  const counts: Counts = { skipped: 0, hidden: 0 };
  const search = parseSearchRef(ref);
  if (ref.kind === 'video') {
    yield ref;
    return;
  }
  if (search) {
    limit = Math.min(limit, search.count ?? SEARCH_DEFAULT, SEARCH_MAX);
    source = searchItems(search.query, ctx, counts);
  } else if (ref.kind === 'playlist') {
    playlistRef(ref.input, ref.nativeId); // throws for mixes
    source = pages(playlistSpec(ref.nativeId), ctx, counts);
  } else if (ref.kind === 'channel') {
    source = channelItems(ref, ctx, counts);
  } else {
    throw new Vid2ContextError('unsupported-input', `YouTube cannot list a ${ref.kind} ref.`, {
      hint: 'Pass a playlist, channel or ytsearch: input.',
    });
  }

  const seen = new Set<string>();
  let emitted = 0;
  let duplicates = 0;
  try {
    for await (const item of source) {
      if (item.type !== 'video') continue;
      if (!item.available) {
        counts.skipped += 1;
        continue;
      }
      if (seen.has(item.id)) {
        duplicates += 1;
        continue;
      }
      seen.add(item.id);
      yield {
        ...videoRef(ref.input, item.id),
        ...(item.title ? { title: item.title } : {}),
        ...(item.durationSec !== undefined ? { durationSec: item.durationSec } : {}),
      };
      emitted += 1;
      if (emitted >= limit) return;
    }
  } finally {
    await source.return(undefined);
    const unavailable = counts.skipped + counts.hidden;
    if (unavailable > 0 || duplicates > 0) {
      ctx.log.info('youtube: skipped list entries', { list: ref.id, unavailable, duplicates, listed: emitted });
    }
  }
}

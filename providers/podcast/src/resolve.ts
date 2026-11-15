/**
 * Turn any podcast ref into a feed URL (lists) or a feed item (episodes).
 * Results are kept in a small in-memory cache, so metadata, captions and
 * audio for one episode read the feed once per run.
 */
import { type Ctx, Vid2ContextError, type VideoRef } from '@vid2context/core';
import { appleFeedUrl, appleLookup, appleSlug } from './apple.ts';
import { type FeedChannel, type FeedItem, itemKey, streamFeed } from './feed.ts';
import { episodeLocator, episodeUrl, nativeSource, parseAppleUrl } from './refs.ts';
import { normTitle, resolveSpotify } from './spotify.ts';

export interface ResolvedEpisode {
  feedUrl: string;
  channel: FeedChannel;
  item: FeedItem;
  key: string;
  /** The re-resolvable episode URL (feed URL + #item=). */
  url: string;
  via: 'feed' | 'apple' | 'spotify';
  extra?: Record<string, unknown>;
}

const TTL_MS = 10 * 60_000;
const MAX_ENTRIES = 100;
const cache = new Map<string, { at: number; value: Promise<unknown> }>();

function cached<T>(key: string, make: () => Promise<T>): Promise<T> {
  const now = Date.now();
  const hit = cache.get(key);
  if (hit && now - hit.at < TTL_MS) return hit.value as Promise<T>;
  const value = make();
  cache.set(key, { at: now, value });
  value.catch(() => cache.delete(key));
  while (cache.size > MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
  return value;
}

/** Forget cached resolutions (tests use it between cases). */
export function clearResolveCache(): void {
  cache.clear();
}

/** The first item the predicate accepts, with the channel, or null. Stops reading the feed once found. */
export async function findItem(
  feedUrl: string,
  accept: (item: FeedItem) => boolean,
  ctx: Ctx,
): Promise<{ channel: FeedChannel; item: FeedItem } | null> {
  let channel: FeedChannel | undefined;
  for await (const ev of streamFeed(feedUrl, ctx)) {
    if (ev.type === 'channel') channel = ev.channel;
    else if (channel && accept(ev.item)) return { channel, item: ev.item };
  }
  return null;
}

function gone(what: string): Vid2ContextError {
  return new Vid2ContextError('not-found', `${what} is not in the podcast feed any more.`, {
    hint: 'Feeds drop old episodes. Pass the episode audio URL instead, or list the feed to pick a current episode.',
  });
}

async function fromFeed(feedUrl: string, key: string, ctx: Ctx): Promise<ResolvedEpisode> {
  const found = await findItem(feedUrl, (item) => itemKey(item) === key, ctx);
  if (!found) throw gone(`The episode "${key}"`);
  return { feedUrl, ...found, key, url: episodeUrl(feedUrl, key), via: 'feed' };
}

async function fromApple(ref: VideoRef, episodeId: string, ctx: Ctx): Promise<ResolvedEpisode> {
  const ids = parseAppleUrl(ref.url ?? ref.input);
  if (!ids) throw new Vid2ContextError('bad-request', `Apple ref ${ref.id} has no Apple Podcasts URL.`);
  const { show, episodes } = await appleLookup(ids.showId, ctx);
  const feedUrl = appleFeedUrl(show);
  const ep = episodes.find((e) => String(e.trackId) === episodeId);
  let found: { channel: FeedChannel; item: FeedItem } | null = null;
  if (ep) {
    const title = normTitle(ep.trackName);
    found = await findItem(
      feedUrl,
      (item) =>
        (Boolean(ep.episodeGuid) && item.guid === ep.episodeGuid) ||
        (Boolean(ep.episodeUrl) && item.enclosure?.url === ep.episodeUrl) ||
        normTitle(item.title) === title,
      ctx,
    );
  } else if (ids.slug && ids.slug.length >= 8) {
    // Older than the lookup window: match the title slug in the URL, and only when exactly one item fits.
    const slug = ids.slug;
    const matches: { channel: FeedChannel; item: FeedItem }[] = [];
    let channel: FeedChannel | undefined;
    for await (const ev of streamFeed(feedUrl, ctx)) {
      if (ev.type === 'channel') channel = ev.channel;
      else if (channel && appleSlug(ev.item.title).startsWith(slug)) matches.push({ channel, item: ev.item });
    }
    if (matches.length === 1) found = matches[0] ?? null;
  }
  if (!found) throw gone(`Apple Podcasts episode ${episodeId}${ep ? ` ("${ep.trackName}")` : ''}`);
  const key = itemKey(found.item);
  return {
    feedUrl,
    ...found,
    key,
    url: episodeUrl(feedUrl, key),
    via: 'apple',
    extra: { apple: { showId: ids.showId, episodeId, url: ref.url } },
  };
}

/** Resolve an episode ref (feed episode, Apple episode or Spotify episode) to its feed item. */
export function resolveEpisode(ref: VideoRef, ctx: Ctx): Promise<ResolvedEpisode> {
  return cached(`episode:${ref.id}`, async () => {
    const loc = episodeLocator(ref);
    if (loc) return fromFeed(loc.feedUrl, loc.key, ctx);
    const native = nativeSource(ref);
    if (native?.source === 'apple') return fromApple(ref, native.id, ctx);
    if (native?.source === 'spotify') {
      const m = await resolveSpotify('episode', native.id, ctx);
      return {
        feedUrl: m.feedUrl,
        channel: m.channel,
        item: m.item,
        key: m.key,
        url: episodeUrl(m.feedUrl, m.key),
        via: 'spotify',
        extra: { spotify: { episodeId: native.id, url: ref.url, show: m.info.showTitle } },
      };
    }
    throw new Vid2ContextError('bad-request', `${ref.id} is not a podcast episode ref.`, {
      hint: 'Pass a podcast episode, Apple Podcasts episode or Spotify episode link.',
    });
  });
}

/** Resolve a feed ref (feed URL, Apple show or Spotify show) to the feed URL. */
export function resolveFeedUrl(ref: VideoRef, ctx: Ctx): Promise<string> {
  return cached(`feed:${ref.id}`, async () => {
    const native = nativeSource(ref);
    if (native?.source === 'apple') return appleFeedUrl((await appleLookup(native.id, ctx)).show);
    if (native?.source === 'spotify') return (await resolveSpotify('show', native.id, ctx)).feedUrl;
    if (!ref.url) throw new Vid2ContextError('bad-request', `Feed ref ${ref.id} has no URL.`);
    return ref.url;
  });
}

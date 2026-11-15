/**
 * Spotify links, best effort and keyless. Spotify publishes no RSS, so a link
 * is matched to a public feed and accepted only when every signal agrees:
 *
 * 1. oEmbed (open.spotify.com/oembed) confirms the link and gives the episode
 *    title (for a show link: its latest episode's title).
 * 2. The public embed page (open.spotify.com/embed/...) gives the show title
 *    and the episode's release date. Spotify exposes no author keyless, so
 *    the release date and the feed's own content stand in for it.
 * 3. The iTunes Search API lists candidate feeds; only shows whose title
 *    equals the Spotify show title (normalized) are kept.
 * 4. Each candidate feed is read: its channel title must match too, and it
 *    must hold an item with the same episode title released within 3 days.
 *
 * Exactly one feed must pass; anything else throws `unsupported-input` with a
 * hint to paste the RSS feed. Copycat feeds that repost a show's episodes
 * under another show title are filtered by step 3. Verified live 2026-11-15.
 */
import { type Ctx, errorFromResponse, fetchWithTimeout, Vid2ContextError } from '@vid2context/core';
import { type FeedChannel, type FeedItem, itemKey, streamFeed, USER_AGENT } from './feed.ts';

/** Title comparison form: accents, case, punctuation and "&" versus "and" ignored. */
export function normTitle(s: string): string {
  return s
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

export interface SpotifyInfo {
  kind: 'show' | 'episode';
  id: string;
  /** Episode title (for a show link: the latest episode). */
  episodeTitle: string;
  showTitle?: string;
  releaseDate?: string;
  thumbnailUrl?: string;
}

export interface SpotifyMatch {
  feedUrl: string;
  channel: FeedChannel;
  item: FeedItem;
  key: string;
  info: SpotifyInfo;
}

const MAX_CANDIDATES = 4;
const DATE_SLACK_MS = 3 * 24 * 3600 * 1000;

function hint(): string {
  return "Spotify has no public RSS. Paste the show's RSS feed URL (or its Apple Podcasts link) instead.";
}

function reject(why: string): Vid2ContextError {
  return new Vid2ContextError('unsupported-input', `Could not match this Spotify link to a public podcast feed: ${why}.`, {
    hint: hint(),
  });
}

export function oembedUrl(kind: string, id: string): string {
  return `https://open.spotify.com/oembed?url=${encodeURIComponent(`https://open.spotify.com/${kind}/${id}`)}`;
}

export function embedUrl(kind: string, id: string): string {
  return `https://open.spotify.com/embed/${kind}/${id}`;
}

interface EmbedEntity {
  name?: string;
  title?: string;
  subtitle?: string;
  releaseDate?: { isoString?: string };
}

/** The entity in an embed page's __NEXT_DATA__ JSON, or undefined. */
export function embedEntity(html: string): EmbedEntity | undefined {
  const m = /<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/.exec(html);
  if (!m?.[1]) return undefined;
  try {
    const data = JSON.parse(m[1]) as { props?: { pageProps?: { state?: { data?: { entity?: EmbedEntity } } } } };
    return data.props?.pageProps?.state?.data?.entity;
  } catch {
    return undefined;
  }
}

export async function spotifyInfo(kind: 'show' | 'episode', id: string, ctx: Ctx): Promise<SpotifyInfo> {
  const headers = { 'user-agent': USER_AGENT };
  const res = await fetchWithTimeout(ctx, oembedUrl(kind, id), { headers }, 20_000);
  if (res.status === 404 || res.status === 400) {
    throw new Vid2ContextError('not-found', `Spotify has no ${kind} ${id}.`, { hint: 'Check the link.' });
  }
  if (!res.ok) throw await errorFromResponse(res, 'Spotify oEmbed');
  const oembed = (await res.json()) as { title?: string; thumbnail_url?: string };
  let entity: EmbedEntity | undefined;
  try {
    const page = await fetchWithTimeout(ctx, embedUrl(kind, id), { headers }, 20_000);
    if (page.ok) entity = embedEntity(await page.text());
  } catch (err) {
    if (ctx.signal?.aborted) throw err;
    ctx.log.debug('spotify embed page failed', { error: String(err) });
  }
  const episodeTitle = (entity?.name ?? oembed.title ?? '').trim();
  if (!episodeTitle) throw reject('Spotify returned no title');
  return {
    kind,
    id,
    episodeTitle,
    ...(entity?.subtitle ? { showTitle: entity.subtitle.trim() } : {}),
    ...(entity?.releaseDate?.isoString ? { releaseDate: entity.releaseDate.isoString } : {}),
    ...(oembed.thumbnail_url ? { thumbnailUrl: oembed.thumbnail_url } : {}),
  };
}

export function searchUrl(term: string): string {
  return `https://itunes.apple.com/search?media=podcast&limit=10&term=${encodeURIComponent(term)}`;
}

interface SearchResult {
  collectionName?: string;
  artistName?: string;
  feedUrl?: string;
}

async function feedMatches(
  feedUrl: string,
  info: SpotifyInfo,
  ctx: Ctx,
): Promise<{ channel: FeedChannel; item: FeedItem } | null> {
  const wantShow = normTitle(info.showTitle ?? '');
  const wantEpisode = normTitle(info.episodeTitle);
  const released = info.releaseDate ? Date.parse(info.releaseDate) : Number.NaN;
  let channel: FeedChannel | undefined;
  for await (const ev of streamFeed(feedUrl, ctx)) {
    if (ev.type === 'channel') {
      if (normTitle(ev.channel.title) !== wantShow) return null;
      channel = ev.channel;
      continue;
    }
    if (!channel) continue;
    if (normTitle(ev.item.title) !== wantEpisode) continue;
    const pub = ev.item.publishedAt ? Date.parse(ev.item.publishedAt) : Number.NaN;
    if (Number.isFinite(released) && Number.isFinite(pub) && Math.abs(pub - released) > DATE_SLACK_MS) continue;
    return { channel, item: ev.item };
  }
  return null;
}

/** Match a Spotify show or episode to exactly one public feed, or throw `unsupported-input`. */
export async function resolveSpotify(kind: 'show' | 'episode', id: string, ctx: Ctx): Promise<SpotifyMatch> {
  const info = await spotifyInfo(kind, id, ctx);
  if (!info.showTitle) throw reject('Spotify did not say which show this is');
  const res = await fetchWithTimeout(ctx, searchUrl(info.showTitle), { headers: { 'user-agent': USER_AGENT } }, 30_000);
  if (!res.ok) throw await errorFromResponse(res, 'iTunes Search');
  const data = (await res.json()) as { results?: SearchResult[] };
  const want = normTitle(info.showTitle);
  const feeds = [
    ...new Set(
      (data.results ?? []).filter((r) => r.feedUrl && normTitle(r.collectionName ?? '') === want).map((r) => r.feedUrl as string),
    ),
  ].slice(0, MAX_CANDIDATES);
  if (feeds.length === 0) throw reject(`no public feed is listed under the show title "${info.showTitle}"`);
  const passed: SpotifyMatch[] = [];
  for (const feedUrl of feeds) {
    try {
      const got = await feedMatches(feedUrl, info, ctx);
      if (got) passed.push({ feedUrl, channel: got.channel, item: got.item, key: itemKey(got.item), info });
    } catch (err) {
      if (ctx.signal?.aborted) throw err;
      ctx.log.debug('spotify candidate feed failed', { feedUrl, error: String(err) });
    }
  }
  const first = passed[0];
  if (!first) throw reject(`no feed titled "${info.showTitle}" has the episode "${info.episodeTitle}"`);
  if (passed.length > 1) throw reject(`${passed.length} different feeds match "${info.showTitle}"`);
  return first;
}

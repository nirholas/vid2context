/**
 * Apple Podcasts links through the keyless iTunes Lookup API, which returns
 * a show's RSS feed URL and its most recent episodes (up to 200) with their
 * Apple track ids, feed guids and enclosure URLs. Verified live 2026-11-15.
 *
 * Looking up an episode id directly returns nothing, so episodes are found
 * through their show: by track id in the lookup (then by guid, enclosure or
 * title in the feed), or, for episodes older than the lookup window, by the
 * title slug in the Apple URL.
 */
import { type Ctx, errorFromResponse, fetchWithTimeout, Vid2ContextError } from '@vid2context/core';
import { USER_AGENT } from './feed.ts';

export interface AppleShow {
  collectionId: number;
  collectionName: string;
  artistName?: string;
  feedUrl?: string;
  artworkUrl600?: string;
  collectionViewUrl?: string;
}

export interface AppleEpisode {
  trackId: number;
  trackName: string;
  episodeGuid?: string;
  episodeUrl?: string;
  releaseDate?: string;
  trackTimeMillis?: number;
  trackViewUrl?: string;
}

interface LookupResult {
  wrapperType?: string;
  kind?: string;
  [k: string]: unknown;
}

export function lookupUrl(showId: string): string {
  return `https://itunes.apple.com/lookup?id=${encodeURIComponent(showId)}&entity=podcastEpisode&limit=200`;
}

export async function appleLookup(showId: string, ctx: Ctx): Promise<{ show: AppleShow; episodes: AppleEpisode[] }> {
  const res = await fetchWithTimeout(ctx, lookupUrl(showId), { headers: { 'user-agent': USER_AGENT } }, 30_000);
  if (!res.ok) throw await errorFromResponse(res, 'iTunes Lookup');
  const data = (await res.json()) as { results?: LookupResult[] };
  const results = data.results ?? [];
  const show = results.find((r) => r.kind === 'podcast') as unknown as AppleShow | undefined;
  if (!show) {
    throw new Vid2ContextError('not-found', `Apple Podcasts has no show with id ${showId}.`, {
      hint: 'Check the link, or paste the show RSS feed URL instead.',
    });
  }
  const episodes = results.filter((r) => r.wrapperType === 'podcastEpisode') as unknown as AppleEpisode[];
  return { show, episodes };
}

/** Feed URL of an Apple show, or a clear error for shows without a public feed (Apple-hosted subscriptions). */
export function appleFeedUrl(show: AppleShow): string {
  if (!show.feedUrl) {
    throw new Vid2ContextError('unavailable', `"${show.collectionName}" has no public RSS feed on Apple Podcasts.`, {
      hint: 'The show is Apple-only. Pass the episode audio URL or another source for it instead.',
    });
  }
  return show.feedUrl;
}

/** Apple's URL slug for a title: lowercase, apostrophes dropped, other runs of non-alphanumerics as '-'. */
export function appleSlug(title: string): string {
  return title
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/['\u2019]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

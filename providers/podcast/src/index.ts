/**
 * Podcasts: RSS and Atom feeds, Apple Podcasts and Spotify links.
 *
 * - `podcast` (source): resolves inputs to feed and episode refs, lists a
 *   feed's episodes newest first, reads episode metadata and chapters, and
 *   downloads the enclosure for speech-to-text.
 * - `podcast-transcript` (captions): the episode's Podcasting 2.0
 *   `podcast:transcript`, so episodes that publish one never reach
 *   speech-to-text (captions run before audio in the pipeline).
 *
 * Node and Workers. Browsers are left out: most feed hosts send no CORS headers.
 */
import {
  type CaptionsProvider,
  type Chapter,
  type Ctx,
  defineProvider,
  errorFromResponse,
  fetchWithTimeout,
  type SourceProvider,
  type Transcript,
  Vid2ContextError,
  type VideoMetadata,
  type VideoRef,
} from '@vid2context/core';
import { downloadEnclosure } from './audio.ts';
import { fetchChapters } from './chapters.ts';
import { type FeedChannel, type FeedItem, itemKey, streamFeed, USER_AGENT, withEnds } from './feed.ts';
import { episodeRef, episodeUrl, matchPodcast, PLATFORM } from './refs.ts';
import { type ResolvedEpisode, resolveEpisode, resolveFeedUrl } from './resolve.ts';
import {
  parseHtmlTranscript,
  parseJsonTranscript,
  parseSubtitles,
  rankTranscripts,
  type TranscriptFormat,
} from './transcripts.ts';

export { appleLookup, appleSlug, lookupUrl } from './apple.ts';
export { audioFilename, audioMime, downloadEnclosure, fetchFollowing, maxMediaBytes } from './audio.ts';
export { parseJsonChapters } from './chapters.ts';
export type { FeedChannel, FeedItem, PodcastPerson, TranscriptLink } from './feed.ts';
export { htmlToText, itemKey, parseDate, parseDuration, parseFeed, parseFeedChunks, streamFeed } from './feed.ts';
export {
  canonicalFeedUrl,
  episodeLocator,
  episodeRef,
  episodeUrl,
  feedRef,
  looksLikeFeed,
  matchPodcast,
  parseAppleUrl,
  parseSpotify,
} from './refs.ts';
export { clearResolveCache, resolveEpisode, resolveFeedUrl } from './resolve.ts';
export { embedEntity, embedUrl, normTitle, oembedUrl, resolveSpotify, searchUrl } from './spotify.ts';
export {
  cueTime,
  parseHtmlTranscript,
  parseJsonTranscript,
  parseSubtitles,
  rankTranscripts,
  transcriptFormat,
} from './transcripts.ts';
export { parseXml, XmlStreamParser } from './xml.ts';

const RUNTIMES: SourceProvider['runtimes'] = ['node', 'workers'];

const isEpisode = (ref: VideoRef): boolean => ref.platform === PLATFORM && ref.kind === 'video';

async function chaptersFor(item: FeedItem, ctx: Ctx): Promise<Chapter[]> {
  if (item.chaptersUrl) {
    try {
      const got = await fetchChapters(item.chaptersUrl, ctx, item.durationSec);
      if (got.length > 0) return got;
    } catch (err) {
      if (ctx.signal?.aborted) throw err;
      ctx.log.warn('podcast chapters failed', { url: item.chaptersUrl, error: String(err) });
    }
  }
  return withEnds(item.inlineChapters, item.durationSec);
}

async function episodeMetadata(ref: VideoRef, r: ResolvedEpisode, ctx: Ctx): Promise<VideoMetadata> {
  const { item, channel } = r;
  const persons = item.persons.length > 0 ? item.persons : channel.persons;
  return {
    ref,
    title: item.title || channel.title,
    channel: { name: channel.title, id: r.feedUrl, ...(channel.link ? { url: channel.link } : {}) },
    ...(item.description ? { description: item.description } : {}),
    ...(item.durationSec ? { durationSec: item.durationSec } : {}),
    ...(item.publishedAt ? { publishedAt: item.publishedAt } : {}),
    ...(item.image || channel.image ? { thumbnailUrl: item.image ?? channel.image } : {}),
    ...(channel.language ? { language: channel.language } : {}),
    chapters: await chaptersFor(item, ctx),
    extra: {
      feedUrl: r.feedUrl,
      episodeUrl: r.url,
      ...(item.guid ? { guid: item.guid } : {}),
      ...(item.link ? { link: item.link } : {}),
      ...(item.enclosure ? { enclosure: item.enclosure } : {}),
      ...(channel.author ? { author: channel.author } : {}),
      ...(item.season ? { season: item.season } : {}),
      ...(item.episode ? { episode: item.episode } : {}),
      persons,
      transcripts: item.transcripts,
      ...(item.chaptersUrl ? { chaptersUrl: item.chaptersUrl } : {}),
      ...(r.extra ?? {}),
    },
  };
}

async function feedMetadata(ref: VideoRef, ctx: Ctx): Promise<VideoMetadata> {
  const feedUrl = await resolveFeedUrl(ref, ctx);
  let channel: FeedChannel | undefined;
  for await (const ev of streamFeed(feedUrl, ctx)) {
    if (ev.type === 'channel') {
      channel = ev.channel;
      break;
    }
  }
  if (!channel) throw new Vid2ContextError('unavailable', `${feedUrl} has no channel.`, { hint: 'Check the feed URL.' });
  return {
    ref,
    title: channel.title,
    ...(channel.author ? { channel: { name: channel.author } } : {}),
    ...(channel.description ? { description: channel.description } : {}),
    ...(channel.image ? { thumbnailUrl: channel.image } : {}),
    ...(channel.language ? { language: channel.language } : {}),
    chapters: [],
    extra: { feedUrl, format: channel.format, ...(channel.link ? { link: channel.link } : {}), persons: channel.persons },
  };
}

const time = (item: FeedItem): number => (item.publishedAt ? Date.parse(item.publishedAt) : Number.NaN);

/**
 * Episodes newest first. Most feeds already list newest first, so items
 * stream as they parse. When the first two dated items show an oldest-first
 * feed, the whole feed is read and sorted instead.
 */
async function* listEpisodes(ref: VideoRef, ctx: Ctx, limit?: number): AsyncGenerator<VideoRef> {
  const feedUrl = await resolveFeedUrl(ref, ctx);
  const toRef = (item: FeedItem): VideoRef => {
    const key = itemKey(item);
    return episodeRef(episodeUrl(feedUrl, key), feedUrl, key);
  };
  const max = limit && limit > 0 ? limit : Number.POSITIVE_INFINITY;
  let sent = 0;
  const pending: FeedItem[] = [];
  let mode: 'undecided' | 'stream' | 'sort' = 'undecided';
  for await (const ev of streamFeed(feedUrl, ctx)) {
    if (ev.type !== 'item') continue;
    if (mode === 'stream') {
      yield toRef(ev.item);
      if (++sent >= max) return;
      continue;
    }
    pending.push(ev.item);
    if (mode === 'undecided') {
      const dated = pending.filter((i) => Number.isFinite(time(i)));
      const [a, b] = dated;
      if (a && b) {
        mode = time(a) >= time(b) ? 'stream' : 'sort';
        if (mode === 'stream') {
          for (const item of pending.splice(0)) {
            yield toRef(item);
            if (++sent >= max) return;
          }
        }
      }
    }
  }
  const order = pending.map((item, i) => ({ item, i, t: time(item) }));
  if (mode === 'sort') {
    order.sort((x, y) => {
      const xf = Number.isFinite(x.t);
      const yf = Number.isFinite(y.t);
      if (xf && yf) return y.t - x.t || x.i - y.i;
      return xf === yf ? x.i - y.i : xf ? -1 : 1;
    });
  }
  for (const { item } of order) {
    yield toRef(item);
    if (++sent >= max) return;
  }
}

export const podcastSource: SourceProvider = defineProvider({
  id: 'podcast',
  kind: 'source',
  name: 'Podcast',
  runtimes: RUNTIMES,
  match: matchPodcast,
  async getMetadata(ref, ctx) {
    if (ref.kind === 'feed') return feedMetadata(ref, ctx);
    return episodeMetadata(ref, await resolveEpisode(ref, ctx), ctx);
  },
  listItems(ref, ctx, opts) {
    if (ref.kind !== 'feed') {
      throw new Vid2ContextError('unsupported-input', `${ref.id} is an episode, not a feed.`, {
        hint: 'Pass the podcast feed, Apple Podcasts show or Spotify show link to list episodes.',
      });
    }
    return listEpisodes(ref, ctx, opts?.limit);
  },
  canProvideAudio: (ref) => isEpisode(ref),
  async getAudio(ref, ctx) {
    const { item } = await resolveEpisode(ref, ctx);
    if (!item.enclosure) {
      throw new Vid2ContextError('unavailable', `The episode "${item.title}" has no audio enclosure in its feed.`, {
        hint: 'Pass the episode audio URL directly if it is published elsewhere.',
      });
    }
    return downloadEnclosure(item.enclosure, ctx);
  },
});

const PRODUCER = 'podcast-transcript';

async function fetchTranscript(
  url: string,
  format: TranscriptFormat,
  ctx: Ctx,
): Promise<{ segments: Transcript['segments']; timed: boolean }> {
  const res = await fetchWithTimeout(ctx, url, { headers: { 'user-agent': USER_AGENT } }, 60_000);
  if (!res.ok) throw await errorFromResponse(res, 'podcast transcript');
  const body = await res.text();
  if (format === 'json') return { segments: parseJsonTranscript(body), timed: true };
  if (format === 'html') return parseHtmlTranscript(body);
  return { segments: parseSubtitles(body), timed: true };
}

export const podcastTranscript: CaptionsProvider = defineProvider({
  id: 'podcast-transcript',
  kind: 'captions',
  name: 'Podcast transcript (podcast:transcript)',
  runtimes: RUNTIMES,
  supports: isEpisode,
  async listTracks(ref, ctx) {
    const { item, channel } = await resolveEpisode(ref, ctx);
    return rankTranscripts(item.transcripts).map((t) => ({
      language: t.language ?? channel.language ?? 'und',
      name: `${t.format.toUpperCase()} (${t.type || 'unknown type'})`,
      origin: 'native-transcript' as const,
    }));
  },
  async getCaptions(ref, opts, ctx) {
    const { item, channel } = await resolveEpisode(ref, ctx);
    const ranked = rankTranscripts(item.transcripts, opts.language);
    if (ranked.length === 0) return null;
    let lastError: unknown;
    for (const t of ranked) {
      try {
        const { segments, timed } = await fetchTranscript(t.url, t.format, ctx);
        if (segments.length === 0) continue;
        return {
          ref,
          language: t.language ?? channel.language ?? 'und',
          origin: 'native-transcript',
          producer: timed ? PRODUCER : `${PRODUCER}/html-untimed`,
          segments,
          createdAt: new Date().toISOString(),
        } satisfies Transcript;
      } catch (err) {
        if (ctx.signal?.aborted) throw err;
        lastError = err;
        ctx.log.warn('podcast transcript failed', { url: t.url, format: t.format, error: String(err) });
      }
    }
    if (lastError) throw lastError;
    return null;
  },
});

export default [podcastSource, podcastTranscript];

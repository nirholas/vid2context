/**
 * RSS 2.0 and Atom podcast feeds to plain objects: the channel (show) and its
 * items (episodes), including the iTunes tags and the Podcasting 2.0 tags
 * vid2context uses (`podcast:transcript`, `podcast:chapters`,
 * `podcast:person`) plus Podlove Simple Chapters (`psc:chapters`) as a
 * chapters fallback. `streamFeed` yields items while the feed downloads.
 */
import { type Chapter, type Ctx, decodeEntities, errorFromResponse, fetchWithTimeout, Vid2ContextError } from '@vid2context/core';
import { child, childrenNamed, localName, textOf, type XmlElement, XmlStreamParser } from './xml.ts';

export const USER_AGENT = 'vid2context/0.1 (+https://github.com/nirholas/vid2context)';

export interface PodcastPerson {
  name: string;
  role?: string;
  group?: string;
  href?: string;
  img?: string;
}

export interface TranscriptLink {
  url: string;
  type: string;
  language?: string;
  rel?: string;
}

export interface Enclosure {
  url: string;
  type?: string;
  length?: number;
}

export interface FeedChannel {
  format: 'rss' | 'atom';
  title: string;
  author?: string;
  image?: string;
  description?: string;
  language?: string;
  link?: string;
  /** The feed's own URL from atom:link rel="self", when declared. */
  selfUrl?: string;
  persons: PodcastPerson[];
}

export interface FeedItem {
  title: string;
  guid?: string;
  link?: string;
  /** ISO 8601. */
  publishedAt?: string;
  durationSec?: number;
  enclosure?: Enclosure;
  /** Plain text (HTML show notes converted). */
  description?: string;
  image?: string;
  transcripts: TranscriptLink[];
  chaptersUrl?: string;
  chaptersType?: string;
  /** Podlove Simple Chapters embedded in the item. */
  inlineChapters: Chapter[];
  persons: PodcastPerson[];
  season?: number;
  episode?: number;
}

/** Stable key of an item inside its feed: the guid, else the enclosure, link or title. */
export function itemKey(item: FeedItem): string {
  return item.guid || item.enclosure?.url || item.link || `${item.title}|${item.publishedAt ?? ''}`;
}

/** "1:02:03", "62:03", "3723", "3723.5" to seconds. */
export function parseDuration(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const s = raw.trim();
  if (!s) return undefined;
  if (/^\d+(\.\d+)?$/.test(s)) {
    const n = Number(s);
    return n > 0 ? Math.round(n) : undefined;
  }
  if (!/^\d+(:\d{1,2}){1,2}(\.\d+)?$/.test(s)) return undefined;
  let sec = 0;
  for (const p of s.split(':')) sec = sec * 60 + Number(p);
  return sec > 0 ? Math.round(sec) : undefined;
}

/** RFC 822 (RSS) or ISO 8601 (Atom) date to ISO 8601, or undefined. */
export function parseDate(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const t = Date.parse(raw.trim());
  return Number.isFinite(t) ? new Date(t).toISOString() : undefined;
}

/** HTML show notes to readable plain text. */
export function htmlToText(html: string): string {
  return decodeEntities(
    html
      .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, '')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|li|h[1-6]|ul|ol|blockquote)>/gi, '\n')
      .replace(/<li\b[^>]*>/gi, '- ')
      .replace(/<[^>]+>/g, ''),
  )
    .replace(/[ \t\u00a0]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function positiveInt(raw: string | undefined): number | undefined {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : undefined;
}

function persons(el: XmlElement | undefined): PodcastPerson[] {
  return childrenNamed(el, 'podcast:person')
    .map((p) => ({
      name: p.text.trim(),
      ...(p.attrs.role ? { role: p.attrs.role } : {}),
      ...(p.attrs.group ? { group: p.attrs.group } : {}),
      ...(p.attrs.href ? { href: p.attrs.href } : {}),
      ...(p.attrs.img ? { img: p.attrs.img } : {}),
    }))
    .filter((p) => p.name);
}

/** Podlove "normal play time": "1:02:03.500", "02:03", "123.5". */
function nptSeconds(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const s = raw.trim();
  if (!/^\d+(:\d{1,2}){0,2}(\.\d+)?$/.test(s)) return undefined;
  let sec = 0;
  for (const p of s.split(':')) sec = sec * 60 + Number(p);
  return sec;
}

function inlineChapters(el: XmlElement): Chapter[] {
  const list = child(el, 'psc:chapters');
  const out: Chapter[] = [];
  for (const c of childrenNamed(list, 'psc:chapter')) {
    const start = nptSeconds(c.attrs.start);
    const title = c.attrs.title?.trim();
    if (start === undefined || !title) continue;
    out.push({ title, startSec: start });
  }
  return withEnds(out);
}

/** Fill each chapter's endSec from the next start (and the last from `durationSec`). */
export function withEnds(chapters: Chapter[], durationSec?: number): Chapter[] {
  const sorted = [...chapters].sort((a, b) => a.startSec - b.startSec);
  return sorted.map((c, i) => {
    const next = sorted[i + 1]?.startSec ?? durationSec;
    return c.endSec !== undefined || next === undefined || next <= c.startSec ? c : { ...c, endSec: next };
  });
}

function transcripts(el: XmlElement): TranscriptLink[] {
  return childrenNamed(el, 'podcast:transcript')
    .filter((t) => t.attrs.url)
    .map((t) => ({
      url: t.attrs.url as string,
      type: (t.attrs.type ?? '').toLowerCase().split(';')[0]?.trim() ?? '',
      ...(t.attrs.language ? { language: t.attrs.language } : {}),
      ...(t.attrs.rel ? { rel: t.attrs.rel } : {}),
    }));
}

function atomLink(el: XmlElement, rel: string): XmlElement | undefined {
  return childrenNamed(el, 'atom:link').find((l) => (l.attrs.rel ?? 'alternate') === rel && l.attrs.href);
}

function description(el: XmlElement, names: string[]): string | undefined {
  for (const n of names) {
    const raw = child(el, n)?.text.trim();
    if (raw) return htmlToText(raw) || undefined;
  }
  return undefined;
}

export function parseRssItem(el: XmlElement): FeedItem {
  const enc = child(el, 'enclosure');
  const chapters = child(el, 'podcast:chapters');
  const encUrl = enc?.attrs.url?.trim();
  return {
    title: htmlToText(textOf(el, 'title', 'itunes:title') ?? ''),
    guid: textOf(el, 'guid'),
    link: textOf(el, 'link') ?? atomLink(el, 'alternate')?.attrs.href,
    publishedAt: parseDate(textOf(el, 'pubDate', 'dc:date')),
    durationSec: parseDuration(textOf(el, 'itunes:duration')),
    ...(encUrl
      ? {
          enclosure: {
            url: encUrl,
            ...(enc?.attrs.type ? { type: enc.attrs.type.toLowerCase() } : {}),
            ...(positiveInt(enc?.attrs.length) ? { length: positiveInt(enc?.attrs.length) } : {}),
          },
        }
      : {}),
    description: description(el, ['description', 'itunes:summary', 'content:encoded']),
    image: child(el, 'itunes:image')?.attrs.href ?? child(el, 'media:thumbnail')?.attrs.url,
    transcripts: transcripts(el),
    ...(chapters?.attrs.url ? { chaptersUrl: chapters.attrs.url, chaptersType: chapters.attrs.type } : {}),
    inlineChapters: inlineChapters(el),
    persons: persons(el),
    season: positiveInt(textOf(el, 'itunes:season', 'podcast:season')),
    episode: positiveInt(textOf(el, 'itunes:episode', 'podcast:episode')),
  };
}

export function parseAtomEntry(el: XmlElement): FeedItem {
  const enc = atomLink(el, 'enclosure');
  const chapters = child(el, 'podcast:chapters');
  return {
    title: htmlToText(textOf(el, 'atom:title') ?? ''),
    guid: textOf(el, 'atom:id'),
    link: atomLink(el, 'alternate')?.attrs.href,
    publishedAt: parseDate(textOf(el, 'atom:published', 'atom:updated')),
    durationSec: parseDuration(textOf(el, 'itunes:duration')),
    ...(enc?.attrs.href
      ? {
          enclosure: {
            url: enc.attrs.href,
            ...(enc.attrs.type ? { type: enc.attrs.type.toLowerCase() } : {}),
            ...(positiveInt(enc.attrs.length) ? { length: positiveInt(enc.attrs.length) } : {}),
          },
        }
      : {}),
    description: description(el, ['atom:summary', 'atom:content', 'itunes:summary']),
    image: child(el, 'itunes:image')?.attrs.href ?? child(el, 'media:thumbnail')?.attrs.url,
    transcripts: transcripts(el),
    ...(chapters?.attrs.url ? { chaptersUrl: chapters.attrs.url, chaptersType: chapters.attrs.type } : {}),
    inlineChapters: inlineChapters(el),
    persons: persons(el),
    season: positiveInt(textOf(el, 'itunes:season', 'podcast:season')),
    episode: positiveInt(textOf(el, 'itunes:episode', 'podcast:episode')),
  };
}

export function parseRssChannel(el: XmlElement): FeedChannel {
  return {
    format: 'rss',
    title: htmlToText(textOf(el, 'title', 'itunes:title') ?? ''),
    author: textOf(el, 'itunes:author', 'dc:creator', 'managingEditor', 'author'),
    image: child(el, 'itunes:image')?.attrs.href ?? textOf(child(el, 'image'), 'url'),
    description: description(el, ['description', 'itunes:summary', 'content:encoded']),
    language: textOf(el, 'language', 'dc:language'),
    link: textOf(el, 'link'),
    selfUrl: atomLink(el, 'self')?.attrs.href,
    persons: persons(el),
  };
}

export function parseAtomFeed(el: XmlElement): FeedChannel {
  return {
    format: 'atom',
    title: htmlToText(textOf(el, 'atom:title') ?? ''),
    author: textOf(child(el, 'atom:author'), 'atom:name') ?? textOf(el, 'itunes:author'),
    image: child(el, 'itunes:image')?.attrs.href ?? textOf(el, 'atom:logo', 'atom:icon'),
    description: description(el, ['atom:subtitle', 'itunes:summary']),
    language: el.attrs['xml:lang'],
    link: atomLink(el, 'alternate')?.attrs.href,
    selfUrl: atomLink(el, 'self')?.attrs.href,
    persons: persons(el),
  };
}

export type FeedEvent = { type: 'channel'; channel: FeedChannel } | { type: 'item'; item: FeedItem };

const isItem = (el: XmlElement): boolean => el.name === 'item' || el.name === 'rdf:item' || el.name === 'atom:entry';

function channelOf(root: XmlElement | undefined, open: readonly XmlElement[]): FeedChannel | undefined {
  if (!root) return undefined;
  if (root.name === 'atom:feed') return parseAtomFeed(root);
  const ch = open.find((e) => localName(e.name) === 'channel') ?? root.children.find((e) => localName(e.name) === 'channel');
  return ch ? parseRssChannel(ch) : undefined;
}

function notAFeed(): Vid2ContextError {
  return new Vid2ContextError('unsupported-input', 'The URL did not return an RSS or Atom feed.', {
    hint: 'Pass the podcast RSS feed URL itself (look for "RSS" on the show page), or an Apple Podcasts or Spotify link.',
  });
}

/**
 * Parse feed text chunks into events: the channel first (as soon as the first
 * item closes, or at the end for a feed without items), then each item in
 * document order.
 */
export async function* parseFeedChunks(chunks: AsyncIterable<string> | Iterable<string>): AsyncGenerator<FeedEvent> {
  const parser = new XmlStreamParser(isItem);
  let channelSent = false;
  let checked = false;
  const check = () => {
    const root = parser.root;
    if (checked || !root) return;
    checked = true;
    if (!['rss', 'atom:feed', 'rdf:RDF'].includes(root.name)) throw notAFeed();
  };
  function* emit(items: XmlElement[]): Generator<FeedEvent> {
    check();
    for (const el of items) {
      if (!channelSent) {
        const channel = channelOf(parser.root, parser.open);
        if (!channel) throw notAFeed();
        channelSent = true;
        yield { type: 'channel', channel };
      }
      yield { type: 'item', item: el.name === 'atom:entry' ? parseAtomEntry(el) : parseRssItem(el) };
    }
  }
  for await (const chunk of chunks) yield* emit(parser.write(chunk));
  yield* emit(parser.end());
  if (!parser.root) throw notAFeed();
  check();
  if (!channelSent) {
    const channel = channelOf(parser.root, []);
    if (!channel) throw notAFeed();
    yield { type: 'channel', channel };
  }
}

/** Parse a complete feed document. */
export async function parseFeed(text: string): Promise<{ channel: FeedChannel; items: FeedItem[] }> {
  let channel: FeedChannel | undefined;
  const items: FeedItem[] = [];
  for await (const ev of parseFeedChunks([text])) {
    if (ev.type === 'channel') channel = ev.channel;
    else items.push(ev.item);
  }
  if (!channel) throw notAFeed();
  return { channel, items };
}

/** Feeds larger than this are refused (the largest real feeds are around 30 MB). */
const MAX_FEED_BYTES = 64 * 1024 * 1024;

function charsetOf(contentType: string | null): string {
  const m = /charset=["']?([\w-]+)/i.exec(contentType ?? '');
  return m?.[1]?.toLowerCase() ?? 'utf-8';
}

async function* bodyText(res: Response, ctx: Ctx): AsyncGenerator<string> {
  let decoder: TextDecoder;
  try {
    decoder = new TextDecoder(charsetOf(res.headers.get('content-type')));
  } catch {
    decoder = new TextDecoder('utf-8');
  }
  if (!res.body) {
    yield decoder.decode(new Uint8Array(await res.arrayBuffer()));
    return;
  }
  const reader = res.body.getReader();
  let total = 0;
  try {
    for (;;) {
      if (ctx.signal?.aborted) throw ctx.signal.reason ?? new DOMException('Aborted', 'AbortError');
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_FEED_BYTES) {
        throw new Vid2ContextError('too-large', `The feed is over ${MAX_FEED_BYTES / 1048576} MB.`, {
          hint: 'Pass a single episode instead, or a smaller feed.',
        });
      }
      yield decoder.decode(value, { stream: true });
    }
    const rest = decoder.decode();
    if (rest) yield rest;
  } finally {
    await reader.cancel().catch(() => {});
  }
}

/** Download a feed and stream its events. Stopping early cancels the download. */
export async function* streamFeed(url: string, ctx: Ctx): AsyncGenerator<FeedEvent> {
  const res = await fetchWithTimeout(
    ctx,
    url,
    {
      redirect: 'follow',
      headers: {
        'user-agent': USER_AGENT,
        accept: 'application/rss+xml, application/atom+xml, application/xml;q=0.9, text/xml;q=0.9, */*;q=0.5',
      },
    },
    120_000,
  );
  if (!res.ok) {
    const err = await errorFromResponse(res, 'podcast feed');
    if (err.code === 'not-found') {
      throw new Vid2ContextError('not-found', `The podcast feed ${url} returned HTTP ${res.status}.`, {
        status: res.status,
        hint: 'The feed may have moved. Find the current RSS URL on the show page or in a podcast app.',
      });
    }
    throw err;
  }
  yield* parseFeedChunks(bodyText(res, ctx));
}

/**
 * Find the videos in an HTML document, in page order, de-duplicated.
 *
 * Sources, each recorded on the result:
 *   iframe     <iframe>, <embed> and <object> players of known platforms (YouTube, Vimeo,
 *              Loom, Wistia, Dailymotion, Twitch, Rumble, TED), plus Wistia's
 *              `wistia_async_<id>` class and <wistia-player media-id> element
 *   video-tag  <video src> and <source src> inside <video>, resolved against the page URL
 *   og         Open Graph og:video, og:video:url, og:video:secure_url
 *   json-ld    schema.org VideoObject anywhere in JSON-LD (top level, arrays, @graph, nested)
 *   oembed     <link rel="alternate" type="...+oembed"> whose url= points at a known video page
 *   link       <a href> to a known video page or a media file
 *
 * When the same video turns up several times (an iframe and the JSON-LD that
 * describes it), it is reported once, at its first position, with the details
 * of every sighting merged.
 */
import { decodeHTML } from 'entities';
import { Parser } from 'htmlparser2';
import { absoluteUrl, type Classified, classifyVideoUrl, isMediaFileUrl, wistiaInput } from './platforms.ts';

export type DiscoverySource = 'iframe' | 'video-tag' | 'og' | 'json-ld' | 'oembed' | 'link';

export interface DiscoveredVideo {
  /** An input another source resolves: a watch URL, an embed URL or a media file URL. */
  input: string;
  /** 'youtube', 'vimeo', 'loom', 'wistia', 'dailymotion', 'twitch', 'rumble', 'ted', 'media' (a file) or 'web'. */
  platform: string;
  title?: string;
  /** Where on the page it was first seen. */
  source: DiscoverySource;
  description?: string;
  durationSec?: number;
  /** ISO 8601, from JSON-LD uploadDate. */
  uploadDate?: string;
  thumbnailUrl?: string;
  /** BCP-47, from JSON-LD inLanguage. */
  language?: string;
  /** True when the page's JSON-LD carries a transcript for this video. */
  hasTranscript?: boolean;
}

/** A discovered video plus what only the provider needs: the JSON-LD transcript and its VideoObject index. */
export interface PageVideo extends DiscoveredVideo {
  transcript?: string;
  /** Index among the page's JSON-LD VideoObjects, when one describes this video. */
  ldIndex?: number;
  author?: string;
}

export interface PageInfo {
  title?: string;
  description?: string;
  image?: string;
  language?: string;
  videos: PageVideo[];
}

type JsonValue = string | number | boolean | null | JsonValue[] | { [k: string]: JsonValue };

/** ISO 8601 duration (PT1H2M3S, P0DT19M11S) to seconds. */
export function isoDurationSec(s: unknown): number | undefined {
  if (typeof s !== 'string') return undefined;
  const m = /^P(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/i.exec(s.trim());
  if (!m || s.trim() === 'P' || s.trim() === 'PT') return undefined;
  const [d, h, min, sec] = m.slice(1).map((v) => (v ? Number(v) : 0));
  return (d ?? 0) * 86400 + (h ?? 0) * 3600 + (min ?? 0) * 60 + (sec ?? 0);
}

const text = (v: unknown): string | undefined => {
  if (typeof v !== 'string') return undefined;
  const t = decodeHTML(v).trim();
  return t || undefined;
};

/** First URL in a JSON-LD url, array or object. Entities are decoded: some sites (TED) HTML-escape inside the JSON. */
function firstUrlOf(v: JsonValue | undefined): string | undefined {
  if (typeof v === 'string') return decodeHTML(v).trim() || undefined;
  if (Array.isArray(v)) {
    for (const x of v) {
      const u = firstUrlOf(x);
      if (u) return u;
    }
    return undefined;
  }
  if (v && typeof v === 'object') return firstUrlOf(v.url ?? v.contentUrl);
  return undefined;
}

function nameOf(v: JsonValue | undefined): string | undefined {
  if (typeof v === 'string') return text(v);
  if (Array.isArray(v)) return v.map(nameOf).filter(Boolean).join(', ') || undefined;
  if (v && typeof v === 'object') return text(v.name);
  return undefined;
}

function isVideoObject(o: { [k: string]: JsonValue }): boolean {
  const t = o['@type'];
  return t === 'VideoObject' || (Array.isArray(t) && t.includes('VideoObject'));
}

/** Every VideoObject in a JSON-LD value, depth first, in document order. */
export function videoObjects(value: JsonValue, out: { [k: string]: JsonValue }[] = [], depth = 0): { [k: string]: JsonValue }[] {
  if (depth > 12 || value === null || typeof value !== 'object') return out;
  if (Array.isArray(value)) {
    for (const v of value) videoObjects(v, out, depth + 1);
    return out;
  }
  if (isVideoObject(value)) out.push(value);
  for (const [k, v] of Object.entries(value)) if (k !== '@context') videoObjects(v, out, depth + 1);
  return out;
}

/** Iframe titles that name the player, not the video. */
const GENERIC_TITLE =
  /^(youtube|vimeo|loom|wistia|dailymotion|twitch|rumble)?\s*(video\s*)?(player|embed(ded)?( content)?|video)?$/i;
const cleanTitle = (t: string | undefined): string | undefined => {
  const s = t?.replace(/\s+/g, ' ').trim();
  return s && !GENERIC_TITLE.test(s) ? s : undefined;
};

const dedupeKey = (input: string): string => {
  try {
    const u = new URL(input);
    u.hash = '';
    u.hostname = u.hostname.replace(/^www\./, '');
    return u.href;
  } catch {
    return input;
  }
};

class Collector {
  readonly videos: PageVideo[] = [];
  private readonly byKey = new Map<string, PageVideo>();

  add(found: Classified, source: DiscoverySource, details: Omit<PageVideo, 'input' | 'platform' | 'source'> = {}): void {
    const key = dedupeKey(found.input);
    const existing = this.byKey.get(key);
    const clean = Object.fromEntries(Object.entries(details).filter(([, v]) => v !== undefined)) as Partial<PageVideo>;
    if (existing) {
      for (const [k, v] of Object.entries(clean) as [keyof PageVideo, never][]) if (existing[k] === undefined) existing[k] = v;
      return;
    }
    const video: PageVideo = { input: found.input, platform: found.platform, source, ...clean };
    this.byKey.set(key, video);
    this.videos.push(video);
  }
}

/** Parse `html` (fetched from `pageUrl`) and return the page's title, description and videos. */
export function discoverInHtml(html: string, pageUrl: URL): PageInfo {
  const found = new Collector();
  let base = pageUrl;
  let baseSet = false;
  const info: Omit<PageInfo, 'videos'> = {};
  const meta: Record<string, string> = {};
  let titleText = '';
  let inTitle = false;
  let videoDepth = 0;
  let videoTitle: string | undefined;
  let ldText: string | null = null;
  let ldCount = 0;
  let anchor: { href: URL; text: string } | null = null;

  const classify = (raw: string | undefined): Classified | null => {
    const u = absoluteUrl(raw, base);
    return u ? classifyVideoUrl(u) : null;
  };
  const mediaFile = (raw: string | undefined): Classified | null => {
    const u = absoluteUrl(raw, base);
    return u && isMediaFileUrl(u) ? { input: u.href, platform: 'media' } : null;
  };

  const onLd = (raw: string) => {
    let parsed: JsonValue;
    try {
      parsed = JSON.parse(raw.trim()) as JsonValue;
    } catch {
      return;
    }
    for (const o of videoObjects(parsed)) {
      const ldIndex = ldCount++;
      const embed = firstUrlOf(o.embedUrl);
      const content = firstUrlOf(o.contentUrl);
      const target =
        classify(embed) ??
        classify(content) ??
        mediaFile(content) ??
        (absoluteUrl(embed, base) ? { input: (absoluteUrl(embed, base) as URL).href, platform: 'web' } : null) ??
        (absoluteUrl(content, base) ? { input: (absoluteUrl(content, base) as URL).href, platform: 'web' } : null) ??
        // A VideoObject with a transcript but no playable URL still describes this page's video.
        (text(o.transcript) ? { input: pageUrl.href, platform: 'web' } : null);
      if (!target) continue;
      const transcript = text(o.transcript);
      found.add(target, 'json-ld', {
        title: text(o.name),
        description: text(o.description),
        durationSec: isoDurationSec(o.duration),
        uploadDate: text(o.uploadDate),
        thumbnailUrl: firstUrlOf(o.thumbnailUrl ?? o.thumbnail),
        language: typeof o.inLanguage === 'string' ? o.inLanguage : undefined,
        author: nameOf(o.author ?? o.creator),
        ldIndex,
        ...(transcript ? { transcript, hasTranscript: true } : {}),
      });
    }
  };

  const parser = new Parser(
    {
      onopentag(name, attrs) {
        const cls = attrs.class;
        // Channel embeds reuse the class with a project id (class "wistia_channel wistia_async_<project>"): not a media.
        if (cls && !/\bwistia_channel\b/.test(cls)) {
          for (const m of cls.matchAll(/\bwistia_async_([a-z0-9]{10})\b/g)) {
            const w = m[1] ? wistiaInput(m[1]) : null;
            if (w) found.add(w, 'iframe');
          }
        }
        switch (name) {
          case 'html':
            if (attrs.lang) info.language = attrs.lang;
            break;
          case 'base':
            if (!baseSet && attrs.href) {
              const b = absoluteUrl(attrs.href, pageUrl);
              if (b) base = b;
              baseSet = true;
            }
            break;
          case 'title':
            if (videoDepth === 0) inTitle = true;
            break;
          case 'meta': {
            const key = (attrs.property ?? attrs.name ?? '').toLowerCase();
            const content = attrs.content;
            if (!key || content === undefined) break;
            if (meta[key] === undefined) meta[key] = content;
            if (key === 'og:video' || key === 'og:video:url' || key === 'og:video:secure_url') {
              const hit = classify(content) ?? mediaFile(content);
              const u = absoluteUrl(content, base);
              const target = hit ?? (u ? { input: u.href, platform: 'web' } : null);
              if (target) found.add(target, 'og', { title: cleanTitle(meta['og:title']) });
            }
            break;
          }
          case 'link': {
            const type = (attrs.type ?? '').toLowerCase();
            if (/\boembed\b/.test(type) && attrs.href) {
              const href = absoluteUrl(attrs.href, base);
              const target = href?.searchParams.get('url');
              const hit = target ? classify(target) : null;
              if (hit) found.add(hit, 'oembed', { title: cleanTitle(attrs.title) });
            }
            break;
          }
          case 'script':
            if ((attrs.type ?? '').toLowerCase().includes('ld+json')) ldText = '';
            break;
          case 'iframe':
          case 'embed': {
            const hit = classify(attrs.src) ?? classify(attrs['data-src']);
            if (hit) found.add(hit, 'iframe', { title: cleanTitle(attrs.title) });
            break;
          }
          case 'object': {
            const hit = classify(attrs.data);
            if (hit) found.add(hit, 'iframe', { title: cleanTitle(attrs.title) });
            break;
          }
          case 'wistia-player': {
            const w = attrs['media-id'] ? wistiaInput(attrs['media-id']) : null;
            if (w) found.add(w, 'iframe');
            break;
          }
          case 'video': {
            videoDepth++;
            videoTitle = cleanTitle(attrs.title ?? attrs['aria-label']);
            const src = attrs.src ?? attrs['data-src'];
            const u = absoluteUrl(src, base);
            if (u) found.add(classifyVideoUrl(u) ?? { input: u.href, platform: 'media' }, 'video-tag', { title: videoTitle });
            break;
          }
          case 'source': {
            if (videoDepth === 0) break; // <source> in <picture> or <audio> is not a video
            const u = absoluteUrl(attrs.src ?? attrs['data-src'], base);
            if (u) found.add(classifyVideoUrl(u) ?? { input: u.href, platform: 'media' }, 'video-tag', { title: videoTitle });
            break;
          }
          case 'a': {
            const href = absoluteUrl(attrs.href, base);
            anchor = href ? { href, text: '' } : null;
            break;
          }
        }
      },
      ontext(chunk) {
        if (ldText !== null) ldText += chunk;
        else if (inTitle) titleText += chunk;
        if (anchor) anchor.text += chunk;
      },
      onclosetag(name) {
        if (name === 'script' && ldText !== null) {
          onLd(ldText);
          ldText = null;
        } else if (name === 'title') inTitle = false;
        else if (name === 'video') {
          videoDepth = Math.max(0, videoDepth - 1);
          videoTitle = undefined;
        } else if (name === 'a' && anchor) {
          const hit =
            classifyVideoUrl(anchor.href) ??
            (isMediaFileUrl(anchor.href) ? { input: anchor.href.href, platform: 'media' } : null);
          if (hit) found.add(hit, 'link', { title: cleanTitle(decodeHTML(anchor.text)) });
          anchor = null;
        }
      },
    },
    { decodeEntities: true, lowerCaseTags: true, lowerCaseAttributeNames: true },
  );
  parser.write(html);
  parser.end();

  const title = cleanTitle(meta['og:title']) ?? cleanTitle(titleText);
  const description = meta['og:description'] ?? meta.description;
  if (title) info.title = title;
  if (description?.trim()) info.description = description.trim();
  const image = absoluteUrl(meta['og:image'], base);
  if (image) info.image = image.href;
  return { ...info, videos: found.videos };
}

/** Public view of a page video (no transcript text, no internal index). */
export function toDiscovered(v: PageVideo): DiscoveredVideo {
  const { transcript: _t, ldIndex: _i, author: _a, ...rest } = v;
  return rest;
}

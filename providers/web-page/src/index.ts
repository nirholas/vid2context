/**
 * Web pages with embedded video. Keyless; runs on Node and Workers.
 *
 * Input forms:
 *   page:<http(s) url>              a page whose embedded videos to list (kind 'page')
 *   page-video:<n>:<http(s) url>    the n-th JSON-LD VideoObject on that page (kind 'video'),
 *                                   produced by listItems when the page itself publishes a
 *                                   transcript for a video no other source understands
 *
 * Plain URLs are left alone on purpose: yt-dlp (a catch-all) already handles
 * any URL, including a page with a single embed. `discoverVideos(url, ctx)`
 * works on any URL for surfaces that want to offer a page's videos directly.
 *
 * A JSON-LD `transcript` is a native transcript. The `web-page-transcript`
 * captions provider returns it with origin 'native-transcript', one segment
 * per paragraph. Such text has no timings and none are invented: every
 * segment spans the whole video (0 to the duration) when the duration is
 * known, otherwise 0 to 0, and the producer is 'web-page-transcript/untimed'
 * so every surface can tell.
 */
import {
  type CaptionsProvider,
  type Ctx,
  defineProvider,
  type Registry,
  type Segment,
  type SourceProvider,
  type Transcript,
  Vid2ContextError,
  type VideoMetadata,
  type VideoRef,
} from '@vid2context/core';
import { matchLoom, matchVimeo, matchWistia } from '@vid2context/provider-native-transcripts';
import { matchYouTube } from '@vid2context/provider-youtube';
import { type DiscoveredVideo, discoverInHtml, type PageInfo, type PageVideo, toDiscovered } from './discover.ts';
import { cachedPage } from './fetch-page.ts';

export { type DiscoveredVideo, type DiscoverySource, discoverInHtml, isoDurationSec, type PageInfo } from './discover.ts';
export { assertPublicUrl, fetchPage, isPrivateHost, MAX_HTML_BYTES, MAX_REDIRECTS } from './fetch-page.ts';
export { classifyVideoUrl } from './platforms.ts';

const RUNTIMES: SourceProvider['runtimes'] = ['node', 'workers'];
const PAGE = /^page:(https?:\/\/\S+)$/i;
const PAGE_VIDEO = /^page-video:(\d{1,4}):(https?:\/\/\S+)$/i;

function pageUrl(raw: string): URL | null {
  try {
    const u = new URL(raw);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    u.hash = '';
    return u;
  } catch {
    return null;
  }
}

/** Match `page:<url>` and `page-video:<n>:<url>` only. */
export function matchPage(raw: string): VideoRef | null {
  const input = raw.trim();
  const page = PAGE.exec(input);
  if (page?.[1]) {
    const u = pageUrl(page[1]);
    return u ? { input, platform: 'web', kind: 'page', id: `web:page:${u.href}`, nativeId: u.href, url: u.href } : null;
  }
  const pv = PAGE_VIDEO.exec(input);
  if (pv?.[1] && pv[2]) {
    const u = pageUrl(pv[2]);
    const n = Number(pv[1]);
    return u
      ? { input, platform: 'web', kind: 'video', id: `web:page-video:${n}:${u.href}`, nativeId: `${n}:${u.href}`, url: u.href }
      : null;
  }
  return null;
}

const pageVideoInput = (n: number, url: string): string => `page-video:${n}:${url}`;

/** Split a page-video ref into its VideoObject index and page URL. */
function pageVideoParts(ref: VideoRef): { n: number; url: string } | null {
  const m = /^(\d+):(https?:\/\/.+)$/.exec(ref.nativeId);
  return ref.platform === 'web' && ref.kind === 'video' && m?.[1] && m[2] ? { n: Number(m[1]), url: m[2] } : null;
}

async function readPage(url: string, ctx: Ctx): Promise<PageInfo> {
  const page = await cachedPage(url, ctx);
  return discoverInHtml(page.html, page.url);
}

/**
 * Every video embedded in the page at `url`, de-duplicated, in page order.
 * Accepts a plain http(s) URL or the `page:` form.
 */
export async function discoverVideos(url: string, ctx: Ctx): Promise<DiscoveredVideo[]> {
  const raw = url.trim().replace(/^page:/i, '');
  return (await readPage(raw, ctx)).videos.map(toDiscovered);
}

/** How listItems turns a discovered input into a ref. `catchAll` marks answers from catch-all sources. */
export type ResolveInput = (input: string) => { ref: VideoRef; catchAll?: boolean } | null;

/** The platform matchers this package can reach without a registry: YouTube, Vimeo, Loom, Wistia. */
export const builtinResolve: ResolveInput = (input) => {
  for (const match of [matchYouTube, matchVimeo, matchLoom, matchWistia]) {
    const ref = match(input);
    if (ref) return { ref };
  }
  return null;
};

/** A resolver backed by a full registry (every installed source, catch-alls last), skipping this provider. */
export function registryResolve(registry: Registry): ResolveInput {
  return (input) => {
    try {
      const { source, ref } = registry.resolve(input);
      return source.id === 'web-page' ? null : { ref, catchAll: source.catchAll ?? false };
    } catch {
      return null;
    }
  };
}

function pageVideoMetadata(ref: VideoRef, v: PageVideo, info: PageInfo): VideoMetadata {
  return {
    ref,
    title: v.title ?? info.title ?? ref.url ?? ref.input,
    ...(v.author ? { channel: { name: v.author } } : {}),
    ...((v.description ?? info.description) ? { description: v.description ?? info.description } : {}),
    ...(v.durationSec !== undefined ? { durationSec: v.durationSec } : {}),
    ...(v.uploadDate ? { publishedAt: v.uploadDate } : {}),
    ...((v.thumbnailUrl ?? info.image) ? { thumbnailUrl: v.thumbnailUrl ?? info.image } : {}),
    ...((v.language ?? info.language) ? { language: v.language ?? info.language } : {}),
    chapters: [],
    extra: { pageUrl: ref.url, embed: v.input, discoveredBy: v.source },
  };
}

async function findPageVideo(ref: VideoRef, ctx: Ctx): Promise<{ video: PageVideo; info: PageInfo }> {
  const parts = pageVideoParts(ref);
  if (!parts) throw new Vid2ContextError('bad-request', `Not a page video ref: ${ref.id}`);
  const info = await readPage(parts.url, ctx);
  const video = info.videos.find((v) => v.ldIndex === parts.n);
  if (!video) {
    throw new Vid2ContextError('not-found', `The page no longer describes video ${parts.n}.`, {
      hint: `List the page again with page:${parts.url} to get current video inputs.`,
    });
  }
  return { video, info };
}

export interface WebPageSourceOptions {
  /** Resolve discovered inputs to refs. Default: the built-in YouTube, Vimeo, Loom and Wistia matchers. */
  resolve?: ResolveInput;
}

/**
 * Build the web-page source. The registry default-exports one made with the
 * built-in matchers; a surface holding a Registry can build one that resolves
 * through every installed source with `createWebPageSource({ resolve: registryResolve(registry) })`.
 */
export function createWebPageSource(opts: WebPageSourceOptions = {}): SourceProvider {
  const resolve = opts.resolve ?? builtinResolve;
  return defineProvider({
    id: 'web-page',
    kind: 'source',
    name: 'Web page videos',
    runtimes: RUNTIMES,
    match: matchPage,

    async getMetadata(ref, ctx) {
      if (ref.kind === 'video') {
        const { video, info } = await findPageVideo(ref, ctx);
        return pageVideoMetadata(ref, video, info);
      }
      const info = await readPage(ref.nativeId, ctx);
      return {
        ref,
        title: info.title ?? ref.nativeId,
        ...(info.description ? { description: info.description } : {}),
        ...(info.image ? { thumbnailUrl: info.image } : {}),
        ...(info.language ? { language: info.language } : {}),
        chapters: [],
        extra: { videos: info.videos.map(toDiscovered) },
      };
    },

    async *listItems(ref, ctx, listOpts = {}) {
      if (ref.kind !== 'page') return;
      const info = await readPage(ref.nativeId, ctx);
      const seen = new Set<string>();
      let n = 0;
      for (const v of info.videos) {
        if (listOpts.limit && n >= listOpts.limit) return;
        const hit = resolve(v.input);
        // Prefer the page's own transcript over a catch-all download when the page publishes one.
        let item: VideoRef | null = hit && !(hit.catchAll && v.transcript) ? hit.ref : null;
        if (!item && v.transcript && v.ldIndex !== undefined) item = matchPage(pageVideoInput(v.ldIndex, ref.nativeId));
        if (item?.kind !== 'video') {
          ctx.log.info('web-page: skipping a discovered video no source understands', {
            input: v.input,
            platform: v.platform,
            page: ref.nativeId,
          });
          continue;
        }
        if (seen.has(item.id)) continue;
        seen.add(item.id);
        n++;
        yield item;
      }
    },

    canProvideAudio: () => false,
  });
}

/** Paragraphs of an untimed transcript: blank-line separated, or line separated when there are no blank lines. */
export function paragraphs(text: string): string[] {
  const norm = text.replace(/\r\n?/g, '\n').trim();
  if (!norm) return [];
  const blocks = norm.split(/\n[ \t]*\n+/);
  const parts = blocks.length > 1 ? blocks : norm.split('\n');
  return parts.map((p) => p.replace(/\s+/g, ' ').trim()).filter(Boolean);
}

/** Segments from untimed text, one per paragraph, each spanning the whole video when its duration is known (else 0 to 0). */
export function untimedSegments(text: string, durationSec?: number): Segment[] {
  const end = durationSec && durationSec > 0 ? durationSec : 0;
  return paragraphs(text).map((p) => ({ startSec: 0, endSec: end, text: p }));
}

export const webPageSource: SourceProvider = createWebPageSource();

export const webPageTranscript: CaptionsProvider = defineProvider({
  id: 'web-page-transcript',
  kind: 'captions',
  name: 'Transcript published in the page (JSON-LD)',
  runtimes: RUNTIMES,
  supports: (ref) => pageVideoParts(ref) !== null,
  async listTracks(ref, ctx) {
    const { video, info } = await findPageVideo(ref, ctx);
    const language = video.language ?? info.language ?? 'und';
    return video.transcript ? [{ language, name: 'Page transcript', origin: 'native-transcript' }] : [];
  },
  async getCaptions(ref, opts, ctx): Promise<Transcript | null> {
    const { video, info } = await findPageVideo(ref, ctx);
    if (!video.transcript) return null;
    const language = video.language ?? info.language ?? 'und';
    if (opts.language && language !== 'und' && language.toLowerCase().split('-')[0] !== opts.language.toLowerCase().split('-')[0])
      return null;
    return {
      ref,
      language,
      origin: 'native-transcript',
      producer: 'web-page-transcript/untimed',
      segments: untimedSegments(video.transcript, video.durationSec),
      createdAt: new Date().toISOString(),
    };
  },
});

export default [webPageSource, webPageTranscript];

/**
 * Vimeo, keyless. Metadata comes from the public oEmbed endpoint and the
 * player config JSON that every embed loads; captions come from the config's
 * text_tracks (WebVTT files on captions.vimeo.com).
 *
 *   https://vimeo.com/api/oembed.json?url=<video url>
 *   https://player.vimeo.com/video/<id>/config[?h=<unlisted hash>]
 *
 * Track origin: provenance "user_uploaded" is a creator track; provenance
 * "ai_generated" or a language tag ending in "-x-autogen" is Vimeo's own
 * speech recognition (auto-captions).
 *
 * From datacenter IPs Vimeo answers the config request for many videos with
 * a 403 bot-check page; oEmbed still works there, so metadata falls back to
 * oEmbed alone and captions report `blocked`.
 */
import {
  type CaptionOptions,
  type CaptionTrackInfo,
  type Ctx,
  type Segment,
  Vid2ContextError,
  type VideoMetadata,
  type VideoRef,
} from '@vid2context/core';
import { baseTag, getText, langMatches, type TextResponse, tryJson } from './http.ts';
import { parseVtt } from './vtt.ts';

const ID = /^\d{1,12}$/;
const HASH = /^[0-9a-f]{6,}$/i;

function videoRef(input: string, id: string, hash?: string | null): VideoRef {
  return {
    input,
    platform: 'vimeo',
    kind: 'video',
    id: `vimeo:${id}`,
    nativeId: id,
    url: hash ? `https://vimeo.com/${id}/${hash}` : `https://vimeo.com/${id}`,
  };
}

function parseUrl(input: string): URL | null {
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(input) ? input : `https://${input}`;
  try {
    const url = new URL(withScheme);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url : null;
  } catch {
    return null;
  }
}

/**
 * Recognise Vimeo video URLs without network:
 *   vimeo.com/<id>                         public
 *   vimeo.com/<id>/<hash>                  unlisted
 *   player.vimeo.com/video/<id>[?h=<hash>] embed player
 *   vimeo.com/channels/<name>/<id>         channel video
 *   vimeo.com/groups/<name>/videos/<id>    group video
 *   vimeo.com/showcase/<sid>/video/<id>    showcase video (also album/<aid>/video/<id>)
 * Showcase, channel and user pages without a video id are lists and are left to other sources.
 */
export function matchVimeo(raw: string): VideoRef | null {
  const input = raw.trim();
  const url = parseUrl(input);
  if (!url) return null;
  const host = url.hostname.toLowerCase();
  const parts = url.pathname.split('/').filter(Boolean);
  const h = url.searchParams.get('h');
  const hashParam = h && HASH.test(h) ? h : null;

  if (host === 'player.vimeo.com') {
    const [first, id] = parts;
    return first === 'video' && id && ID.test(id) ? videoRef(input, id, hashParam) : null;
  }
  if (host !== 'vimeo.com' && host !== 'www.vimeo.com') return null;

  const [a, b, c, d] = parts;
  if (a && ID.test(a)) {
    if (parts.length === 1) return videoRef(input, a, hashParam);
    if (parts.length === 2 && b && HASH.test(b)) return videoRef(input, a, b);
    return null;
  }
  if (a === 'channels' && b && c && ID.test(c) && parts.length === 3) return videoRef(input, c, hashParam);
  if (a === 'groups' && b && c === 'videos' && d && ID.test(d) && parts.length === 4) return videoRef(input, d, hashParam);
  if ((a === 'showcase' || a === 'album') && b && c === 'video' && d && ID.test(d) && parts.length === 4) {
    return videoRef(input, d, hashParam);
  }
  return null;
}

/** The unlisted hash carried in a ref's URL, if any. */
function hashOf(ref: VideoRef): string | undefined {
  const m = /^https:\/\/vimeo\.com\/\d+\/([0-9a-f]+)$/i.exec(ref.url ?? '');
  return m?.[1];
}

export interface VimeoTextTrack {
  id: number;
  lang: string;
  url: string;
  kind?: string;
  label?: string;
  provenance?: string;
  default?: boolean;
}

export interface VimeoConfig {
  view?: number;
  video?: {
    id: number;
    title?: string;
    duration?: number;
    url?: string;
    share_url?: string;
    privacy?: string;
    embed_permission?: string;
    thumbnail_url?: string;
    locale?: string;
    live_event?: unknown;
    owner?: { id?: number; name?: string; url?: string; account_type?: string };
  };
  request?: { lang?: string; text_tracks?: VimeoTextTrack[] };
}

export interface VimeoOembed {
  title?: string;
  author_name?: string;
  author_url?: string;
  account_type?: string;
  duration?: number;
  description?: string;
  thumbnail_url?: string;
  upload_date?: string;
  video_id?: number;
  width?: number;
  height?: number;
}

const configUrl = (ref: VideoRef): string => {
  const hash = hashOf(ref);
  return `https://player.vimeo.com/video/${ref.nativeId}/config${hash ? `?h=${hash}` : ''}`;
};
const oembedUrl = (ref: VideoRef): string =>
  `https://vimeo.com/api/oembed.json?url=${encodeURIComponent(ref.url ?? `https://vimeo.com/${ref.nativeId}`)}`;

const isBotCheck = (res: TextResponse): boolean =>
  res.status === 403 && /text\/html/i.test(res.contentType) && /having a little trouble|verify the security/i.test(res.body);

function blocked(ref: VideoRef): Vid2ContextError {
  return new Vid2ContextError('blocked', `Vimeo refused the player config for ${ref.url} with a bot check (HTTP 403).`, {
    status: 403,
    hint: 'Vimeo blocks many datacenter IPs for videos outside enterprise accounts. Run vid2context on your own machine, or let yt-dlp fetch the audio for speech-to-text.',
  });
}

function unavailable(ref: VideoRef, view: number | undefined): Vid2ContextError {
  return new Vid2ContextError(
    'unavailable',
    `Vimeo video ${ref.nativeId} is private or password-protected (player view ${view ?? 'unknown'}).`,
    {
      hint: 'Only public and unlisted Vimeo videos can be read without signing in. For an unlisted video, pass the full link with its hash (vimeo.com/<id>/<hash>).',
    },
  );
}

function notFound(ref: VideoRef): Vid2ContextError {
  return new Vid2ContextError('not-found', `Vimeo video ${ref.nativeId} does not exist.`, {
    status: 404,
    hint: 'Check the link; the video may have been deleted.',
  });
}

/**
 * Fetch and check the player config. Throws `not-found` (404), `blocked`
 * (bot check), `unavailable` (private or password: view is not 1) or
 * `upstream` for other failures.
 */
export async function getVimeoConfig(ref: VideoRef, ctx: Ctx): Promise<VimeoConfig> {
  const res = await getText(ctx, configUrl(ref));
  if (res.status === 404) throw notFound(ref);
  if (isBotCheck(res)) throw blocked(ref);
  if (res.status !== 200) {
    throw new Vid2ContextError('upstream', `Vimeo player config for ${ref.nativeId}: HTTP ${res.status}`, { status: res.status });
  }
  const cfg = tryJson<VimeoConfig>(res.body);
  if (!cfg) throw new Vid2ContextError('upstream', `Vimeo player config for ${ref.nativeId} was not JSON.`);
  // view 1 is "playable by anyone with the link"; private (2) and password (4) videos carry no title or tracks.
  if (cfg.view !== 1 || !cfg.video?.title) throw unavailable(ref, cfg.view);
  return cfg;
}

async function getOembed(ref: VideoRef, ctx: Ctx): Promise<{ status: number; data?: VimeoOembed }> {
  const res = await getText(ctx, oembedUrl(ref));
  return { status: res.status, data: res.status === 200 ? tryJson<VimeoOembed>(res.body) : undefined };
}

/** "2013-10-15 14:08:29" (oEmbed, no zone given) -> "2013-10-15T14:08:29". */
function oembedDate(s: string | undefined): string | undefined {
  const m = s ? /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})$/.exec(s) : null;
  return m ? `${m[1]}T${m[2]}` : undefined;
}

export async function vimeoMetadata(ref: VideoRef, ctx: Ctx): Promise<VideoMetadata> {
  const [oembed, config] = await Promise.all([
    getOembed(ref, ctx),
    getVimeoConfig(ref, ctx).then(
      (c) => ({ ok: true as const, c }),
      (err: unknown) => ({ ok: false as const, err }),
    ),
  ]);
  const o = oembed.data;
  if (!config.ok) {
    const err = config.err;
    // A private or deleted video stops here; a bot check still leaves oEmbed to describe a public video.
    if (!(err instanceof Vid2ContextError) || err.code !== 'blocked' || !o) throw err;
    ctx.log.info('vimeo: player config blocked, using oEmbed only', { id: ref.nativeId });
  }
  const v = config.ok ? config.c.video : undefined;
  const title = v?.title ?? o?.title;
  if (!title) throw notFound(ref);
  const ownerName = v?.owner?.name ?? o?.author_name;
  const ownerUrl = v?.owner?.url ?? o?.author_url;
  const extra: Record<string, unknown> = {};
  if (v?.privacy) extra.privacy = v.privacy;
  if (v?.embed_permission) extra.embedPermission = v.embed_permission;
  const accountType = v?.owner?.account_type ?? o?.account_type;
  if (accountType) extra.accountType = accountType;
  if (!config.ok) extra.configBlocked = true;
  return {
    ref,
    title,
    ...(ownerName
      ? {
          channel: {
            name: ownerName,
            ...(v?.owner?.id ? { id: String(v.owner.id) } : {}),
            ...(ownerUrl ? { url: ownerUrl } : {}),
          },
        }
      : {}),
    ...(o?.description ? { description: o.description } : {}),
    ...((v?.duration ?? o?.duration) ? { durationSec: v?.duration ?? o?.duration } : {}),
    ...(oembedDate(o?.upload_date) ? { publishedAt: oembedDate(o?.upload_date) } : {}),
    ...((v?.thumbnail_url ?? o?.thumbnail_url) ? { thumbnailUrl: v?.thumbnail_url ?? o?.thumbnail_url } : {}),
    chapters: [],
    ...(v?.live_event ? { isLive: true } : {}),
    ...(Object.keys(extra).length ? { extra } : {}),
  };
}

export function trackOrigin(t: VimeoTextTrack): 'creator-captions' | 'auto-captions' {
  return t.provenance === 'ai_generated' || /-x-autogen$/i.test(t.lang) ? 'auto-captions' : 'creator-captions';
}

export function vimeoTrackInfo(t: VimeoTextTrack): CaptionTrackInfo {
  return { language: baseTag(t.lang), name: t.label ?? t.lang, origin: trackOrigin(t) };
}

/**
 * Pick the track for the options.
 * With a language: a creator track in it, else (when allowed) an auto track in it, else none.
 * Without one: the video's locale is taken as the spoken language; a creator then an auto track
 * in it, then the track Vimeo marks default, then the first creator track, then the first auto track.
 */
export function chooseVimeoTrack(tracks: VimeoTextTrack[], opts: CaptionOptions, locale?: string): VimeoTextTrack | null {
  const allowAuto = opts.allowAuto ?? true;
  const usable = tracks.filter((t) => t.url && (allowAuto || trackOrigin(t) === 'creator-captions'));
  const creator = usable.filter((t) => trackOrigin(t) === 'creator-captions');
  const auto = usable.filter((t) => trackOrigin(t) === 'auto-captions');
  const inLang = (list: VimeoTextTrack[], lang: string) => list.find((t) => langMatches(t.lang, lang));
  if (opts.language) return inLang(creator, opts.language) ?? inLang(auto, opts.language) ?? null;
  if (locale) {
    const spoken = inLang(creator, locale) ?? inLang(auto, locale);
    if (spoken) return spoken;
  }
  return usable.find((t) => t.default) ?? creator[0] ?? auto[0] ?? null;
}

export async function vimeoTracks(ref: VideoRef, ctx: Ctx): Promise<CaptionTrackInfo[]> {
  const cfg = await getVimeoConfig(ref, ctx);
  return (cfg.request?.text_tracks ?? []).map(vimeoTrackInfo);
}

export async function vimeoCaptions(
  ref: VideoRef,
  opts: CaptionOptions,
  ctx: Ctx,
): Promise<{ track: VimeoTextTrack; segments: Segment[] } | null> {
  const cfg = await getVimeoConfig(ref, ctx);
  const track = chooseVimeoTrack(cfg.request?.text_tracks ?? [], opts, cfg.video?.locale);
  if (!track) return null;
  const res = await getText(ctx, track.url);
  if (res.status !== 200) {
    throw new Vid2ContextError(
      res.status === 404 ? 'not-found' : 'upstream',
      `Vimeo caption track ${track.id}: HTTP ${res.status}`,
      {
        status: res.status,
      },
    );
  }
  return { track, segments: parseVtt(res.body) };
}

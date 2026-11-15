/**
 * Direct media URLs: an http(s) link whose path ends in a media extension
 * (.mp3, .m4a, .mp4, ...). Runs on Node, Workers and the browser, so it only
 * uses `ctx.fetch` and no Node built-ins.
 *
 * Metadata comes from a HEAD request (a ranged GET of one byte when HEAD is
 * refused). Audio is downloaded through `ctx.fetch` with a size cap
 * (VID2CONTEXT_MAX_MEDIA_MB, default 200, or 64 on Workers whose isolates have
 * 128 MB in all) and handed to speech-to-text as is.
 *
 * Video URLs: on Node, `media-stream` (in @vid2context/provider-media-file)
 * extracts the audio with ffmpeg, so this provider leaves them to it. On
 * Workers and in the browser there is no ffmpeg, so only audio-sized video
 * files (25 MB, the common speech-to-text upload limit) are accepted.
 */
import {
  type AudioInput,
  type Ctx,
  defineProvider,
  type Env,
  errorFromResponse,
  fetchWithTimeout,
  type Runtime,
  type SourceProvider,
  Vid2ContextError,
  type VideoMetadata,
  type VideoRef,
} from '@vid2context/core';
import { sha256Hex } from './sha256.ts';

export { sha256Hex } from './sha256.ts';

export const AUDIO_EXTENSIONS: Record<string, string> = {
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.wav': 'audio/wav',
  '.flac': 'audio/flac',
  '.ogg': 'audio/ogg',
  '.opus': 'audio/opus',
};

export const VIDEO_EXTENSIONS: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.mkv': 'video/x-matroska',
};

/** Largest file handed to speech-to-text without ffmpeg: Groq's and OpenAI's 25 MB upload limit. */
export const AUDIO_SIZED_BYTES = 25 * 1024 * 1024;

const DEFAULT_MAX_MB = 200;
/** The download is held in memory; a Worker isolate has 128 MB for everything. */
const WORKERS_DEFAULT_MAX_MB = 64;

/** Lowercase extension of a URL's path ('.mp3'), ignoring query and fragment, or ''. */
export function urlExtension(url: string): string {
  let path: string;
  try {
    path = new URL(url).pathname;
  } catch {
    return '';
  }
  const m = /\.[a-z0-9]{1,5}$/i.exec(path);
  return m ? m[0].toLowerCase() : '';
}

/** Canonical form for ids: no fragment, lowercased scheme and host (URL does that), query kept. */
export function canonicalUrl(url: string): string {
  const u = new URL(url);
  u.hash = '';
  return u.href;
}

export function isVideoUrl(url: string): boolean {
  return urlExtension(url) in VIDEO_EXTENSIONS;
}

/** Ref for any http(s) media URL; shared with media-stream so ids are computed one way. */
export function mediaRef(input: string, url: string): VideoRef {
  const canonical = canonicalUrl(url);
  const nativeId = sha256Hex(canonical).slice(0, 32);
  return { input, platform: 'media', kind: 'video', id: `media:${nativeId}`, nativeId, url: canonical };
}

/** Recognise a direct media URL. Synchronous, no network. */
export function matchMediaUrl(raw: string): VideoRef | null {
  const input = raw.trim();
  if (!/^https?:\/\//i.test(input)) return null;
  const ext = urlExtension(input);
  if (!(ext in AUDIO_EXTENSIONS) && !(ext in VIDEO_EXTENSIONS)) return null;
  try {
    return mediaRef(input, input);
  } catch {
    return null;
  }
}

/** VID2CONTEXT_MAX_MEDIA_MB in bytes (default 200 MB, 64 MB on Workers). */
export function maxMediaBytes(env: Env, runtime: Runtime = 'node'): number {
  const mb = Number(env.VID2CONTEXT_MAX_MEDIA_MB);
  const fallback = runtime === 'workers' ? WORKERS_DEFAULT_MAX_MB : DEFAULT_MAX_MB;
  return Math.round((Number.isFinite(mb) && mb > 0 ? mb : fallback) * 1024 * 1024);
}

/** Decoded file name of a URL ('Discovery_-_Nice_to_be_in_orbit.mp3'), or 'media'. */
export function urlFileName(url: string): string {
  try {
    const last = new URL(url).pathname.split('/').filter(Boolean).pop() ?? '';
    return decodeURIComponent(last).replace(/[\\/:*?"<>|\p{Cc}]+/gu, '_') || 'media';
  } catch {
    return 'media';
  }
}

/** A readable title from a URL's file name: extension dropped, underscores become spaces. */
export function titleFromUrl(url: string): string {
  const name = urlFileName(url);
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  return stem.replace(/_+/g, ' ').trim() || name;
}

export interface MediaHead {
  status: number;
  sizeBytes?: number;
  contentType?: string;
  lastModified?: string;
  durationSec?: number;
  acceptRanges?: boolean;
  /** 'head' or 'range' (HEAD was refused and a one-byte GET answered instead). */
  via: 'head' | 'range';
}

function headerInfo(res: Response, via: MediaHead['via']): MediaHead {
  const h = res.headers;
  let size: number | undefined;
  const range = /\/(\d+)\s*$/.exec(h.get('content-range') ?? '');
  if (range?.[1]) size = Number(range[1]);
  else if (via === 'head' || res.status === 200) {
    const len = Number(h.get('content-length'));
    if (Number.isFinite(len) && len > 0) size = len;
  }
  const dur = Number(h.get('x-content-duration') ?? h.get('content-duration'));
  return {
    status: res.status,
    sizeBytes: size,
    contentType: h.get('content-type')?.split(';')[0]?.trim().toLowerCase() || undefined,
    lastModified: h.get('last-modified') ?? undefined,
    durationSec: Number.isFinite(dur) && dur > 0 ? dur : undefined,
    acceptRanges: h.get('accept-ranges')?.toLowerCase() === 'bytes',
    via,
  };
}

/** HEAD a media URL; when HEAD is refused or fails, ask for one byte with a ranged GET. */
export async function headMedia(url: string, ctx: Ctx): Promise<MediaHead> {
  try {
    const res = await fetchWithTimeout(ctx, url, { method: 'HEAD', redirect: 'follow' }, 20_000);
    if (res.ok) return headerInfo(res, 'head');
    if (res.status === 404 || res.status === 410) throw await errorFromResponse(res, 'media URL');
  } catch (err) {
    if (err instanceof Vid2ContextError) throw err;
    if (ctx.signal?.aborted) throw err;
    ctx.log.debug('HEAD failed, trying a ranged GET', { url, error: String(err) });
  }
  const res = await fetchWithTimeout(ctx, url, { headers: { range: 'bytes=0-0' }, redirect: 'follow' }, 20_000);
  if (!res.ok) throw await errorFromResponse(res, 'media URL');
  await res.body?.cancel().catch(() => {});
  return headerInfo(res, 'range');
}

const ACCEPTED_TYPES = /^(audio\/|video\/|application\/(octet-stream|ogg|mp4|x-matroska)$|binary\/octet-stream$)/;

/** True when a content type can be media (or says nothing useful). */
export function acceptableContentType(type: string | undefined): boolean {
  return !type || ACCEPTED_TYPES.test(type);
}

function tooLarge(size: number, cap: number, hint: string): Vid2ContextError {
  return new Vid2ContextError(
    'too-large',
    `The media is ${(size / 1048576).toFixed(1)} MB, over the ${(cap / 1048576).toFixed(0)} MB limit.`,
    {
      hint,
    },
  );
}

const CAP_HINT = 'Raise VID2CONTEXT_MAX_MEDIA_MB, or link a shorter or audio-only file.';

/**
 * Download a media URL through ctx.fetch, refusing anything over `maxBytes`
 * (checked against content-length first, then while streaming) and anything
 * that is clearly not media (an HTML page, JSON).
 */
export async function fetchMedia(
  url: string,
  ctx: Ctx,
  opts: { maxBytes: number; hint?: string; timeoutMs?: number },
): Promise<{ data: Uint8Array; contentType?: string }> {
  const res = await fetchWithTimeout(ctx, url, { redirect: 'follow' }, opts.timeoutMs ?? 10 * 60_000);
  if (!res.ok) throw await errorFromResponse(res, 'media URL');
  const contentType = res.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() || undefined;
  if (!acceptableContentType(contentType)) {
    await res.body?.cancel().catch(() => {});
    throw new Vid2ContextError('unavailable', `The URL returned ${contentType}, not audio or video.`, {
      hint: 'Link the media file itself, not the page that plays it.',
    });
  }
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > opts.maxBytes) {
    await res.body?.cancel().catch(() => {});
    throw tooLarge(declared, opts.maxBytes, opts.hint ?? CAP_HINT);
  }
  if (!res.body) return { data: new Uint8Array(await res.arrayBuffer()), contentType };
  const reader = res.body.getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > opts.maxBytes) {
      await reader.cancel().catch(() => {});
      throw tooLarge(total, opts.maxBytes, opts.hint ?? CAP_HINT);
    }
    parts.push(value);
  }
  const data = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    data.set(p, off);
    off += p.byteLength;
  }
  return { data, contentType };
}

function urlOf(ref: VideoRef): string {
  if (!ref.url) throw new Vid2ContextError('bad-request', `Media ref ${ref.id} has no URL.`);
  return ref.url;
}

/** MIME type for a media URL: from the extension, else the server's content type. */
export function mimeFor(url: string, contentType?: string): string {
  const ext = urlExtension(url);
  return (
    AUDIO_EXTENSIONS[ext] ??
    VIDEO_EXTENSIONS[ext] ??
    (contentType?.startsWith('audio/') ? contentType : 'application/octet-stream')
  );
}

/** Download a direct media URL as AudioInput bytes, with the given cap. Shared with media-stream. */
export async function mediaUrlAudio(ref: VideoRef, ctx: Ctx, maxBytes: number, hint?: string): Promise<AudioInput> {
  const url = urlOf(ref);
  const { data, contentType } = await fetchMedia(url, ctx, { maxBytes, hint });
  return { kind: 'bytes', data, mimeType: mimeFor(url, contentType), filename: urlFileName(url) };
}

export const mediaUrl: SourceProvider = defineProvider({
  id: 'media-url',
  kind: 'source',
  name: 'Direct media URL',
  runtimes: ['node', 'workers', 'browser'],
  match: matchMediaUrl,
  async getMetadata(ref, ctx): Promise<VideoMetadata> {
    const url = urlOf(ref);
    const head = await headMedia(url, ctx);
    if (!acceptableContentType(head.contentType)) {
      throw new Vid2ContextError('unavailable', `${url} is ${head.contentType}, not audio or video.`, {
        hint: 'Link the media file itself, not the page that plays it.',
      });
    }
    return {
      ref,
      title: titleFromUrl(url),
      durationSec: head.durationSec,
      chapters: [],
      extra: {
        url,
        fileName: urlFileName(url),
        sizeBytes: head.sizeBytes,
        contentType: head.contentType,
        lastModified: head.lastModified,
        isVideo: isVideoUrl(url),
      },
    };
  },
  // On Node, video URLs go to media-stream, which extracts the audio with ffmpeg.
  canProvideAudio: (ref, ctx) =>
    ref.platform === 'media' &&
    Boolean(ref.url) &&
    matchMediaUrl(ref.url ?? '') !== null &&
    !(ctx.runtime === 'node' && isVideoUrl(ref.url ?? '')),
  async getAudio(ref, ctx) {
    const url = urlOf(ref);
    const cap = maxMediaBytes(ctx.env, ctx.runtime);
    if (isVideoUrl(url)) {
      const limit = Math.min(cap, AUDIO_SIZED_BYTES);
      const hint =
        'Without ffmpeg only video files up to 25 MB can be transcribed. Run vid2context on Node with ffmpeg, or link the audio file.';
      const head = await headMedia(url, ctx).catch(() => null);
      if (head?.sizeBytes !== undefined && head.sizeBytes > limit) throw tooLarge(head.sizeBytes, limit, hint);
      return mediaUrlAudio(ref, ctx, limit, hint);
    }
    return mediaUrlAudio(ref, ctx, cap);
  },
});

export default mediaUrl;

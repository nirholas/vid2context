/**
 * Episode audio: the enclosure, downloaded through `ctx.fetch`. Redirects are
 * followed one hop at a time (up to 10) so tracking prefixes (op3.dev,
 * podtrac, chartable, pdst.fm and similar) work the same on every runtime and
 * every hop is visible in debug logs. Downloads are capped by
 * VID2CONTEXT_MAX_MEDIA_MB (default 200) and stop on abort.
 *
 * Some CDNs (Buzzsprout's CloudFront) refuse requests with no recognisable
 * User-Agent, so every request names vid2context.
 */
import { type AudioInput, type Ctx, type Env, errorFromResponse, fetchWithTimeout, Vid2ContextError } from '@vid2context/core';
import { USER_AGENT } from './feed.ts';

const DEFAULT_MAX_MB = 200;
const MAX_HOPS = 10;

/** VID2CONTEXT_MAX_MEDIA_MB in bytes (default 200 MB). */
export function maxMediaBytes(env: Env): number {
  const mb = Number(env.VID2CONTEXT_MAX_MEDIA_MB);
  return Math.round((Number.isFinite(mb) && mb > 0 ? mb : DEFAULT_MAX_MB) * 1024 * 1024);
}

const EXT_BY_MIME: Record<string, string> = {
  'audio/mpeg': '.mp3',
  'audio/mp3': '.mp3',
  'audio/mp4': '.m4a',
  'audio/x-m4a': '.m4a',
  'audio/m4a': '.m4a',
  'audio/aac': '.aac',
  'audio/x-aac': '.aac',
  'audio/ogg': '.ogg',
  'audio/opus': '.opus',
  'audio/wav': '.wav',
  'audio/x-wav': '.wav',
  'audio/flac': '.flac',
  'video/mp4': '.mp4',
  'video/x-m4v': '.m4v',
  'video/quicktime': '.mov',
  'video/webm': '.webm',
};

const MIME_BY_EXT: Record<string, string> = {
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.ogg': 'audio/ogg',
  '.oga': 'audio/ogg',
  '.opus': 'audio/opus',
  '.wav': 'audio/wav',
  '.flac': 'audio/flac',
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
};

function extOf(url: string): string {
  try {
    return /\.[a-z0-9]{2,5}$/i.exec(new URL(url).pathname)?.[0]?.toLowerCase() ?? '';
  } catch {
    return '';
  }
}

function cleanType(t: string | null | undefined): string | undefined {
  const v = t?.split(';')[0]?.trim().toLowerCase();
  return v || undefined;
}

/** MIME type for the audio: the enclosure's declared type, else the URL extension, else the server's type. */
export function audioMime(enclosureType: string | undefined, url: string, served?: string): string {
  const declared = cleanType(enclosureType);
  if (declared && (declared.startsWith('audio/') || declared.startsWith('video/')))
    return declared === 'audio/mp3' ? 'audio/mpeg' : declared;
  const byExt = MIME_BY_EXT[extOf(url)];
  if (byExt) return byExt;
  const s = cleanType(served);
  return s && (s.startsWith('audio/') || s.startsWith('video/')) ? s : 'audio/mpeg';
}

/** A file name with a real audio extension (OVH Whisper rejects files without one). */
export function audioFilename(urls: string[], mime: string): string {
  for (const u of urls) {
    try {
      const last = decodeURIComponent(new URL(u).pathname.split('/').filter(Boolean).pop() ?? '');
      const clean = last.replace(/[\\/:*?"<>|\p{Cc}]+/gu, '_');
      if (MIME_BY_EXT[extOf(`https://x/${clean}`)]) return clean;
    } catch {}
  }
  const stem =
    urls
      .map((u) => {
        try {
          return (new URL(u).pathname.split('/').filter(Boolean).pop() ?? '').replace(/\.[^.]*$/, '');
        } catch {
          return '';
        }
      })
      .find((s) => /^[\w.-]{1,80}$/.test(s)) ?? 'episode';
  return `${stem}${EXT_BY_MIME[mime] ?? '.mp3'}`;
}

function tooLarge(size: number, cap: number): Vid2ContextError {
  return new Vid2ContextError(
    'too-large',
    `The episode audio is ${(size / 1048576).toFixed(1)} MB, over the ${(cap / 1048576).toFixed(0)} MB limit.`,
    { hint: 'Raise VID2CONTEXT_MAX_MEDIA_MB, or use an episode with a native transcript.' },
  );
}

/** GET with redirects followed hop by hop. Returns the final response and every URL visited. */
export async function fetchFollowing(url: string, ctx: Ctx, timeoutMs = 10 * 60_000): Promise<{ res: Response; urls: string[] }> {
  const urls = [url];
  let current = url;
  for (let hop = 0; hop <= MAX_HOPS; hop++) {
    const res = await fetchWithTimeout(ctx, current, { redirect: 'manual', headers: { 'user-agent': USER_AGENT } }, timeoutMs);
    if (res.type === 'opaqueredirect') {
      // A runtime that hides redirect targets: let it follow them itself.
      const followed = await fetchWithTimeout(
        ctx,
        current,
        { redirect: 'follow', headers: { 'user-agent': USER_AGENT } },
        timeoutMs,
      );
      return { res: followed, urls };
    }
    const location = res.headers.get('location');
    if (res.status >= 300 && res.status < 400 && location) {
      await res.body?.cancel().catch(() => {});
      current = new URL(location, current).href;
      if (!/^https?:/i.test(current)) {
        throw new Vid2ContextError('unavailable', `The enclosure redirected to a non-http URL.`, {
          hint: 'Pass the episode audio URL directly.',
        });
      }
      urls.push(current);
      ctx.log.debug('enclosure redirect', { status: res.status, to: current });
      continue;
    }
    return { res, urls };
  }
  throw new Vid2ContextError('unavailable', `The enclosure redirected more than ${MAX_HOPS} times.`, {
    hint: 'Pass the final episode audio URL directly.',
  });
}

/** Download an enclosure as AudioInput bytes with the size cap. */
export async function downloadEnclosure(
  enclosure: { url: string; type?: string; length?: number },
  ctx: Ctx,
): Promise<AudioInput> {
  const cap = maxMediaBytes(ctx.env);
  if (enclosure.length && enclosure.length > cap) throw tooLarge(enclosure.length, cap);
  const { res, urls } = await fetchFollowing(enclosure.url, ctx);
  if (!res.ok) throw await errorFromResponse(res, 'podcast enclosure');
  const served = cleanType(res.headers.get('content-type'));
  if (served && /^(text\/html|application\/json|application\/xml|text\/xml)$/.test(served)) {
    await res.body?.cancel().catch(() => {});
    throw new Vid2ContextError('unavailable', `The enclosure returned ${served}, not audio.`, {
      hint: 'The host may be blocking downloads. Try again later or pass the audio URL directly.',
    });
  }
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > cap) {
    await res.body?.cancel().catch(() => {});
    throw tooLarge(declared, cap);
  }
  const parts: Uint8Array[] = [];
  let total = 0;
  if (res.body) {
    const reader = res.body.getReader();
    try {
      for (;;) {
        if (ctx.signal?.aborted) throw ctx.signal.reason ?? new DOMException('Aborted', 'AbortError');
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > cap) throw tooLarge(total, cap);
        parts.push(value);
      }
    } finally {
      await reader.cancel().catch(() => {});
    }
  } else {
    const buf = new Uint8Array(await res.arrayBuffer());
    if (buf.byteLength > cap) throw tooLarge(buf.byteLength, cap);
    parts.push(buf);
    total = buf.byteLength;
  }
  const data = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    data.set(p, off);
    off += p.byteLength;
  }
  const finalUrl = urls[urls.length - 1] ?? enclosure.url;
  const mimeType = audioMime(enclosure.type, enclosure.url, served ?? undefined);
  return { kind: 'bytes', data, mimeType, filename: audioFilename([enclosure.url, finalUrl], mimeType) };
}

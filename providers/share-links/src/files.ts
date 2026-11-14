/**
 * Shared file helpers: a cheap ranged GET that reads only headers, header
 * parsing (Content-Disposition, Content-Range) and mime types by extension.
 */
import { type Ctx, fetchWithTimeout, Vid2ContextError } from '@vid2context/core';

export const SHARE_HINT =
  'Make the link viewable by anyone with the link (Google Drive: Share > General access > Anyone with the link; ' +
  'Dropbox: Share > Copy link with "Anyone with this link can view"; OneDrive: Share > Anyone with the link can view), then retry.';

/** What a share link resolves to. */
export interface ResolvedFile {
  /** URL that returns the file bytes with a plain GET (no cookies, no extra headers). */
  downloadUrl: string;
  filename: string;
  sizeBytes?: number;
  mimeType?: string;
  durationSec?: number;
  extra?: Record<string, unknown>;
}

export const MIME_BY_EXT: Record<string, string> = {
  mp3: 'audio/mpeg',
  mpga: 'audio/mpeg',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  wav: 'audio/wav',
  flac: 'audio/flac',
  ogg: 'audio/ogg',
  oga: 'audio/ogg',
  opus: 'audio/opus',
  weba: 'audio/webm',
  webm: 'video/webm',
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  mov: 'video/quicktime',
  mkv: 'video/x-matroska',
  avi: 'video/x-msvideo',
};

/** Content types that say nothing about the file (Dropbox answers application/binary for everything). */
const GENERIC_TYPES = new Set([
  'application/binary',
  'application/octet-stream',
  'binary/octet-stream',
  'application/x-download',
]);

export function extOf(name: string): string {
  const m = /\.([A-Za-z0-9]{1,5})$/.exec(name);
  return m?.[1]?.toLowerCase() ?? '';
}

export function stripExt(name: string): string {
  const ext = extOf(name);
  return ext ? name.slice(0, name.length - ext.length - 1) || name : name;
}

/** The most specific mime type we know: the server's unless it is generic, else one from the file extension. */
export function bestMimeType(serverType: string | undefined, filename: string): string | undefined {
  const base = serverType?.split(';')[0]?.trim().toLowerCase();
  if (base && !GENERIC_TYPES.has(base)) return base;
  return MIME_BY_EXT[extOf(filename)] ?? base;
}

export function isMediaType(mime: string | undefined): boolean {
  return Boolean(mime && (mime.startsWith('audio/') || mime.startsWith('video/')));
}

/** Filename from a Content-Disposition header, preferring RFC 5987 `filename*`. Ignores Dropbox's "unspecified". */
export function dispositionFilename(header: string | null): string | undefined {
  if (!header) return undefined;
  const star = /filename\*\s*=\s*([^']*)'[^']*'([^;]+)/i.exec(header);
  const plain = /filename\s*=\s*"([^"]*)"/i.exec(header) ?? /filename\s*=\s*([^;]+)/i.exec(header);
  const raw = star?.[2]?.trim() ?? plain?.[1]?.trim();
  if (!raw || raw.toLowerCase() === 'unspecified') return undefined;
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

export interface Probe {
  status: number;
  contentType?: string;
  sizeBytes?: number;
  filename?: string;
  /** Host the request ended on after redirects (empty in replayed tests). */
  finalHost: string;
  /** Body text when the server answered HTML (an interstitial, login or error page) instead of the file. */
  html?: string;
}

/**
 * GET the URL asking for one byte, follow redirects, and keep only the
 * headers. HTML answers are read (they are error or confirmation pages);
 * file bodies are cancelled so nothing large is downloaded.
 */
export async function probe(ctx: Ctx, url: string, headers: Record<string, string> = {}): Promise<Probe> {
  const res = await fetchWithTimeout(ctx, url, { headers: { range: 'bytes=0-0', ...headers }, redirect: 'follow' }, 30_000);
  const contentType = res.headers.get('content-type') ?? undefined;
  const range = /\/(\d+)\s*$/.exec(res.headers.get('content-range') ?? '');
  const length = Number(res.headers.get('content-length'));
  const sizeBytes = range?.[1]
    ? Number(range[1])
    : res.status === 200 && Number.isFinite(length) && length > 0
      ? length
      : undefined;
  let finalHost = '';
  try {
    finalHost = res.url ? new URL(res.url).host : '';
  } catch {
    finalHost = '';
  }
  const out: Probe = {
    status: res.status,
    contentType,
    sizeBytes,
    filename: dispositionFilename(res.headers.get('content-disposition')),
    finalHost,
  };
  if (contentType?.toLowerCase().includes('text/html')) out.html = (await res.text()).slice(0, 200_000);
  else await res.body?.cancel().catch(() => undefined);
  return out;
}

/** Text of the first <title>, collapsed to one line. */
export function htmlTitle(html: string): string {
  return (/<title>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? '').replace(/\s+/g, ' ').trim();
}

export function httpError(service: string, status: number, what: string): Vid2ContextError {
  const msg = `${service} answered HTTP ${status} for ${what}.`;
  if (status === 404 || status === 410) {
    return new Vid2ContextError('not-found', msg, { status, hint: 'Check the link; the file may have been deleted or moved.' });
  }
  if (status === 401 || status === 403) {
    return new Vid2ContextError('unavailable', msg, { status, hint: SHARE_HINT });
  }
  if (status === 429) return new Vid2ContextError('rate-limited', msg, { status, hint: 'Wait a minute and retry.' });
  return new Vid2ContextError('upstream', msg, { status });
}

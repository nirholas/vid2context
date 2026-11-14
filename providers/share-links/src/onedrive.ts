/**
 * OneDrive and SharePoint.
 *
 * Personal OneDrive (1drv.ms, onedrive.live.com): personal accounts moved to
 * SharePoint storage in 2024, and the old anonymous api.onedrive.com shares
 * endpoint now answers 401. The OneDrive web viewer instead fetches an
 * anonymous "badger" token and reads the shared item from
 * my.microsoftpersonalcontent.com with `Prefer: autoredeem`; the item carries
 * a pre-authenticated `@content.downloadUrl` (valid for about an hour) that
 * needs no cookie or header, so speech-to-text rungs can download it.
 *
 * SharePoint (<tenant>.sharepoint.com/:v:/...): anonymous sharing links are
 * downloadable at <site>/_layouts/15/download.aspx?share=<token>, which also
 * needs no cookie.
 */
import { type Ctx, fetchWithTimeout, Vid2ContextError, type VideoRef } from '@vid2context/core';
import { bestMimeType, htmlTitle, httpError, probe, type ResolvedFile, SHARE_HINT } from './files.ts';
import { parseSharePoint } from './url.ts';

export const BADGER_TOKEN_URL = 'https://api-badgerp.svc.ms/v1.0/token';
/** The OneDrive web app's public client id, which the badger service issues anonymous tokens for. */
const BADGER_APP_ID = '5cbed6ac-a083-4e14-b191-b4ba07653de2';
export const SHARES_API = 'https://my.microsoftpersonalcontent.com/_api/v2.0/shares/';

/** Graph-style share id: "u!" + unpadded base64url of the share URL. */
export function encodeShareId(shareUrl: string): string {
  const bytes = new TextEncoder().encode(shareUrl);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return `u!${btoa(bin).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_')}`;
}

const tokens = new WeakMap<Ctx, Promise<string>>();

async function fetchBadgerToken(ctx: Ctx): Promise<string> {
  const res = await fetchWithTimeout(ctx, BADGER_TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ appId: BADGER_APP_ID }),
  });
  if (!res.ok) throw httpError('OneDrive token service', res.status, 'an anonymous viewer token');
  const json = (await res.json()) as { token?: string };
  if (!json.token) throw new Vid2ContextError('upstream', 'OneDrive token service returned no token.');
  return json.token;
}

function badgerToken(ctx: Ctx): Promise<string> {
  let pending = tokens.get(ctx);
  if (!pending) {
    pending = fetchBadgerToken(ctx);
    tokens.set(ctx, pending);
    pending.catch(() => tokens.delete(ctx));
  }
  return pending;
}

export interface DriveItem {
  name?: string;
  size?: number;
  createdDateTime?: string;
  lastModifiedDateTime?: string;
  '@content.downloadUrl'?: string;
  file?: { mimeType?: string };
  folder?: unknown;
  video?: { duration?: number; width?: number; height?: number };
  audio?: { duration?: number; title?: string; artist?: string };
  error?: { code?: string; message?: string };
}

async function resolvePersonal(ref: VideoRef, ctx: Ctx): Promise<ResolvedFile> {
  const shareUrl = ref.url ?? ref.input;
  const token = await badgerToken(ctx);
  const res = await fetchWithTimeout(ctx, `${SHARES_API}${encodeShareId(shareUrl)}/driveitem`, {
    headers: { authorization: `Badger ${token}`, prefer: 'autoredeem', accept: 'application/json' },
  });
  const item = (await res.json().catch(() => ({}))) as DriveItem;
  if (!res.ok) {
    const detail = item.error?.message ? `: ${item.error.message}` : '';
    if (res.status === 404) {
      throw new Vid2ContextError('not-found', `OneDrive share link not found${detail}`, {
        status: 404,
        hint: 'Check the link; the file may have been deleted or the link removed.',
      });
    }
    if (res.status === 403) {
      throw new Vid2ContextError('unavailable', `OneDrive refused the share link${detail}`, { status: 403, hint: SHARE_HINT });
    }
    throw httpError('OneDrive', res.status, 'the shared item');
  }
  if (item.folder) {
    throw new Vid2ContextError('unsupported-input', 'This OneDrive link points at a folder, not a file.', {
      hint: 'Share the recording itself (right-click the file > Share > Copy link).',
    });
  }
  const downloadUrl = item['@content.downloadUrl'];
  if (!downloadUrl) throw new Vid2ContextError('upstream', 'OneDrive returned the item without a download URL.');
  const filename = item.name ?? ref.nativeId;
  const durationMs = item.video?.duration ?? item.audio?.duration;
  return {
    downloadUrl,
    filename,
    sizeBytes: item.size,
    mimeType: bestMimeType(item.file?.mimeType, filename),
    durationSec: durationMs ? durationMs / 1000 : undefined,
    extra: {
      createdAt: item.createdDateTime,
      modifiedAt: item.lastModifiedDateTime,
      ...(item.video?.width ? { width: item.video.width, height: item.video.height } : {}),
    },
  };
}

/** download.aspx URL for a SharePoint sharing link. */
export function sharePointDownloadUrl(link: string): string | null {
  const sp = parseSharePoint(link);
  if (!sp) return null;
  const site = sp.sitePath ? `/${sp.sitePath}` : '';
  return `https://${sp.host}${site}/_layouts/15/download.aspx?share=${encodeURIComponent(sp.token)}`;
}

async function resolveSharePoint(ref: VideoRef, ctx: Ctx, downloadUrl: string): Promise<ResolvedFile> {
  const p = await probe(ctx, downloadUrl);
  if (p.status >= 400) throw httpError('SharePoint', p.status, `link ${ref.nativeId}`);
  if (p.html !== undefined) {
    throw new Vid2ContextError(
      'unavailable',
      `SharePoint returned a page instead of the file for link ${ref.nativeId}: ${htmlTitle(p.html) || 'unknown page'}.`,
      {
        hint:
          'The link has expired, was removed, or only works for signed-in members of that organization. ' +
          'Ask the owner for an "Anyone with the link" share, or download the recording and pass the local file.',
      },
    );
  }
  const filename = p.filename ?? ref.nativeId;
  return { downloadUrl, filename, sizeBytes: p.sizeBytes, mimeType: bestMimeType(p.contentType, filename) };
}

export function resolveOneDrive(ref: VideoRef, ctx: Ctx): Promise<ResolvedFile> {
  const sharePoint = sharePointDownloadUrl(ref.url ?? ref.input);
  return sharePoint ? resolveSharePoint(ref, ctx, sharePoint) : resolvePersonal(ref, ctx);
}

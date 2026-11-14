/**
 * Google Drive. The direct download endpoint is
 * drive.usercontent.google.com/download?id=<id>&export=download. Files Google
 * cannot virus-scan (roughly over 100 MB) answer with an HTML "Download
 * anyway" page instead; its #download-form carries the confirm token, and
 * submitting it (a GET with the hidden inputs) returns the file. Flow ported
 * from yt-dlp's GoogleDriveIE (Unlicense), see THIRD_PARTY_NOTICES.md.
 */
import { type Ctx, Vid2ContextError, type VideoRef } from '@vid2context/core';
import { bestMimeType, htmlTitle, httpError, type Probe, probe, type ResolvedFile, SHARE_HINT } from './files.ts';

const DOWNLOAD_URL = 'https://drive.usercontent.google.com/download';

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

/** The "Download anyway" form on the virus-scan warning page, as a GET URL. Null when the page has no such form. */
export function confirmUrlFromInterstitial(html: string): string | null {
  const form = /<form[^>]*id="download-form"[^>]*>([\s\S]*?)<\/form>/i.exec(html);
  if (!form) return null;
  const action = /action="([^"]+)"/i.exec(form[0])?.[1];
  if (!action) return null;
  const url = new URL(decodeEntities(action));
  for (const input of form[1]?.matchAll(/<input[^>]*type="hidden"[^>]*>/gi) ?? []) {
    const name = /name="([^"]*)"/i.exec(input[0])?.[1];
    const value = /value="([^"]*)"/i.exec(input[0])?.[1] ?? '';
    if (name) url.searchParams.set(decodeEntities(name), decodeEntities(value));
  }
  return url.href;
}

function htmlError(p: Probe, id: string): Vid2ContextError {
  const html = p.html ?? '';
  if (p.finalHost === 'accounts.google.com' || /ServiceLogin|accounts\.google\.com/.test(html.slice(0, 5000))) {
    return new Vid2ContextError('unavailable', `Google Drive file ${id} needs a signed-in account.`, { hint: SHARE_HINT });
  }
  const caption = /class="uc-error-(?:sub)?caption"[^>]*>([\s\S]*?)<\/p>/i
    .exec(html)?.[1]
    ?.replace(/<[^>]+>/g, '')
    .trim();
  if (caption && /too many users|quota/i.test(caption)) {
    return new Vid2ContextError('unavailable', `Google Drive file ${id}: ${caption}`, {
      hint: 'Google limits downloads of popular shared files for 24 hours. Retry later, or ask the owner for a copy on another service.',
    });
  }
  return new Vid2ContextError(
    'unavailable',
    `Google Drive returned a page instead of file ${id}: ${caption || htmlTitle(html) || 'unknown page'}.`,
    {
      hint: SHARE_HINT,
    },
  );
}

export async function resolveDrive(ref: VideoRef, ctx: Ctx): Promise<ResolvedFile> {
  const id = ref.nativeId;
  const url = new URL(DOWNLOAD_URL);
  url.searchParams.set('id', id);
  url.searchParams.set('export', 'download');
  const resourceKey = ref.url ? new URL(ref.url).searchParams.get('resourcekey') : null;
  if (resourceKey) url.searchParams.set('resourcekey', resourceKey);

  let downloadUrl = url.href;
  let p = await probe(ctx, downloadUrl);
  if (p.status === 404) {
    throw new Vid2ContextError('not-found', `Google Drive has no file ${id} that is shared publicly.`, {
      status: 404,
      hint: `Check the link. If the file exists, it is not shared: ${SHARE_HINT}`,
    });
  }
  if (p.status >= 400) throw httpError('Google Drive', p.status, `file ${id}`);
  if (p.html !== undefined) {
    const confirmed = confirmUrlFromInterstitial(p.html);
    if (!confirmed) throw htmlError(p, id);
    ctx.log.debug('google drive: following the virus-scan confirmation', { id });
    downloadUrl = confirmed;
    p = await probe(ctx, downloadUrl);
    if (p.status >= 400) throw httpError('Google Drive', p.status, `file ${id}`);
    if (p.html !== undefined) throw htmlError(p, id);
  }
  const filename = p.filename ?? id;
  return {
    downloadUrl,
    filename,
    sizeBytes: p.sizeBytes,
    mimeType: bestMimeType(p.contentType, filename),
  };
}

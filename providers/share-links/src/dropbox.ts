/**
 * Dropbox. A share link with dl=1 redirects to the file on
 * dl.dropboxusercontent.com; anything else (a deleted, private, disabled or
 * rlkey-less link) ends on an HTML page whose title says why. Dropbox labels
 * every file application/binary, so the type comes from the file extension.
 */
import { type Ctx, Vid2ContextError, type VideoRef } from '@vid2context/core';
import { bestMimeType, htmlTitle, httpError, probe, type ResolvedFile, SHARE_HINT } from './files.ts';

/** The share link with dl=1, which Dropbox answers with a redirect to the file itself. */
export function dropboxDownloadUrl(ref: VideoRef): string {
  const url = new URL(ref.url ?? ref.input);
  url.searchParams.delete('raw');
  url.searchParams.set('dl', '1');
  return url.href;
}

function nameFromUrl(link: string): string | undefined {
  const last = new URL(link).pathname.split('/').filter(Boolean).pop();
  if (!last) return undefined;
  try {
    return decodeURIComponent(last);
  } catch {
    return last;
  }
}

export async function resolveDropbox(ref: VideoRef, ctx: Ctx): Promise<ResolvedFile> {
  const downloadUrl = dropboxDownloadUrl(ref);
  const p = await probe(ctx, downloadUrl);
  if (p.status >= 400) throw httpError('Dropbox', p.status, `link ${ref.nativeId}`);
  if (p.html !== undefined) {
    const title = htmlTitle(p.html);
    const msg = `Dropbox returned a page instead of the file for link ${ref.nativeId}: ${title || 'unknown page'}.`;
    if (/invalid link|error|not found|deleted/i.test(title)) {
      throw new Vid2ContextError('not-found', msg, {
        hint: 'Check the link; the file may have been deleted or the link revoked.',
      });
    }
    if (/disabled|banned|traffic/i.test(title)) {
      throw new Vid2ContextError('unavailable', msg, {
        hint: 'Dropbox disabled this link for now, usually because of too much traffic. Retry later or ask the owner for a new link.',
      });
    }
    if (/log in|sign in/i.test(title)) {
      const missingKey = /\/scl\/fi\//.test(downloadUrl) && !new URL(downloadUrl).searchParams.has('rlkey');
      throw new Vid2ContextError('unavailable', msg, {
        hint: missingKey ? 'Paste the whole link, including its rlkey= parameter.' : SHARE_HINT,
      });
    }
    throw new Vid2ContextError('unavailable', msg, { hint: SHARE_HINT });
  }
  const filename = p.filename ?? nameFromUrl(downloadUrl) ?? ref.nativeId;
  return { downloadUrl, filename, sizeBytes: p.sizeBytes, mimeType: bestMimeType(p.contentType, filename) };
}

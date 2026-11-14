/**
 * Cloud share links as a source: Google Drive, Dropbox, OneDrive and
 * SharePoint. Metadata comes from the file itself (name, size, type, read
 * from headers of a one-byte ranged GET, or from OneDrive's item JSON);
 * audio is handed to speech-to-text as a direct download URL that needs no
 * cookie or header, so any rung can fetch it. Plain fetch: Node and Workers.
 * (Browsers cannot read these responses across origins, so no browser build.)
 */
import { type Ctx, defineProvider, type SourceProvider, Vid2ContextError, type VideoRef } from '@vid2context/core';
import { resolveDropbox } from './dropbox.ts';
import { isMediaType, type ResolvedFile, stripExt } from './files.ts';
import { resolveDrive } from './gdrive.ts';
import { resolveOneDrive } from './onedrive.ts';
import { matchShareLink, SHARE_PLATFORMS, type SharePlatform } from './url.ts';

export { dropboxDownloadUrl } from './dropbox.ts';
export { dispositionFilename, type ResolvedFile } from './files.ts';
export { confirmUrlFromInterstitial } from './gdrive.ts';
export { encodeShareId, sharePointDownloadUrl } from './onedrive.ts';
export { matchShareLink, parseSharePoint, type SharePlatform } from './url.ts';

const MB = 1024 * 1024;
/** Default upload cap: 25 MB, what Groq's free tier and OpenAI accept per file. */
export const DEFAULT_MAX_MB = 25;

const SERVICE: Record<SharePlatform, string> = { gdrive: 'Google Drive', dropbox: 'Dropbox', onedrive: 'OneDrive' };

function isShareRef(ref: VideoRef): boolean {
  return (SHARE_PLATFORMS as readonly string[]).includes(ref.platform);
}

function resolveUncached(ref: VideoRef, ctx: Ctx): Promise<ResolvedFile> {
  if (ref.platform === 'gdrive') return resolveDrive(ref, ctx);
  if (ref.platform === 'dropbox') return resolveDropbox(ref, ctx);
  if (ref.platform === 'onedrive') return resolveOneDrive(ref, ctx);
  return Promise.reject(new Vid2ContextError('bad-request', `share-links cannot resolve ${ref.platform} refs.`));
}

/**
 * One resolution per link per Ctx: the pipeline calls getMetadata and then
 * getAudio with the same ctx, so the second call costs nothing, while a new
 * request always sees fresh (and unexpired) download URLs.
 */
const perCtx = new WeakMap<Ctx, Map<string, Promise<ResolvedFile>>>();

export function resolveShareLink(ref: VideoRef, ctx: Ctx): Promise<ResolvedFile> {
  let cache = perCtx.get(ctx);
  if (!cache) {
    cache = new Map();
    perCtx.set(ctx, cache);
  }
  let pending = cache.get(ref.id);
  if (!pending) {
    pending = resolveUncached(ref, ctx);
    cache.set(ref.id, pending);
    pending.catch(() => cache.delete(ref.id));
  }
  return pending;
}

/** SHARE_LINKS_MAX_MB, or 25. */
export function maxAudioBytes(ctx: Ctx): number {
  const mb = Number(ctx.env.SHARE_LINKS_MAX_MB);
  return (Number.isFinite(mb) && mb > 0 ? mb : DEFAULT_MAX_MB) * MB;
}

export const shareLinks: SourceProvider = defineProvider({
  id: 'share-links',
  kind: 'source',
  name: 'Cloud share links (Google Drive, Dropbox, OneDrive)',
  runtimes: ['node', 'workers'],
  match: matchShareLink,
  async getMetadata(ref, ctx) {
    const file = await resolveShareLink(ref, ctx);
    return {
      ref,
      title: stripExt(file.filename),
      chapters: [],
      ...(file.durationSec ? { durationSec: file.durationSec } : {}),
      extra: {
        service: SERVICE[ref.platform as SharePlatform],
        filename: file.filename,
        ...(file.sizeBytes !== undefined ? { sizeBytes: file.sizeBytes } : {}),
        ...(file.mimeType ? { mimeType: file.mimeType } : {}),
        ...file.extra,
      },
    };
  },
  canProvideAudio: (ref) => isShareRef(ref) && ref.kind === 'video',
  async getAudio(ref, ctx) {
    const file = await resolveShareLink(ref, ctx);
    if (!isMediaType(file.mimeType)) {
      throw new Vid2ContextError(
        'unsupported-input',
        `"${file.filename}" is not an audio or video file (${file.mimeType ?? 'unknown type'}).`,
        { hint: 'Share the recording itself (an audio or video file such as .mp3, .m4a, .wav or .mp4).' },
      );
    }
    const limit = maxAudioBytes(ctx);
    if (file.sizeBytes !== undefined && file.sizeBytes > limit) {
      const mb = (n: number) => `${(n / MB).toFixed(1)} MB`;
      throw new Vid2ContextError(
        'too-large',
        `"${file.filename}" is ${mb(file.sizeBytes)}; speech-to-text uploads are capped at ${mb(limit)}.`,
        {
          hint:
            'Long-audio splitting (roadmap item 04) does not cover remote share links yet. Until it does: share an ' +
            'audio-only export (a 1-hour mono MP3 at 48 kbps is about 21 MB), download the file and pass the local path, ' +
            'or set SHARE_LINKS_MAX_MB higher if your speech-to-text rung accepts larger uploads.',
        },
      );
    }
    return {
      kind: 'url',
      url: file.downloadUrl,
      ...(file.mimeType ? { mimeType: file.mimeType } : {}),
      ...(file.durationSec ? { durationSec: file.durationSec } : {}),
    };
  },
});

export default shareLinks;

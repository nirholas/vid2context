/**
 * yt-dlp source and captions. Node only (spawns a binary, writes temp files).
 *
 * `ytdlp` is a catch-all source: any http(s) URL that no specific provider
 * claims resolves here, to metadata, playlist items, comments and 16 kHz mono
 * mp3 audio for speech-to-text. It also supplies audio for YouTube refs, whose
 * own provider downloads no media. `ytdlp-captions` reads creator and
 * automatic subtitles for any such URL, and for YouTube it runs after
 * `youtube-captions` as a fallback.
 */
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type CaptionsProvider, defineProvider, type SourceProvider, Vid2ContextError, type VideoRef } from '@vid2context/core';
import { audioArgs, commentsArgs, playlistArgs } from './args.ts';
import { getCaptions, listTracks } from './captions.ts';
import { entryRef, toComments, toMetadata, type YtDlpInfo } from './info.ts';
import { matchUrl } from './refs.ts';
import { fetchInfo, parseJson, prepare, urlOf, withFallbackUrl, workingUrl, ytdlp } from './run.ts';

export { audioArgs, commentsArgs, metadataArgs, playlistArgs, safeUrl, subtitleArgs } from './args.ts';
export { ensureYtDlp, type JsRuntime, type YtDlpInfo as YtDlpBinary } from './binary.ts';
export { chooseSubtitle } from './captions.ts';
export { errorFromStderr } from './errors.ts';
export { toComments, toMetadata } from './info.ts';
export { matchUrl } from './refs.ts';
export { parseVtt } from './vtt.ts';

const DEFAULT_COMMENTS = 100;

const isWebVideo = (ref: VideoRef): boolean => ref.kind === 'video' && /^https?:\/\//i.test(ref.url ?? '');

function* flatten(entries: (YtDlpInfo | null)[] | null | undefined): Generator<YtDlpInfo> {
  for (const e of entries ?? []) {
    if (!e) continue;
    if (e._type === 'playlist' && e.entries) yield* flatten(e.entries);
    else yield e;
  }
}

export const ytdlpSource: SourceProvider = defineProvider({
  id: 'ytdlp',
  kind: 'source',
  name: 'yt-dlp (any site)',
  runtimes: ['node'],
  catchAll: true,
  match: matchUrl,

  async getMetadata(ref, ctx) {
    const { info } = await fetchInfo(ref, ctx);
    return toMetadata(ref, info);
  },

  async *listItems(ref, ctx, opts = {}) {
    const { bin, cfg } = await prepare(ctx);
    const info = await withFallbackUrl(ctx, urlOf(ref), async (u) =>
      parseJson(await ytdlp(ctx, bin.path, playlistArgs(u, cfg, opts.limit), 'playlist'), 'yt-dlp playlist'),
    );
    let n = 0;
    if (!info.entries) {
      // Not a list after all: yt-dlp returned a single video.
      const single = entryRef({ ...info, webpage_url: info.webpage_url ?? ref.url });
      if (single) yield { ...single, kind: 'video' };
      return;
    }
    for (const entry of flatten(info.entries)) {
      const item = entryRef(entry);
      if (!item) continue;
      yield item;
      n++;
      if (opts.limit && n >= opts.limit) return;
    }
  },

  async getComments(ref, ctx, opts = {}) {
    const limit = opts.limit && opts.limit > 0 ? opts.limit : DEFAULT_COMMENTS;
    const { bin, cfg } = await prepare(ctx);
    const url = await workingUrl(ref, ctx);
    const info = await withFallbackUrl(ctx, url, async (u) =>
      parseJson(await ytdlp(ctx, bin.path, commentsArgs(u, cfg, limit), 'comments'), 'yt-dlp comments'),
    );
    return toComments(info.comments ?? [], limit);
  },

  canProvideAudio: isWebVideo,

  async getAudio(ref, ctx) {
    const { bin, cfg } = await prepare(ctx);
    if (!cfg.ffmpeg) {
      throw new Vid2ContextError('no-provider', 'yt-dlp needs ffmpeg to extract audio, and none was found.', {
        hint: 'Install ffmpeg (apt install ffmpeg, brew install ffmpeg), put it in ~/.local/bin, or set FFMPEG_PATH. The ffmpeg package can also manage a copy in .vid2context/bin/.',
      });
    }
    const url = await workingUrl(ref, ctx);
    const dir = await mkdtemp(join(tmpdir(), 'vid2context-ytdlp-audio-'));
    try {
      const stdout = await withFallbackUrl(ctx, url, (u) =>
        ytdlp(ctx, bin.path, audioArgs(u, cfg, join(dir, 'audio.%(ext)s')), 'audio', dir),
      );
      const file = (await readdir(dir)).find((f) => f.endsWith('.mp3'));
      if (!file) {
        throw new Vid2ContextError('upstream', 'yt-dlp finished but wrote no mp3 file.', {
          hint: 'Check that ffmpeg works (ffmpeg -version) and retry.',
        });
      }
      const data = new Uint8Array(await readFile(join(dir, file)));
      const duration = Number(stdout.trim().split('\n').at(-1));
      return {
        kind: 'bytes',
        data,
        mimeType: 'audio/mpeg',
        filename: `${ref.nativeId}.mp3`,
        ...(Number.isFinite(duration) && duration > 0 ? { durationSec: duration } : {}),
      };
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
});

export const ytdlpCaptions: CaptionsProvider = defineProvider({
  id: 'ytdlp-captions',
  kind: 'captions',
  name: 'yt-dlp subtitles',
  runtimes: ['node'],
  supports: isWebVideo,
  async listTracks(ref, ctx) {
    return listTracks((await fetchInfo(ref, ctx)).info);
  },
  getCaptions,
});

export default [ytdlpSource, ytdlpCaptions];

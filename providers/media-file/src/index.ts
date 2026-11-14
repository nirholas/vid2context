/**
 * Local media files. Node only (reads the filesystem, runs ffmpeg).
 *
 * Matches absolute and relative paths, ~/ paths and file:// URLs. A bare name
 * only matches when it has a media extension, so it never shadows a YouTube
 * id. The ref id is a sha256 of the absolute path, size and mtime, so editing
 * or replacing the file produces a new id and never serves a stale cache.
 *
 * With ffmpeg installed, metadata comes from ffprobe (title tag, duration,
 * container chapters, audio language) and video files have their audio
 * extracted as 16 kHz mono mp3 before speech-to-text. Without ffmpeg, audio
 * files still work (raw bytes, as before) and video files fail with a hint.
 *
 * This package also exports the `media-file-captions` provider (sidecar and
 * embedded subtitles) and `media-stream` (HLS, DASH and video URLs through
 * ffmpeg), both Node only like this one.
 */
import { statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { basename, extname } from 'node:path';
import { type AudioInput, defineProvider, type SourceProvider, Vid2ContextError, type VideoMetadata } from '@vid2context/core';
import { extractAudio, type FfmpegTools, hasVideo, locateFfmpeg, tryLocateFfmpeg } from '@vid2context/ffmpeg';
import { mediaFileCaptions } from './captions.ts';
import {
  isoDate,
  MIME_BY_EXT,
  matchFile,
  PASSTHROUGH_MAX_BYTES,
  pathOf,
  probeIfAvailable,
  STT_READY_EXT,
  stemOf,
} from './files.ts';
import { mediaStream } from './stream.ts';

export { findSidecars, mediaFileCaptions, type SubtitleTrack } from './captions.ts';
export {
  fileId,
  MIME_BY_EXT,
  matchFile,
  PASSTHROUGH_MAX_BYTES,
  pathOf,
  probeIfAvailable,
} from './files.ts';
export { type HlsInfo, matchStream, mediaStream, parseDashManifest, parseHlsPlaylist } from './stream.ts';
export { parseSubtitles, parseTimestamp } from './subtitles.ts';

async function rawBytes(path: string, durationSec?: number): Promise<AudioInput> {
  const data = new Uint8Array(await readFile(path));
  return {
    kind: 'bytes',
    data,
    mimeType: MIME_BY_EXT[extname(path).toLowerCase()] ?? 'application/octet-stream',
    filename: basename(path),
    ...(durationSec ? { durationSec } : {}),
  };
}

export const mediaFile: SourceProvider = defineProvider({
  id: 'media-file',
  kind: 'source',
  name: 'Local media file',
  runtimes: ['node'],
  match: matchFile,
  async getMetadata(ref, ctx): Promise<VideoMetadata> {
    const path = pathOf(ref);
    const st = statSync(path);
    const base = { path, sizeBytes: st.size, modifiedAt: st.mtime.toISOString() };
    const p = await probeIfAvailable(path, ctx);
    if (!p) {
      return {
        ref,
        title: stemOf(path),
        chapters: [],
        extra: { ...base, ffmpeg: 'not found; metadata from the filesystem only' },
      };
    }
    const audio = p.streams.find((s) => s.type === 'audio');
    const artist = p.tags.artist?.trim() || p.tags.album_artist?.trim();
    const description = p.tags.comment?.trim() || p.tags.description?.trim();
    const meta: VideoMetadata = {
      ref,
      title: p.tags.title?.trim() || stemOf(path),
      chapters: p.chapters.map((c) => ({
        title: c.title,
        startSec: c.startSec,
        ...(c.endSec !== undefined ? { endSec: c.endSec } : {}),
      })),
      extra: {
        ...base,
        container: p.container,
        hasVideo: hasVideo(p),
        streams: p.streams.map((s) => ({
          index: s.index,
          type: s.type,
          codec: s.codec,
          ...(s.language ? { language: s.language } : {}),
          ...(s.channels ? { channels: s.channels } : {}),
          ...(s.sampleRate ? { sampleRate: s.sampleRate } : {}),
          ...(s.width ? { width: s.width, height: s.height } : {}),
          ...(s.title ? { title: s.title } : {}),
        })),
      },
    };
    if (p.durationSec !== undefined) meta.durationSec = p.durationSec;
    if (audio?.language) meta.language = audio.language;
    if (artist) meta.channel = { name: artist };
    if (description) meta.description = description;
    const date = isoDate(p.tags.date);
    if (date) meta.publishedAt = date;
    return meta;
  },
  canProvideAudio: (ref) => ref.platform === 'file',
  async getAudio(ref, ctx) {
    const path = pathOf(ref);
    const ext = extname(path).toLowerCase();
    const size = statSync(path).size;
    const installed = await tryLocateFfmpeg(ctx);
    const p = installed ? await probeIfAvailable(path, ctx) : null;
    const isVideo = p ? hasVideo(p) : (MIME_BY_EXT[ext]?.startsWith('video/') ?? false);

    if (!isVideo && STT_READY_EXT.has(ext) && size <= PASSTHROUGH_MAX_BYTES) return rawBytes(path, p?.durationSec);

    let tools: FfmpegTools | null = installed;
    let missing: unknown;
    if (!tools) {
      tools = await locateFfmpeg(ctx, { download: true }).catch((err: unknown) => {
        missing = err;
        return null;
      });
    }
    if (!tools) {
      if (!isVideo) {
        ctx.log.info('ffmpeg not found; sending the audio file as is', { path });
        return rawBytes(path);
      }
      const hint = missing instanceof Vid2ContextError ? missing.hint : undefined;
      throw new Vid2ContextError(
        'unavailable',
        `Video files need ffmpeg to extract the audio, and none was found (${missing instanceof Error ? missing.message : 'not found'}).`,
        { hint: hint ?? 'Install ffmpeg, or set FFMPEG_PATH and FFPROBE_PATH.', cause: missing },
      );
    }
    return extractAudio(path, { format: 'mp3', name: stemOf(path) }, ctx);
  },
});

export default [mediaFile, mediaFileCaptions, mediaStream];

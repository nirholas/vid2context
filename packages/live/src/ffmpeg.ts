/**
 * The Node audio extractor for live chunks, built on @vid2context/ffmpeg
 * (prompt 12): it finds ffmpeg (FFMPEG_PATH, PATH, ~/.local/bin, the managed
 * copy) and runs it safely. A chunk's media segments are written to one
 * private temp file, and ffmpeg cuts the chunk's span out of it as 16 kHz
 * mono 16-bit WAV. The temp directory is removed after every chunk.
 */
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { type Env, Vid2ContextError } from '@vid2context/core';
import { extractAudio, findTools, locateFfmpeg, withTempDir } from '@vid2context/ffmpeg';
import type { AudioExtractor, ChunkMedia } from './types.ts';

/** Synchronous check (no spawn): true when ffmpeg and ffprobe are installed where @vid2context/ffmpeg looks. */
export function ffmpegAvailable(env: Env): boolean {
  const found = findTools(env);
  return Boolean(found.ffmpeg && found.ffprobe && !found.problem);
}

/**
 * An AudioExtractor backed by a local ffmpeg. Each chunk locates ffmpeg
 * (cached after the first time; with `download: true` a managed copy is
 * fetched on Linux unless VID2CONTEXT_FFMPEG_DOWNLOAD=0). When none is usable
 * it throws `no-provider` with the install hint, which stops the watcher.
 */
export function createFfmpegExtractor(opts: { env: Env; download?: boolean; timeoutMs?: number }): AudioExtractor {
  const env = opts.env;
  return {
    id: 'ffmpeg',
    async extract(media: ChunkMedia, signal?: AbortSignal) {
      try {
        await locateFfmpeg({ env, signal }, { download: opts.download ?? false });
      } catch (err) {
        if (signal?.aborted) throw err;
        const e = err instanceof Vid2ContextError ? err : undefined;
        throw new Vid2ContextError('no-provider', `Live transcription needs ffmpeg. ${e?.message ?? String(err)}`, {
          hint: e?.hint ?? 'Install ffmpeg or set FFMPEG_PATH.',
          cause: err,
        });
      }
      return withTempDir(async (dir) => {
        const input = join(dir, 'chunk.media');
        await writeFile(input, media.data);
        const audio = await extractAudio(
          input,
          {
            format: 'wav',
            startSec: media.offsetSec,
            durationSec: media.durationSec,
            name: media.filename.replace(/\.[^.]+$/, ''),
            download: false,
            timeoutMs: opts.timeoutMs ?? 60_000,
          },
          { env, signal },
        );
        return { ...audio, durationSec: audio.durationSec || media.durationSec };
      });
    },
  };
}

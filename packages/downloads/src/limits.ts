/**
 * Limits for the media toolkit (stall watchdog, disk headroom, captions,
 * frame grabs, animated clips, batches), read from the request's env like
 * `downloadPolicy`. Public servers (VID2CONTEXT_PUBLIC=1) get tighter
 * defaults, because every byte and CPU second there is spent for strangers.
 * Runtime-neutral.
 */
import { type Env, isPublicMode, limits } from '@vid2context/core';

export interface ToolkitLimits {
  /** Seconds a yt-dlp or ffmpeg process may go without progress before it is killed and retried. */
  stallSec: number;
  /** Retries after a stall before the download fails. */
  stallRetries: number;
  /** MB of free disk space that must remain after the estimated download. */
  minFreeMb: number;
  /** Most items in one batch (playlist, channel or URL list). */
  maxBatchItems: number;
  /** Most caption tracks in one captions download. */
  maxCaptionTracks: number;
  /** Most frame grabs in one request. */
  maxFrames: number;
  /** Longest animated GIF or WebP clip, in seconds. */
  maxClipSec: number;
  /** Widest animated clip, in pixels. */
  maxClipWidth: number;
  /** Highest frame rate of an animated clip. */
  maxClipFps: number;
}

function num(v: string | undefined, fallback: number, min = 0): number {
  if (v === undefined || v.trim() === '') return fallback;
  const n = Number(v);
  return Number.isFinite(n) && n >= min ? n : fallback;
}

export function toolkitLimits(env: Env): ToolkitLimits {
  const pub = isPublicMode(env);
  // The playlist cap already bounds how many videos one input expands to; a public server
  // defaults to a small batch unless the operator set that cap on purpose.
  const playlistCap = limits(env).maxPlaylistItems;
  const explicitCap = (env.VID2CONTEXT_MAX_PLAYLIST_ITEMS ?? '').trim() !== '';
  return {
    stallSec: Math.max(10, Math.floor(num(env.VID2CONTEXT_DOWNLOAD_STALL_SEC, pub ? 60 : 120))),
    stallRetries: Math.min(10, Math.floor(num(env.VID2CONTEXT_DOWNLOAD_STALL_RETRIES, 2))),
    minFreeMb: Math.floor(num(env.VID2CONTEXT_DOWNLOAD_MIN_FREE_MB, pub ? 1024 : 256)),
    maxBatchItems: pub && !explicitCap ? Math.min(playlistCap, 25) : playlistCap,
    maxCaptionTracks: Math.max(1, Math.floor(num(env.VID2CONTEXT_MAX_CAPTION_TRACKS, pub ? 10 : 50, 1))),
    maxFrames: Math.max(1, Math.floor(num(env.VID2CONTEXT_MAX_FRAMES, pub ? 20 : 100, 1))),
    maxClipSec: Math.max(1, num(env.VID2CONTEXT_MAX_CLIP_SEC, pub ? 15 : 60, 1)),
    maxClipWidth: Math.max(64, Math.floor(num(env.VID2CONTEXT_MAX_CLIP_WIDTH, pub ? 640 : 1280, 64))),
    maxClipFps: Math.max(1, Math.floor(num(env.VID2CONTEXT_MAX_CLIP_FPS, pub ? 15 : 30, 1))),
  };
}

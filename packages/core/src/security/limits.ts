/**
 * Central size and time limits. Every package reads these instead of
 * inventing its own, so one env var tightens a public deployment everywhere.
 */
import type { Env, Runtime } from '../types.ts';

export interface Limits {
  /** Longest accepted input string (URL, path or id). VID2CONTEXT_MAX_INPUT_CHARS, default 2048. */
  maxInputChars: number;
  /** Most videos expanded from one playlist, channel or feed. VID2CONTEXT_MAX_PLAYLIST_ITEMS, default 500. */
  maxPlaylistItems: number;
  /** Largest upload accepted by the HTTP API and web app, in MB. VID2CONTEXT_MAX_UPLOAD_MB, default 200. */
  maxUploadMb: number;
  maxUploadBytes: number;
  /**
   * Largest audio download or file read for speech-to-text, in MB. VID2CONTEXT_MAX_AUDIO_MB. The audio is held in
   * memory, so the default depends on the runtime: 512 on Node (about 9 hours of 128 kbps MP3), 64 on Workers
   * (whose isolates have 128 MB in all) and 256 in the browser.
   */
  maxAudioMb: number;
  maxAudioBytes: number;
  /** Most transcript segments kept from one source. VID2CONTEXT_MAX_SEGMENTS, default 200000. */
  maxSegments: number;
  /** Default timeout for one outbound HTTP request. VID2CONTEXT_FETCH_TIMEOUT_MS, default 30000. */
  fetchTimeoutMs: number;
}

function positiveInt(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === '') return fallback;
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

const MB = 1024 * 1024;

/** Default VID2CONTEXT_MAX_AUDIO_MB per runtime: audio is buffered in memory, and a Worker isolate has 128 MB. */
export const DEFAULT_MAX_AUDIO_MB: Record<Runtime, number> = { node: 512, workers: 64, browser: 256 };

/**
 * Limits with env overrides. Invalid or non-positive values fall back to the default. Pass the runtime
 * (`ctx.runtime`) so memory-bound defaults fit it; without one the Node defaults apply.
 */
export function limits(env: Env = {}, runtime: Runtime = 'node'): Limits {
  const maxUploadMb = positiveInt(env.VID2CONTEXT_MAX_UPLOAD_MB, 200);
  const maxAudioMb = positiveInt(env.VID2CONTEXT_MAX_AUDIO_MB, DEFAULT_MAX_AUDIO_MB[runtime]);
  return {
    maxInputChars: positiveInt(env.VID2CONTEXT_MAX_INPUT_CHARS, 2048),
    maxPlaylistItems: positiveInt(env.VID2CONTEXT_MAX_PLAYLIST_ITEMS, 500),
    maxUploadMb,
    maxUploadBytes: maxUploadMb * MB,
    maxAudioMb,
    maxAudioBytes: maxAudioMb * MB,
    maxSegments: positiveInt(env.VID2CONTEXT_MAX_SEGMENTS, 200_000),
    fetchTimeoutMs: positiveInt(env.VID2CONTEXT_FETCH_TIMEOUT_MS, 30_000),
  };
}

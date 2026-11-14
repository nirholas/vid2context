/**
 * Central size and time limits. Every package reads these instead of
 * inventing its own, so one env var tightens a public deployment everywhere.
 */
import type { Env } from '../types.ts';

export interface Limits {
  /** Longest accepted input string (URL, path or id). VID2CONTEXT_MAX_INPUT_CHARS, default 2048. */
  maxInputChars: number;
  /** Most videos expanded from one playlist, channel or feed. VID2CONTEXT_MAX_PLAYLIST_ITEMS, default 500. */
  maxPlaylistItems: number;
  /** Largest upload accepted by the HTTP API and web app, in MB. VID2CONTEXT_MAX_UPLOAD_MB, default 200. */
  maxUploadMb: number;
  maxUploadBytes: number;
  /** Largest audio download or file read for speech-to-text, in MB. VID2CONTEXT_MAX_AUDIO_MB, default 1024. */
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

/** Limits with env overrides. Invalid or non-positive values fall back to the default. */
export function limits(env: Env = {}): Limits {
  const maxUploadMb = positiveInt(env.VID2CONTEXT_MAX_UPLOAD_MB, 200);
  const maxAudioMb = positiveInt(env.VID2CONTEXT_MAX_AUDIO_MB, 1024);
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

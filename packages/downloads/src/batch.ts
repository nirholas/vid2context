/**
 * Batch downloads: several URLs, playlists or channels, each item saved as
 * video, audio or captions only, with one status per item and an optional
 * single .zip of everything. Runtime-neutral; node/batch.ts runs it.
 */
import { Vid2ContextError } from '@vid2context/core';
import { type CaptionsRequest, normalizeCaptionsRequest, type RawCaptionsRequest } from './captions.ts';
import { toolkitLimits } from './limits.ts';
import { type DownloadRequest, normalizeRequest, type RawDownloadRequest } from './options.ts';
import type { DownloadProgress } from './progress.ts';

/** The per-item request, without its input (filled in per video). */
export type BatchItemRequest = Omit<DownloadRequest, 'input'> | Omit<CaptionsRequest, 'input'>;

export interface BatchRequest {
  kind: 'batch';
  /** Video, playlist, channel or feed URLs (and, on this machine, file paths). */
  inputs: string[];
  /** What each video becomes: a video or audio download, or captions only. */
  item: BatchItemRequest;
  /** Most videos in total, after playlists and channels are expanded. */
  limit: number;
  /** Expand video links that also name a playlist (watch?v=...&list=...) into the playlist. */
  playlist: boolean;
  /** Return one .zip with every saved file instead of one file per item. */
  zip: boolean;
}

export type BatchItemStatus = 'queued' | 'running' | 'done' | 'error' | 'canceled';

/** One video of a batch as the API reports it. */
export interface BatchItem {
  index: number;
  input: string;
  status: BatchItemStatus;
  progress?: DownloadProgress;
  file?: { filename: string; bytes: number; mimeType: string; title: string; warnings: string[] };
  error?: { code: string; message: string; hint?: string };
}

export interface RawBatchRequest extends RawDownloadRequest, Omit<RawCaptionsRequest, 'input' | 'url' | 'format' | 'zip'> {
  urls?: unknown;
  inputs?: unknown;
  limit?: unknown;
  playlist?: unknown;
  zip?: unknown;
}

function bad(message: string, hint: string): Vid2ContextError {
  return new Vid2ContextError('bad-request', message, { hint });
}

function list(value: unknown): string[] {
  if (value === undefined || value === null || value === '') return [];
  const items = Array.isArray(value) ? value : typeof value === 'string' ? value.split(/[\s,]+/) : null;
  if (!items || items.some((v) => typeof v !== 'string'))
    throw bad('urls must be a list of strings.', 'Send {"urls": ["...", "..."]}.');
  return [...new Set((items as string[]).map((v) => v.trim()).filter(Boolean))];
}

function flag(value: unknown, fallback: boolean, label: string): boolean {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  const v = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(v)) return true;
  if (['0', 'false', 'no', 'off'].includes(v)) return false;
  throw bad(`${label} must be true or false.`, `Pass ${label}=1 or ${label}=0.`);
}

/** Validate a batch. `kind` is video (default), audio or captions; the other fields are those of that request. */
export function normalizeBatchRequest(raw: RawBatchRequest, env: Record<string, string | undefined> = {}): BatchRequest {
  const inputs = [...list(raw.urls ?? raw.inputs), ...list(raw.url ?? raw.input)];
  if (inputs.length === 0) throw bad('Missing the videos to download.', 'Send urls: video, playlist or channel URLs.');
  const cap = toolkitLimits(env).maxBatchItems;
  const limitRaw = raw.limit === undefined || raw.limit === null || raw.limit === '' ? undefined : Number(raw.limit);
  if (limitRaw !== undefined && (!Number.isInteger(limitRaw) || limitRaw < 1)) {
    throw bad('limit must be a positive whole number.', `Pass limit=20 (at most ${cap}).`);
  }
  if (inputs.length > cap) {
    throw bad(
      `${inputs.length} URLs sent; a batch holds at most ${cap}.`,
      'Split the list, or raise VID2CONTEXT_MAX_PLAYLIST_ITEMS.',
    );
  }
  const limit = Math.min(limitRaw ?? cap, cap);
  const first = inputs[0] as string;
  const kind = typeof raw.kind === 'string' ? raw.kind.trim().toLowerCase() : undefined;
  let item: BatchItemRequest;
  if (kind === 'captions') {
    const { input: _i, ...rest } = normalizeCaptionsRequest({ ...raw, input: first, zip: false } as RawCaptionsRequest, env);
    item = rest;
  } else {
    const { input: _i, ...rest } = normalizeRequest({ ...raw, input: first });
    item = rest;
  }
  return {
    kind: 'batch',
    inputs,
    item,
    limit,
    playlist: flag(raw.playlist, false, 'playlist'),
    zip: flag(raw.zip, false, 'zip'),
  };
}

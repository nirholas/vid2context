/**
 * The media toolkit on top of plain downloads: captions only, frame grabs,
 * animated clips and batches. This file holds the shared request type, the
 * one validator every surface uses (`normalizeToolkitRequest`) and the
 * contract the Node implementation (node/toolkit.ts) fulfils. Runtime-neutral.
 */
import { type Ctx, type GetContextOptions, Vid2ContextError } from '@vid2context/core';
import { type BatchItem, type BatchRequest, normalizeBatchRequest, type RawBatchRequest } from './batch.ts';
import { type CaptionsRequest, type CaptionTracks, normalizeCaptionsRequest, type RawCaptionsRequest } from './captions.ts';
import {
  type AnimationRequest,
  type FramesRequest,
  normalizeAnimationRequest,
  normalizeFramesRequest,
  type RawAnimationRequest,
  type RawFramesRequest,
} from './clips.ts';
import type { DownloadProgress } from './progress.ts';
import type { Downloader, DownloadOptions, JobFile, JobStatus } from './types.ts';

export type ToolkitRequest = CaptionsRequest | FramesRequest | AnimationRequest | BatchRequest;
export type ToolkitKind = ToolkitRequest['kind'];
export const TOOLKIT_KINDS: readonly ToolkitKind[] = ['captions', 'frames', 'animation', 'batch'];

/** A file the toolkit wrote: one caption file, one frame, a clip, or a .zip of several. */
export interface ToolkitFile {
  path: string;
  /** File name only. */
  filename: string;
  bytes: number;
  mimeType: string;
  kind: ToolkitKind;
  /** Extension of the result: srt, vtt, txt, json, md, png, jpg, gif, webp, zip, or the original subtitle format. */
  format: string;
  title: string;
  source: string;
  durationSec?: number;
  /** For a .zip: the files inside it. */
  entries?: { name: string; bytes: number }[];
  /** Captions: one entry per language written, with where its text came from. */
  tracks?: { language: string; origin: string; producer: string; via: 'pipeline' | 'ytdlp' | 'file'; translated?: boolean }[];
  warnings: string[];
}

export interface TaskOptions extends DownloadOptions {
  /** Batches: called whenever an item's status or progress changes. */
  onItems?: (items: BatchItem[]) => void;
  /** Pipeline options for captions (chain policy, speech-to-text options, storage). */
  pipeline?: Partial<GetContextOptions>;
}

/** What a toolkit task produced: one file, and for a batch without zip the per-item files. */
export interface TaskResult {
  file?: ToolkitFile;
  items?: BatchItem[];
  /** Absolute paths of item files, by item index (batch without zip). */
  itemPaths?: (string | undefined)[];
  /** Notes about the whole task (a batch without zip has no file to carry them). */
  warnings?: string[];
}

/** A toolkit task as the HTTP API reports it: the same shape as a download job, with a toolkit request. Paths stay on the server. */
export interface TaskJob {
  id: string;
  status: JobStatus;
  request: ToolkitRequest;
  progress: DownloadProgress;
  createdAt: string;
  updatedAt: string;
  expiresAt?: string;
  /** The result file (one caption file, a frame, a clip, or a .zip). Batches without zip have none. */
  file?: Omit<ToolkitFile, 'path'>;
  /** Batches: one entry per video, in order. */
  items?: BatchItem[];
  /** Notes about the whole task. */
  warnings?: string[];
  error?: { code: string; message: string; hint?: string };
}

/** Queue of toolkit tasks on a server (Node: `createTaskQueue`, reachable as `downloader.toolkit.jobs`). */
export interface TaskQueue {
  create(req: ToolkitRequest, ctx: Ctx): TaskJob;
  get(id: string): TaskJob | undefined;
  list(): TaskJob[];
  /** Cancel a queued or running task (its child processes are killed and awaited), or delete a finished one. */
  remove(id: string): Promise<boolean>;
  /** The result file, a byte range of it, or (batches without zip) item `item`'s file. */
  open(id: string, range?: { start: number; end: number }, item?: number): Promise<JobFile | undefined>;
  close(): Promise<void>;
}

/** Node implementation: `createToolkit` in `@vid2context/downloads/node`, also reachable as `downloader.toolkit`. */
export interface Toolkit {
  /** Every caption track of one video, with translation targets, without downloading any. */
  captionTracks(input: string, ctx: Ctx): Promise<CaptionTracks>;
  captions(req: CaptionsRequest, ctx: Ctx, opts: TaskOptions): Promise<ToolkitFile>;
  frames(req: FramesRequest, ctx: Ctx, opts: TaskOptions): Promise<ToolkitFile>;
  animation(req: AnimationRequest, ctx: Ctx, opts: TaskOptions): Promise<ToolkitFile>;
  batch(req: BatchRequest, ctx: Ctx, opts: TaskOptions): Promise<TaskResult>;
  /**
   * Cheap check before a job is queued, so a bad input fails the request (400, 404)
   * instead of a job: the input resolves, is a single video when `single` is set, a local
   * file exists, and a video with a dedicated source provider (YouTube and the like)
   * exists by its metadata call. Sites read only by the yt-dlp catch-all are not fetched.
   */
  check(input: string, ctx: Ctx, opts?: { single?: boolean }): Promise<void>;
  /** Server-side task queue, created on first use. */
  readonly jobs: TaskQueue;
  /** Run any toolkit request. */
  run(req: ToolkitRequest, ctx: Ctx, opts: TaskOptions): Promise<TaskResult>;
}

export type RawToolkitRequest = RawCaptionsRequest &
  RawFramesRequest &
  RawAnimationRequest &
  RawBatchRequest & { kind?: unknown };

/** Validate any toolkit request; `kind` picks which (captions, frames, animation or batch). */
export function normalizeToolkitRequest(
  raw: RawToolkitRequest,
  kind?: ToolkitKind,
  env: Record<string, string | undefined> = {},
): ToolkitRequest {
  const k = kind ?? (typeof raw.kind === 'string' ? raw.kind.trim().toLowerCase() : undefined);
  switch (k) {
    case 'captions':
      return normalizeCaptionsRequest(raw, env);
    case 'frames':
      return normalizeFramesRequest(raw, env);
    case 'animation':
    case 'gif':
    case 'clip':
      return normalizeAnimationRequest(raw, env);
    case 'batch':
      return normalizeBatchRequest(raw, env);
    default:
      throw new Vid2ContextError('bad-request', `Unknown task "${String(k).slice(0, 20)}".`, {
        hint: `Use ${TOOLKIT_KINDS.join(', ')}.`,
      });
  }
}

/** A downloader built by `createDownloader` from `@vid2context/downloads/node` carries the toolkit. */
export type ToolkitDownloader = Downloader & { toolkit?: Toolkit };

/** The toolkit attached to a downloader, when it has one (built with a registry). */
export function toolkitOf(downloader: Downloader | undefined): Toolkit | undefined {
  return (downloader as ToolkitDownloader | undefined)?.toolkit;
}

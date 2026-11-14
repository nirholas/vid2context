/**
 * The contracts between the runtime-neutral surfaces (http.ts, mcp.ts) and
 * the Node implementation in node/. Surfaces receive these objects from
 * their entry point, so they never import `node:*` themselves.
 */
import type { Ctx } from '@vid2context/core';
import type { MediaOptions } from './formats.ts';
import type { DownloadRequest, MediaFormat, MediaKind } from './options.ts';
import type { DownloadProgress } from './progress.ts';

export interface DownloadedFile {
  /** Absolute path of the finished file. */
  path: string;
  /** File name only, e.g. "Big Buck Bunny [aqz-KE-bpKQ].mp4". */
  filename: string;
  bytes: number;
  mimeType: string;
  kind: MediaKind;
  format: MediaFormat;
  title: string;
  /** The page the media came from, or the local path. */
  source: string;
  durationSec?: number;
  /** The part kept, when trimmed. */
  section?: { fromSec: number; toSec?: number; chapter?: string };
  /** Things that did not go as asked but did not stop the download (a subtitle track that failed, a trim done locally). */
  warnings: string[];
}

export interface DownloadOptions {
  /** Directory the finished file is written to. Created when missing. */
  dir: string;
  onProgress?: (progress: DownloadProgress) => void;
  /** Replace a file with the same name instead of adding " (2)". Default false. */
  overwrite?: boolean;
}

export interface DownloaderStatus {
  /** Whether downloads can run here at all (yt-dlp found or installable, ffmpeg present). */
  ready: boolean;
  ytdlp?: { version: string; path: string };
  ffmpeg?: { path: string };
  /** Why downloads cannot run, with how to fix it. */
  problem?: string;
}

/** Downloads one video or audio file. Node implementation: `createDownloader` in `@vid2context/downloads/node`. */
export interface Downloader {
  /** Formats, qualities and estimated sizes, without downloading. */
  probe(input: string, ctx: Ctx): Promise<MediaOptions>;
  download(req: DownloadRequest, ctx: Ctx, opts: DownloadOptions): Promise<DownloadedFile>;
  status(ctx: Ctx): Promise<DownloaderStatus>;
  /**
   * The directory files are saved to: `dir` with `~` expanded and relative
   * paths taken from the default, or the default itself
   * (VID2CONTEXT_DOWNLOAD_DIR, else ~/Downloads/vid2context).
   */
  outputDir(ctx: Ctx, dir?: string): string;
}

export type JobStatus = 'queued' | 'running' | 'done' | 'error' | 'canceled';

/** One server-side download as the HTTP API reports it. Paths stay on the server. */
export interface DownloadJob {
  id: string;
  status: JobStatus;
  request: DownloadRequest;
  progress: DownloadProgress;
  createdAt: string;
  updatedAt: string;
  /** When the finished file is deleted. */
  expiresAt?: string;
  file?: Omit<DownloadedFile, 'path'>;
  error?: { code: string; message: string; hint?: string };
}

export interface JobFile {
  stream: ReadableStream<Uint8Array>;
  bytes: number;
  filename: string;
  mimeType: string;
}

/** Queue of server-side downloads. Node implementation: `createDownloadManager`. */
export interface DownloadManager {
  readonly downloader: Downloader;
  create(req: DownloadRequest, ctx: Ctx): DownloadJob;
  get(id: string): DownloadJob | undefined;
  list(): DownloadJob[];
  /** Cancel a queued or running job, or delete a finished one and its file. False when unknown. */
  remove(id: string): Promise<boolean>;
  /** The finished file, or a byte range of it. Undefined when the job is unknown or not done. */
  open(id: string, range?: { start: number; end: number }): Promise<JobFile | undefined>;
  close(): Promise<void>;
}

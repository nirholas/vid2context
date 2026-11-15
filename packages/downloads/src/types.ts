/**
 * The contracts between the runtime-neutral surfaces (http.ts, mcp.ts) and
 * the Node implementation in node/. Surfaces receive these objects from
 * their entry point, so they never import `node:*` themselves.
 */
import type { Ctx } from '@vid2context/core';
import type { ThumbnailFormat, ThumbnailRequest } from './extras.ts';
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
  /** One file per chapter, when the request asked for splitChapters. Paths sit in a folder next to `path`. */
  parts?: DownloadedPart[];
}

/** One chapter written as its own file by a chapter split. */
export interface DownloadedPart {
  path: string;
  /** Relative to the download directory, e.g. "Title [id]/01 - Intro.mp4". */
  filename: string;
  bytes: number;
  /** 0-based chapter number. */
  index: number;
  title: string;
  fromSec: number;
  toSec: number;
}

export interface ThumbnailOptions {
  /** Directory the image is written to. Created when missing. */
  dir: string;
  overwrite?: boolean;
}

/** A saved thumbnail (cover image). */
export interface SavedThumbnail {
  path: string;
  filename: string;
  bytes: number;
  mimeType: string;
  format: ThumbnailFormat;
  width?: number;
  height?: number;
  /** Where the image came from: the thumbnail URL, the file's cover art, or a frame at a time. */
  origin: 'site' | 'cover' | 'frame';
  title: string;
  source: string;
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
  /** Save the video's thumbnail: the site's largest one, else a local file's cover art or a frame from it. */
  thumbnail?(req: ThumbnailRequest, ctx: Ctx, opts: ThumbnailOptions): Promise<SavedThumbnail>;
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
  file?: Omit<DownloadedFile, 'path' | 'parts'> & { parts?: Omit<DownloadedPart, 'path'>[] };
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
  /**
   * The finished file, or a byte range of it. `part` picks one chapter file of
   * a chapter split (its 0-based index). Undefined when the job is unknown, not
   * done, or has no such part.
   */
  open(id: string, range?: { start: number; end: number }, part?: number): Promise<JobFile | undefined>;
  /** Fetch a thumbnail into memory (no job: images are small) and delete the temp file. */
  thumbnail?(
    req: ThumbnailRequest,
    ctx: Ctx,
  ): Promise<JobFile & { width?: number; height?: number; origin: SavedThumbnail['origin'] }>;
  close(): Promise<void>;
}

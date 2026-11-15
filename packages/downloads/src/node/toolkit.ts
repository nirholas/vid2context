/**
 * The media toolkit (captions only, frame grabs, animated clips, batches) as
 * one object, and `createDownloader`, which returns the plain downloader with
 * the toolkit attached as `downloader.toolkit`. Every entry point already
 * builds a downloader from the registry, so the CLI, the MCP tools and the
 * HTTP job manager all get the toolkit without new wiring.
 */
import { stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { type Ctx, checkInput, type Registry, Vid2ContextError } from '@vid2context/core';
import type { TaskOptions, TaskQueue, TaskResult, Toolkit, ToolkitDownloader, ToolkitRequest } from '../toolkit.ts';
import type { Downloader } from '../types.ts';
import { createBatchEngine } from './batch.ts';
import { createCaptionsEngine } from './captions.ts';
import { createClipsEngine } from './clips.ts';
import { createDownloader as createBaseDownloader, type DownloaderOptions } from './engine.ts';
import { createTaskQueue } from './tasks.ts';

/** Longest the pre-queue metadata check may take. */
const CHECK_TIMEOUT_MS = 15_000;

export interface ToolkitDeps {
  registry: Registry;
  downloader: Downloader;
}

export function createToolkit({ registry, downloader }: ToolkitDeps): Toolkit {
  const cap = createCaptionsEngine({ registry });
  const clips = createClipsEngine({ registry, downloader });
  const { batch } = createBatchEngine({ registry, downloader, captions: cap.captions });
  let jobs: TaskQueue | undefined;
  const toolkit: Toolkit = {
    async check(input: string, ctx: Ctx, opts: { single?: boolean } = {}): Promise<void> {
      const refused = checkInput(input, ctx.env);
      if (refused) throw refused;
      const { source, ref } = registry.resolve(input);
      if (opts.single && ref.kind !== 'video') {
        throw new Vid2ContextError('bad-request', `"${input.slice(0, 200)}" is a ${ref.kind}, not a single video.`, {
          hint: 'Download its videos as a batch: POST /downloads/batch with {"urls": [...]}.',
        });
      }
      if (ref.url?.startsWith('file:')) {
        const path = fileURLToPath(ref.url);
        const st = await stat(path).catch(() => undefined);
        if (!st?.isFile()) throw new Vid2ContextError('not-found', `No such file: ${path}`, { hint: 'Check the path.' });
        return;
      }
      if (ref.kind !== 'video' || source.catchAll) return;
      // One metadata call (YouTube: one innertube request), bounded so a slow site never holds the request.
      const signal = ctx.signal
        ? AbortSignal.any([ctx.signal, AbortSignal.timeout(CHECK_TIMEOUT_MS)])
        : AbortSignal.timeout(CHECK_TIMEOUT_MS);
      try {
        await source.getMetadata(ref, { ...ctx, signal });
      } catch (err) {
        if (err instanceof Vid2ContextError && err.code === 'not-found') throw err;
        if (ctx.signal?.aborted) throw err;
        // Blocks, rate limits and timeouts say nothing about the video; the job gets its own chance.
      }
    },
    get jobs(): TaskQueue {
      jobs ??= createTaskQueue({ toolkit });
      return jobs;
    },
    captionTracks: cap.captionTracks,
    captions: cap.captions,
    frames: clips.frames,
    animation: clips.animation,
    batch,
    async run(req: ToolkitRequest, ctx: Ctx, opts: TaskOptions): Promise<TaskResult> {
      switch (req.kind) {
        case 'captions':
          return { file: await cap.captions(req, ctx, opts) };
        case 'frames':
          return { file: await clips.frames(req, ctx, opts) };
        case 'animation':
          return { file: await clips.animation(req, ctx, opts) };
        case 'batch':
          return batch(req, ctx, opts);
        default:
          throw new Vid2ContextError('bad-request', 'Unknown task.', { hint: 'Use captions, frames, animation or batch.' });
      }
    },
  };
  return toolkit;
}

/**
 * The downloader (yt-dlp for web URLs, ffmpeg for local files) with the
 * toolkit attached. Without a registry the toolkit is left out: captions and
 * batches need one to resolve inputs and run the transcript pipeline.
 */
export function createDownloader(options: DownloaderOptions = {}): ToolkitDownloader {
  const downloader: ToolkitDownloader = createBaseDownloader(options);
  if (options.registry) downloader.toolkit = createToolkit({ registry: options.registry, downloader });
  return downloader;
}

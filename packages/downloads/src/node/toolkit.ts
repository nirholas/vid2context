/**
 * The media toolkit (captions only, frame grabs, animated clips, batches) as
 * one object, and `createDownloader`, which returns the plain downloader with
 * the toolkit attached as `downloader.toolkit`. Every entry point already
 * builds a downloader from the registry, so the CLI, the MCP tools and the
 * HTTP job manager all get the toolkit without new wiring.
 */
import type { Ctx, Registry } from '@vid2context/core';
import { Vid2ContextError } from '@vid2context/core';
import type { TaskOptions, TaskQueue, TaskResult, Toolkit, ToolkitDownloader, ToolkitRequest } from '../toolkit.ts';
import type { Downloader } from '../types.ts';
import { createBatchEngine } from './batch.ts';
import { createCaptionsEngine } from './captions.ts';
import { createClipsEngine } from './clips.ts';
import { createDownloader as createBaseDownloader, type DownloaderOptions } from './engine.ts';
import { createTaskQueue } from './tasks.ts';

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

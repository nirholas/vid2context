/**
 * Node implementation: the downloader (yt-dlp for web URLs, ffmpeg for local
 * files) and the job queue the HTTP server uses. Never import this from code
 * that also runs on Workers or in the browser.
 */

export { freeBytes, preflightDisk } from './node/disk.ts';
export { type DownloaderOptions, outputDir, resolveSection } from './node/engine.ts';
export { freeName, moveInto, outputName, stamp } from './node/files.ts';
export { convertPlan, trimArgs } from './node/local.ts';
export { createDownloadManager, type ManagerOptions } from './node/manager.ts';
export { savePieces } from './node/pack.ts';
export { createTaskQueue, type TaskQueueOptions } from './node/tasks.ts';
export { createDownloader, createToolkit, type ToolkitDeps } from './node/toolkit.ts';
export { folderBytes, Watchdog, waitForExit } from './node/watchdog.ts';
export { zipFiles } from './node/zipfile.ts';

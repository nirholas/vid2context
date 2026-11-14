/**
 * Node implementation: the downloader (yt-dlp for web URLs, ffmpeg for local
 * files) and the job queue the HTTP server uses. Never import this from code
 * that also runs on Workers or in the browser.
 */
export { createDownloader, type DownloaderOptions, outputDir, resolveSection } from './node/engine.ts';
export { freeName, moveInto, outputName, stamp } from './node/files.ts';
export { convertPlan, trimArgs } from './node/local.ts';
export { createDownloadManager, type ManagerOptions } from './node/manager.ts';

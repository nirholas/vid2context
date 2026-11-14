/**
 * Node entry: everything from the main entry plus the ffmpeg audio extractor.
 * Import from here in Node programs (CLI, stdio MCP server, the Node HTTP
 * server); the main entry stays free of Node built-ins so it can be bundled
 * anywhere.
 */
export * from './index.ts';
export { createFfmpegExtractor, FFMPEG_MISSING_HINT, findFfmpeg, fixWavHeader } from './ffmpeg.ts';

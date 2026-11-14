/**
 * Node entry: everything from the main entry plus the ffmpeg audio extractor.
 * Import from here in Node programs (CLI, stdio MCP server, the Node HTTP
 * server); the main entry stays free of Node built-ins so it can be bundled
 * anywhere.
 */

export { createFfmpegExtractor, ffmpegAvailable } from './ffmpeg.ts';
export * from './index.ts';

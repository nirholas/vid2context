/**
 * vid2context MCP server. Tools return text (and structuredContent where the
 * result is structured); failures come back as tool results with isError
 * carrying the error code, hint and attempts, so the calling agent can
 * explain what went wrong or retry another way.
 *
 * Every tool call gets its own Ctx (a shallow copy carrying the call's abort
 * signal), so per-request state never outlives the call. createServer holds
 * no transport code: bin.ts serves it over stdio and packages/mcp-http over
 * Streamable HTTP.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Ctx, Registry, Storage } from '@vid2context/core';
import type { AudioExtractor } from '@vid2context/live';
import { registerPrompts } from './prompts.ts';
import { registerResources } from './resources.ts';
import { LazyStorage } from './shared.ts';
import { registerListTools } from './tools/lists.ts';
import { registerModelTools } from './tools/models.ts';
import { registerVideoTools } from './tools/video.ts';
import { registerPackageTools } from './wire.ts';

export { briefPrompt, buyerGuidePrompt } from './prompts.ts';
export { contextHeader, LazyStorage, type ToolResult, toolError } from './shared.ts';
export { renderTranscript } from './tools/video.ts';
export { listModels, type ModelInfo } from './tools/models.ts';

export const SERVER_NAME = 'vid2context';

export const SERVER_INSTRUCTIONS = `vid2context turns videos into context you can cite. Speech is about 12k tokens per hour of video.
Reading strategy: for anything longer than about 20 minutes, call get_outline first (chapters with token counts), then get_section for the chapters you need, or search_transcript to find where a topic comes up. get_transcript returns everything; set maxTokens to page through long ones.
Many videos: create_collection or add_to_collection, then get_collection, search_transcript and export_context_pack. The brief and buyer_guide prompts describe how to write a cited brief.
Cite moments as [Video title @ m:ss](timestamp link); outlines and search hits include the links.`;

export interface ServerOptions {
  /**
   * Library and cache backend shared by every tool. Default: the registry's
   * enabled storage provider, opened on first use, else MemoryStorage.
   */
  storage?: Storage;
  /** Audio extractor for watch_live. bin.ts passes the ffmpeg one; without it watch_live answers with a no-provider error. */
  extractAudio?: AudioExtractor;
}

export function createServer(registry: Registry, ctx: Ctx, version = '0.1.0', opts: ServerOptions = {}): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version }, { instructions: SERVER_INSTRUCTIONS });
  const storage = opts.storage ?? new LazyStorage(registry, ctx);
  const deps = { registry, ctx, storage };
  registerVideoTools(server, deps);
  registerListTools(server, deps);
  registerModelTools(server, deps);
  registerPackageTools(server, { ...deps, extractAudio: opts.extractAudio });
  registerPrompts(server);
  registerResources(server, storage);
  return server;
}

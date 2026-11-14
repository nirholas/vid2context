/**
 * Tools, prompts and resources owned by other packages, registered through
 * the `register<Name>Tools(server, deps)` functions their `src/mcp.ts`
 * exports (docs/contracts/mcp-tools.md). Each gets the same registry, base
 * Ctx and storage as this server's own tools, so the library is shared.
 *
 * A package that lands later is wired here with one additive line.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerAskTools } from '@vid2context/ask/mcp';
import type { Ctx, Registry, Storage } from '@vid2context/core';
import { registerDedupeTools } from '@vid2context/dedupe/mcp';
import type { Downloader } from '@vid2context/downloads';
import { registerDownloadTools } from '@vid2context/downloads/mcp';
import { registerExporterTools } from '@vid2context/exporters/mcp';
import { registerInsightsTools } from '@vid2context/insights/mcp';
import { registerLibraryTools } from '@vid2context/library/mcp';
import { type AudioExtractor, registerLiveTools } from '@vid2context/live';
import { registerAgenticFeatures } from '@vid2context/mcp-agentic/mcp';
import { registerAppsTools } from '@vid2context/mcp-apps/mcp';
import { registerResearchTools } from '@vid2context/research/mcp';
import { registerSearchTools } from '@vid2context/search/mcp';
import { registerSkipsTools } from '@vid2context/skips/mcp';

export interface PackageToolDeps {
  registry: Registry;
  ctx: Ctx;
  storage: Storage;
  /** Audio extractor for watch_live (Node: createFfmpegExtractor from @vid2context/live/node). */
  extractAudio?: AudioExtractor;
  /** Saves videos and audio on this machine (stdio only: bin.ts passes createDownloader; remote servers pass none). */
  downloader?: Downloader;
}

export function registerPackageTools(server: McpServer, deps: PackageToolDeps): void {
  const { registry, ctx, storage } = deps;
  // search_transcript: keyword and embedding search over saved transcripts (item 40)
  registerSearchTools(server, { registry, ctx, storage });
  // extract and build_brief: server-side structured extraction and cited briefs (items 32 and 33)
  registerInsightsTools(server, { registry, ctx, storage });
  // list_collections, create_collection, add_to_collection, get_collection (item 41)
  registerLibraryTools(server, { registry, ctx, storage });
  // ask: server-side answers with timestamp citations (item 34)
  registerAskTools(server, { registry, ctx, storage });
  // research_videos, list_caption_languages, get_key_moments (item 54)
  registerResearchTools(server, { registry, ctx, storage });
  // get_skip_segments (item 53)
  registerSkipsTools(server, { registry, ctx, storage });
  // export_obsidian (Node only), export_notion (item 57)
  registerExporterTools(server, { registry, ctx, storage });
  // find_duplicates (item 62)
  registerDedupeTools(server, { registry, ctx, storage });
  // watch_live (item 61)
  registerLiveTools(server, { registry, ctx, extractAudio: deps.extractAudio });
  // open_transcript_viewer and its MCP Apps UI resource (item 52)
  registerAppsTools(server, { registry, ctx });
  // get_media_options and download_media, only when a downloader is passed (downloads package)
  registerDownloadTools(server, { registry, ctx, ...(deps.downloader ? { downloader: deps.downloader } : {}) });
  // digest_videos, choose_caption_track, the digest prompt, completions and the latest-items resource (item 51)
  registerAgenticFeatures(server, { registry, ctx, storage: async () => storage });
}

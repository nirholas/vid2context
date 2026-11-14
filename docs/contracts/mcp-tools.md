# MCP tools contract

The MCP server ([packages/mcp/src/server.ts](../../packages/mcp/src/server.ts)) is how agents use vid2context. Claude Code, Claude Desktop, Cursor and VS Code connect over stdio (`vid2context-mcp`). ChatGPT and Claude.ai connect to the remote server over Streamable HTTP (`/mcp`, served by `packages/mcp-http`, item 45). Both transports serve exactly the same tools from `createServer(registry, ctx)`.

## Rules for every tool

- **Names** are snake_case verb phrases. They are final once listed here; integrations, docs and the web app refer to them.
- **Inputs**: a video input is always called `url` (a URL, a YouTube id or a local path). Several inputs are `urls: string[]`. A collection is `collection` (its id). Formats come from the core `formatters` map at runtime, never from a hard-coded list.
- **Outputs** are text content. Text-format transcripts start with the header from `contextHeader()` (title, channel, URL, duration, transcript origin, chapters) so the agent always knows the source. Structured results are pretty-printed JSON text.
- **Citations**: wherever a result points into a video, include `[m:ss]` timestamps and, where the platform supports it, a timestamp URL from `timestampUrl`.
- **Errors** are tool results with `isError: true` and this JSON text, never protocol errors:

  ```json
  { "error": "not-found", "message": "...", "hint": "...", "attempts": [] }
  ```

- **Context budget**: speech is about 12k tokens per hour. Tools that can return whole transcripts must also offer a way to fetch less (`get_outline`, `get_section`, `search_transcript`).
- **Per-call context**: each call runs with its own `Ctx` carrying the call's abort signal. Never keep per-request state on the server object.
- **Synthesis is the agent's job by default.** Tools return data and the server offers prompts that tell the agent how to build a cited brief. Server-side LLM synthesis is opt-in (item 32) for collections too large for the agent's context.

## Implemented tools

### `get_transcript`

| Input | Type | Default |
|---|---|---|
| `url` | string | required |
| `format` | formatter id | `text` |
| `timestamps` | boolean | `true` |
| `mode` | `auto` \| `captions` \| `stt` \| `video` | `auto` |
| `language` | BCP-47 string | spoken language |

Returns the header plus the rendered transcript (text format), or the rendered transcript alone for other formats.

### `get_metadata`

| Input | Type |
|---|---|
| `url` | string, required |

Returns `VideoMetadata` as JSON: title, channel, description, duration, chapters, tags, language.

## Planned tools

The Owner column names the work item (see `docs/ROADMAP.md`) that implements the tool.

Ownership rule for parallel work: **only item 44 edits `packages/mcp`.** An item whose own package backs a tool (32, 33, 34, 40, 41) exports a registration function from `src/mcp.ts` in that package:

```ts
// packages/ask/src/mcp.ts
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Ctx, Registry } from '@vid2context/core';
export function registerAskTools(server: McpServer, deps: { registry: Registry; ctx: Ctx }): void { /* server.registerTool('ask', ...) */ }
```

Item 44 calls every registration function that exists when it runs; one that lands later is wired with a one-line additive change to `packages/mcp/src/server.ts`. Item 45 (`packages/mcp-http`) serves the same `createServer()` over Streamable HTTP and never defines tools of its own. "uses NN" below means the tool's logic comes from item NN's package.

| Tool | Owner | Input | Returns |
|---|---|---|---|
| `list_formats` | 44 | `{}` | formats from the `formatters` map |
| `get_outline` | 44 (uses 03) | `{ url }` | metadata, chapters and estimated tokens per chapter, so the agent can fetch only what it needs |
| `get_section` | 44 (uses 03) | `{ url, from?, to?, chapter?, format?, timestamps? }` | a time range or chapter of a transcript |
| `list_items` | 44 (uses 08, 13, 15) | `{ url, limit? }` | the videos in a playlist, channel, feed or page |
| `search_transcript` | 44 (uses 40) | `{ query, collection?, urls?, limit? }` | hits with title, `[m:ss]`, text and timestamp URL |
| `get_comments` | 44 (uses 09) | `{ url, limit? }` | top comments, creator replies flagged |
| `export_context_pack` | 44 (uses 01) | `{ urls?, collection?, maxTokens? }` | the context pack Markdown |
| `list_collections` | 44 (uses 41) | `{}` | collections with counts |
| `create_collection` | 44 (uses 41) | `{ name, description?, sources? }` | the collection; `sources` (playlists, channels, feeds) are followed |
| `add_to_collection` | 44 (uses 41) | `{ collection, urls }` | ingests each video (or list) and returns the updated collection |
| `get_collection` | 44 (uses 41) | `{ collection }` | the collection with video summaries |
| `ask` | 44 (uses 34) | `{ question, collection?, urls? }` | an answer with timestamp citations (server-side RAG) |
| `extract` | 44 (uses 33) | `{ template? , schema?, urls?, collection? }` | structured JSON with citations |
| `build_brief` | 44 (uses 32) | `{ collection?, urls?, question? }` | a server-side cited brief (map-reduce on a free model) |

### Prompts

| Prompt | Owner | Arguments | Purpose |
|---|---|---|---|
| `brief` | 44 | `collection` or `urls`, optional `question` | Instructions for the calling agent to read the sources with the tools above and write a brief where every claim cites `[video title @ m:ss](url)`, flagging consensus and disagreement |
| `buyer_guide` | 44 (uses 33) | `collection`, `product` | The buyer-guide template as an agent prompt (models, years, mileage, known issues, prices, with citations) |

### Resources

| URI | Owner | Content |
|---|---|---|
| `vid2context://video/{id}` | 44 | the saved `VideoContext` as JSON (`id` is the ref id, URL-encoded) |
| `vid2context://video/{id}/transcript` | 44 | the text transcript with timestamps |
| `vid2context://collection/{id}` | 44 | the collection with video summaries |

## Wave 2 tools (prompts 51 to 62)

Same rules as above. Each package registers its tools from its own `src/mcp.ts` (`register<Name>Tools(server, deps)`); item 44, or the integration pass, wires them into `createServer`. The package owner is the prompt number.

| Tool, prompt or resource | Owner | Input | Returns |
|---|---|---|---|
| `digest_videos` | 51 | `{ urls?, collection?, question?, maxTokensPerVideo? }` | A cited digest built with MCP sampling (the client's own model, no server key). Without client sampling support: a chunk plan plus instructions for the agent to digest the chunks itself, never an error |
| `choose_caption_track` | 51 | `{ url }` | Lists caption tracks and asks the user to pick one through MCP elicitation, then returns that transcript; without elicitation support, returns the track list |
| prompt `digest` | 51 | `collection` or `urls` (with argument completions), optional `question` | Messages that drive `digest_videos` |
| resource `vid2context://collection/{id}/latest` | 51 | | The newest items of a collection; subscribable, updated through `notifyCollectionUpdated(id)` |
| `open_transcript_viewer` | 52 | `{ url }` | `structuredContent` (metadata, chapters, segments) plus an MCP Apps UI resource `ui://vid2context/transcript-viewer`; text fallback for clients without MCP Apps |
| `get_skip_segments` | 53 | `{ url, categories? }` | SponsorBlock segments (sponsor, self-promotion, intro, outro, interaction reminders, ...) with times, and the transcript share each covers |
| `research_videos` | 54 | `{ urls (1 to 10), query, contextSec?, maxExcerpts? }` | Ranked excerpts per video with surrounding context, `[m:ss]` and timestamp URLs; works without a saved library |
| `list_caption_languages` | 54 | `{ url }` | Caption tracks (language, name, creator or auto) and YouTube translation targets |
| `get_key_moments` | 54 | `{ url, count? }` | Key moments chosen by the LLM chain, each with a timestamp verified against real segments |
| `export_obsidian` | 57 | `{ urls?, collection?, vaultPath }` (stdio only: writes files on the user's machine) | Paths written: one note per video plus a collection index note |
| `export_notion` | 57 | `{ urls?, collection?, parentPageId? }` | Notion page URLs created |
| `watch_live` | 61 | `{ url, maxMinutes? }` | A rolling transcript of a live stream, streamed as progress notifications, final text at the end |
| `find_duplicates` | 62 | `{ urls?, collection? }` | Groups of reuploads and clips with evidence (overlap, time offset), so briefs count independent sources once |

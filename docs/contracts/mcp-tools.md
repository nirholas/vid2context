# MCP tools contract

The MCP server ([packages/mcp/src/server.ts](../../packages/mcp/src/server.ts)) is how agents use vid2context. Claude Code, Claude Desktop, Cursor and VS Code connect over stdio (`vid2context-mcp`). ChatGPT and Claude.ai connect to the remote server over Streamable HTTP (`/mcp`, served by `packages/mcp-http`, item 45). Both transports serve exactly the same tools from `createServer(registry, ctx)`.

## Transports

Item 45 owns this section.

| Transport | Entry | Auth | Notes |
|---|---|---|---|
| stdio | `vid2context-mcp` (`packages/mcp/src/bin.ts`) | none (local process) | stdout is the protocol; logs go to stderr |
| Streamable HTTP | `vid2context-mcp-http` (`packages/mcp-http/src/bin.ts`), or `mcpHttpRoutes(deps)` mounted at `/` by the HTTP API | static bearer tokens (`VID2CONTEXT_MCP_TOKENS`) or OAuth 2.1 access tokens bound to `<origin>/mcp` | `POST/GET/DELETE /mcp`. Session mode (`Mcp-Session-Id`, Node default) or stateless (Workers default, GET and DELETE answer 405) |

Streamable HTTP rules:

- Every request builds its own `Ctx` with `makeCtx(req)`. In stateless mode an aborted request closes its server, which aborts running tool calls. A session's server keeps the `Ctx` of the request that opened it, minus that request's signal; tool calls use the SDK's per-call signal.
- One library `Storage` is opened once and passed to every `createServer(registry, ctx, version, { storage, ...serverOptions })`.
- 401 responses carry `WWW-Authenticate: Bearer resource_metadata="<origin>/.well-known/oauth-protected-resource/mcp", scope="mcp"` when OAuth is on. 401, 403 and 429 bodies use the HTTP API error shape and are returned by the sub-app, never thrown.
- An `Origin` header not listed in `VID2CONTEXT_CORS_ORIGINS` (or the public origin) gets 403. When bound to loopback, a Host header that is not loopback, the public host or `VID2CONTEXT_MCP_ALLOWED_HOSTS` gets 403.
- A session is bound to the credential that opened it. Another credential gets 404, as if there were no session.
- Per-token token bucket: `VID2CONTEXT_MCP_RATE_LIMIT` requests per minute (default 120), answering 429 with `Retry-After`.
- Tools that touch the server's own filesystem (`export_obsidian`) refuse calls that arrive over HTTP.
- Discovery is public: `/mcp/server-card` (SEP-2127) and `/.well-known/ai-catalog.json`. OAuth endpoints are `/.well-known/oauth-protected-resource[/mcp]`, `/.well-known/oauth-authorization-server` and `/oauth/{register,authorize,token,revoke}`. See [docs/guides/remote-mcp.md](../guides/remote-mcp.md).
- Protocol versions: the SDK in use (1.32.2) speaks 2025-11-25 and older. The 2026-07-28 changes (no sessions, no GET stream, `Mcp-Method` headers) follow when the SDK supports them.

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

Every tool has a JSON Schema input with a description per field, annotations (`readOnlyHint`, `openWorldHint`, `idempotentHint`, plus `destructiveHint: false` on writes), and a description that says when to use it and roughly what it costs in tokens. Tools marked "structured" also declare an `outputSchema` and return the same object as `structuredContent` and as JSON text. Every video read through any tool is saved to the server's storage (the enabled storage provider, else `MemoryStorage`), so `search_transcript`, the collection tools and the resources see it.

`createServer(registry, ctx, version?, opts?)` holds no transport code. `opts.storage` shares one `Storage` with every tool and wired package (bin.ts opens the registry's backend up front); `opts.extractAudio` is the audio extractor for `watch_live` (bin.ts passes the ffmpeg one from `@vid2context/live/node`).

### Defined in `packages/mcp` (item 44)

| Tool | Input | Returns |
|---|---|---|
| `get_transcript` | `{ url, format?, timestamps?, mode?, language?, maxTokens?, cursor? }` | Text format: the `contextHeader()` header plus the transcript; other formats: the rendered transcript. When the result would exceed `maxTokens` (via `estimateTokens`), one page cut on segment boundaries, ending with `[Partial transcript: ... next_cursor: seg:N]`; pass `cursor: "seg:N"` with the same arguments for the next page. Every page of every format is complete on its own (JSON pages parse). The last page ends with `[End of transcript: ...]` |
| `get_metadata` | `{ url }` | `VideoMetadata` as JSON |
| `list_formats` | `{}` | structured `{ formats: { id, description, mimeType, extension, combinesVideos }[] }`, from the `formatters` map at runtime |
| `get_outline` | `{ url, mode?, language? }` | structured `{ title, url?, durationSec, transcript: { origin, language, producer }, sections: "chapters" \| "time", totalTokens, chapters: { index, title, startSec, endSec?, start, tokens, url? }[], metadata, next }`. Videos without chapters get sections of about five minutes (`transcriptOutline` from core) |
| `get_section` | `{ url, from?, to?, chapter?, format?, timestamps?, mode?, language? }` | One chapter (index or title: exact, prefix, then substring) or time range (`from`/`to` as seconds, `m:ss` or `h:mm:ss`), with the header and a `Section "title": m:ss to m:ss, about N tokens` line in text format |
| `list_items` | `{ url, limit? }` | structured `{ input, count, items: { id, platform, kind, nativeId, url? }[] }` through `expandInput`. Default limit 50, max 500 |
| `get_comments` | `{ url, limit? }` | structured `{ title, url?, count, comments: Comment[] }`. Read straight from the source's `getComments` (a video without a transcript still has comments), reusing a saved context that already holds enough comments. `unsupported-input` for sources without comments |
| `export_context_pack` | `{ urls?, collection?, maxTokens?, limit? }` | The `pack` Markdown through `renderMany`; inputs that could not be read are listed under "Not included" |
| `list_models` | `{ kind? }` | structured `{ models: ModelInfo[], defaultPolicy }` (`ModelInfo` in docs/prompts/SHARED-CONTRACTS.md section 3): every rung of `registry.llmRungs(env)` and the other getters, capabilities plus `stream` when `canStream` is true. Env var names only, never values |

Long operations over many videos (`export_context_pack` with list `urls`) send `notifications/progress` per video when the client sends a progress token. One failing video never fails the batch: it is reported in `failed`.

### Wired from other packages

`packages/mcp/src/wire.ts` calls each package's registration function with the same registry, base `Ctx` and storage.

| Tools | Package (item) | Registration function |
|---|---|---|
| `search_transcript` | `@vid2context/search` (40) | `registerSearchTools` |
| `extract`, `build_brief` | `@vid2context/insights` (32, 33) | `registerInsightsTools` |
| `list_collections`, `create_collection`, `add_to_collection`, `get_collection` | `@vid2context/library` (41) | `registerLibraryTools` |
| `ask` | `@vid2context/ask` (34) | `registerAskTools` |
| `research_videos`, `list_caption_languages`, `get_key_moments` | `@vid2context/research` (54) | `registerResearchTools` |
| `get_skip_segments` | `@vid2context/skips` (53) | `registerSkipsTools` |
| `export_obsidian` (Node only), `export_notion` | `@vid2context/exporters` (57) | `registerExporterTools` |
| `find_duplicates` | `@vid2context/dedupe` (62) | `registerDedupeTools` |
| `watch_live` | `@vid2context/live` (61) | `registerLiveTools` |
| `open_transcript_viewer` | `@vid2context/mcp-apps` (52) | `registerAppsTools` |
| `digest_videos`, `choose_caption_track`, prompt `digest`, resource `.../latest` | `@vid2context/mcp-agentic` (51) | `registerAgenticFeatures` |

The rows for these tools in the tables below describe their inputs and outputs. `ask` returns `[n] Title @ m:ss <timestamp URL>` source lines after the answer, and its error body nests the code as `{ error: { code, message, hint }, attempts }`.

## Adding a tool from another package

The Owner column names the work item (see `docs/ROADMAP.md`) that implements the tool.

Ownership rule for parallel work: **only item 44 edits `packages/mcp`.** An item whose own package backs a tool exports a registration function from `src/mcp.ts` in that package:

```ts
// packages/ask/src/mcp.ts
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Ctx, Registry } from '@vid2context/core';
export function registerAskTools(server: McpServer, deps: { registry: Registry; ctx: Ctx }): void { /* server.registerTool('ask', ...) */ }
```

A registration function that lands later is wired with a one-line additive change to `packages/mcp/src/wire.ts`. Item 45 (`packages/mcp-http`) serves the same `createServer()` over Streamable HTTP and never defines tools of its own. 

Every tool in the original plan is now implemented or wired. These are the inputs the wired tools take:

| Tool | Owner | Input | Returns |
|---|---|---|---|
| `search_transcript` | 40 | `{ query, collection?, urls?, limit?, rerank? }`; `query` takes `"exact phrases"` and `-excluded` words; `urls` not yet in the library are fetched and saved first | hits with title, `[m:ss-m:ss]`, highlighted text and timestamp URL, then one status line (which sides ran, embedding model, why vector search was off), as text |
| `extract` | 33 | `{ template? , schema?, urls?, collection? }` | structured JSON with citations |
| `build_brief` | 32 | `{ collection?, urls?, question? }` | a server-side cited brief (map-reduce on a free model) |

## Collection tools (item 41)

| Tool | Input | Returns |
|---|---|---|
| `list_collections` | `{}` | `{ collections: { id, name, description?, videos (count), sources, updatedAt }[] }` |
| `create_collection` | `{ name, description?, sources? }` | the collection; `sources` (playlists, channels, feeds) are followed; a single video as a source is a `bad-request` error |
| `add_to_collection` | `{ collection, urls }` | ingests each video (or list, expanded) now and returns `{ collection, summary: { added: { id, title, url, origin }[], skipped, failed: { input, code, message, hint?, cause? }[], remaining, checkedAt } }`; one failed video never stops the others |
| `get_collection` | `{ collection }` | the collection with `videos` (video summaries), `pending` (imported inputs not ingested yet) and `watch` (schedule and state, or null) |

Refresh, watch lists, webhooks and import/export are on the HTTP API and the library package; see [guides/collections.md](../guides/collections.md).

## Prompts (implemented)

Both tell the calling agent to plan reading from token counts, read outline first (`get_outline`, `get_section`, `search_transcript`) or whole when it fits, and cite every claim as `[Video title @ m:ss](timestamp link)`, flagging consensus, disagreement and single-source claims. Prompt arguments are strings, so `urls` is a comma, space or newline separated list. The text lives in `packages/mcp/src/prompts.ts` until `@vid2context/insights` (item 32) exports prompt text.

| Prompt | Arguments | Purpose |
|---|---|---|
| `brief` | `collection` or `urls`, optional `question` | A cited brief: summary, key findings by theme, consensus and disagreement, open questions, sources |
| `buyer_guide` | `product`, `collection` or `urls` | A cited buyer guide: models and years, best and worst years, known issues, prices (dated), mileage, inspection checklist |

## Resources (implemented)

Listed from storage (newest 500 saved videos; every collection). Reading an id that is not saved is a `not-found` error with a hint.

| URI | Content |
|---|---|
| `vid2context://video/{id}` | the saved `VideoContext` as JSON (`id` is the ref id, URL-encoded: `youtube%3AjNQXAC9IVRw`) |
| `vid2context://video/{id}/transcript` | the header plus the text transcript with `[m:ss]` timestamps |
| `vid2context://collection/{id}` | `{ collection, videos: { id, title, url, channel, durationSec, origin, language, chapters, tokens }[], totalTokens, missing }` |

## Wave 2 tools (prompts 51 to 62)

Same rules as above. Each package registers its tools from its own `src/mcp.ts` (`register<Name>Tools(server, deps)`); item 44, or the integration pass, wires them into `createServer` (all rows below are wired, see "Wired from other packages"). The package owner is the prompt number.

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

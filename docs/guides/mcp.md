# MCP server

The vid2context MCP server lets an agent (Claude Code, Claude Desktop, Cursor, VS Code, any stdio MCP client) read videos: transcripts, outlines, single chapters, search across what it has read, collections, and prompts for writing cited briefs. No API key is needed for YouTube captions; keys in `.env` only add speech-to-text and LLM rungs.

The remote transport for ChatGPT and Claude.ai (Streamable HTTP with auth) is `packages/mcp-http`, which serves the same server.

## Setup

Node 22 or newer, then `npm install` in the repo.

### Claude Code

From the repo root:

```sh
claude mcp add vid2context -- npx tsx packages/mcp/src/bin.ts
```

To use it from any folder, give the absolute path, and add `-s user` to make it available in every project:

```sh
claude mcp add -s user vid2context -- npx tsx /path/to/vid2context/packages/mcp/src/bin.ts
```

Check it with `claude mcp list`, or `/mcp` inside a session.

### Other stdio clients

Claude Desktop (`claude_desktop_config.json`), Cursor (`.cursor/mcp.json`) and VS Code (`.vscode/mcp.json`, key `servers` instead of `mcpServers`) take the same command:

```json
{
  "mcpServers": {
    "vid2context": {
      "command": "npx",
      "args": ["tsx", "/path/to/vid2context/packages/mcp/src/bin.ts"]
    }
  }
}
```

Keys go in the repo's `.env` (see `.env.example`); the server loads it on start. Logs go to stderr, so stdout stays clean for the protocol.

### Inspect it

```sh
npx @modelcontextprotocol/inspector --cli npx tsx packages/mcp/src/bin.ts --method tools/list
npx @modelcontextprotocol/inspector --cli npx tsx packages/mcp/src/bin.ts --method tools/call \
  --tool-name get_outline --tool-arg url=https://www.youtube.com/watch?v=jNQXAC9IVRw
```

Without `--cli` the Inspector opens its web UI.

## Reading strategy: outline first

Speech is about 12k tokens per hour, so a 15-episode series of 30-minute videos is about 90k tokens. Read only what you need:

1. `get_outline` shows the chapters (or sections of about five minutes when the video has none), each with its start time, a timestamp link and its token count.
2. `get_section` reads one chapter by index or title, or a time range.
3. `search_transcript` finds where a topic comes up across every video read so far, a collection, or given URLs.
4. `get_transcript` returns everything; with `maxTokens` it pages, and each page ends with a cursor for the next one.

For many videos, put them in a collection (`create_collection`, `add_to_collection`), check `get_collection` for the token total, then either `export_context_pack` (when it fits) or outline-first reading.

Every video any tool reads is saved, so later calls are instant and search covers it. With no storage provider configured, the library lives in memory for the life of the server process.

## Citations

Results carry `[m:ss]` timestamps and, for YouTube, timestamp links (`https://www.youtube.com/watch?v=ID&t=SECONDSs`). The `brief` and `buyer_guide` prompts ask the agent to cite every claim like this:

```md
The cool thing about the elephants, he says, is their really long trunks [Me at the zoo @ 0:05](https://www.youtube.com/watch?v=jNQXAC9IVRw&t=5s).
```

## Tools

Arguments shown as JSON. A video input is always `url` (a URL, a YouTube id or a local file path). Failures are tool results with `isError: true` and a JSON body: `{ "error": "<code>", "message": "...", "hint": "<how to recover>", "attempts": [...] }`.

### Defined by this package

| Tool | Example call | Returns |
|---|---|---|
| `get_transcript` | `{ "url": "https://youtu.be/jNQXAC9IVRw" }` | Header (title, channel, URL, duration, transcript origin, chapters) plus `[m:ss]` lines |
| | `{ "url": "...", "maxTokens": 4000 }`, then `{ "url": "...", "maxTokens": 4000, "cursor": "seg:412" }` | One page at a time, ending with `next_cursor: seg:N` until `[End of transcript: ...]` |
| `get_metadata` | `{ "url": "jNQXAC9IVRw" }` | Title, channel, description, duration, chapters, tags, language |
| `list_formats` | `{}` | `text`, `json`, `markdown`, `srt`, `vtt`, `pack`, ... with descriptions |
| `get_outline` | `{ "url": "https://www.youtube.com/watch?v=cCPsdFdlshc" }` | Chapters or 5-minute sections with `start`, `tokens` and `url`, plus `totalTokens` |
| `get_section` | `{ "url": "...", "chapter": 1 }`, `{ "url": "...", "chapter": "engines" }`, `{ "url": "...", "from": "12:00", "to": "17:30" }` | That part of the transcript with the header |
| `list_items` | `{ "url": "https://www.youtube.com/playlist?list=PL...", "limit": 20 }` | The videos in a playlist, channel, feed or page |
| `search_transcript` | `{ "query": "timing chain", "collection": "g-wagon" }`, `{ "query": "rust", "urls": ["..."] }` | Hits with title, `at` (`m:ss`), the line, surrounding text and a timestamp link |
| `get_comments` | `{ "url": "...", "limit": 20 }` | Top comments; pinned and creator comments flagged |
| `export_context_pack` | `{ "collection": "g-wagon", "maxTokens": 60000 }` | One Markdown document for all the videos, trimmed to the budget |
| `list_models` | `{ "kind": "llm" }` | Rungs with tier, quality, capabilities, enabled, and the env var names that enable them (never values) |

### Wired from other packages

| Tool | Example call | Returns |
|---|---|---|
| `list_collections` | `{}` | Collections with counts |
| `create_collection` | `{ "name": "G-Wagon", "sources": ["https://www.youtube.com/@alliancemotorworks"] }` | The collection (sources are followed) |
| `add_to_collection` | `{ "collection": "g-wagon-1a2b3c4d", "urls": ["https://youtu.be/..."] }` | The updated collection and what was added, skipped or failed |
| `get_collection` | `{ "collection": "g-wagon-1a2b3c4d" }` | The collection with video summaries |
| `ask` | `{ "question": "Which years have the most engine problems?", "collection": "g-wagon-1a2b3c4d" }` | A server-side answer with `[n]` citations (needs an LLM rung) |
| `research_videos` | `{ "urls": ["...", "..."], "query": "maintenance costs" }` | Ranked excerpts per video with context |
| `list_caption_languages` | `{ "url": "..." }` | Caption tracks and translation targets |
| `get_key_moments` | `{ "url": "...", "count": 8 }` | LLM-picked moments with verified timestamps |
| `get_skip_segments` | `{ "url": "..." }` | SponsorBlock segments and the transcript share they cover |
| `find_duplicates` | `{ "collection": "g-wagon-1a2b3c4d" }` | Reuploads and clips, so a brief counts each source once |
| `digest_videos` | `{ "collection": "g-wagon-1a2b3c4d", "question": "..." }` | A cited digest made with the client's own model (MCP sampling), or a chunk plan |
| `choose_caption_track` | `{ "url": "..." }` | Asks which caption track to use (MCP elicitation) |
| `open_transcript_viewer` | `{ "url": "..." }` | An interactive transcript viewer in clients with MCP Apps |
| `watch_live` | `{ "url": "...", "maxMinutes": 10 }` | A rolling transcript of a live stream (needs ffmpeg) |
| `export_obsidian` | `{ "collection": "...", "vaultPath": "/home/me/Vault" }` | Notes written into an Obsidian vault on this machine |
| `export_notion` | `{ "collection": "..." }` | Notion pages (needs a Notion token) |

## Prompts

| Prompt | Arguments | What the agent gets |
|---|---|---|
| `brief` | `collection` or `urls` (comma separated), optional `question` | Steps to read the sources outline first and write a brief citing every claim, with consensus and disagreement |
| `buyer_guide` | `product`, `collection` or `urls` | The same for a buyer guide: years, known issues, prices, mileage, inspection checklist |
| `digest` | `collection` or `urls`, optional `question` | Drives `digest_videos` |

In Claude Code, prompts appear as slash commands: `/mcp__vid2context__brief`.

## Resources

| URI | Content |
|---|---|
| `vid2context://video/{id}` | A saved video context as JSON (`id` URL-encoded, like `youtube%3AjNQXAC9IVRw`) |
| `vid2context://video/{id}/transcript` | Its text transcript with timestamps |
| `vid2context://collection/{id}` | A collection with per-video summaries and token totals |
| `vid2context://collection/{id}/latest` | The newest items of a collection |

Resources list what is saved, so they fill up as the agent reads videos.

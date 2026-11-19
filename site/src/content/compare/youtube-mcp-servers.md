---
title: vid2context vs YouTube transcript MCP servers
label: vs YouTube MCP servers
description: Small MCP servers fetch YouTube captions for an agent. vid2context does that, then transcribes videos without captions, reads X, podcasts and 1,000+ other sites, and lets agents read long videos chapter by chapter.
order: 4
---

Several open-source MCP servers give an agent a YouTube transcript tool, among them [mcp-server-youtube-transcript](https://github.com/kimtaeyoon83/mcp-server-youtube-transcript) (`get_transcript`), [mcp-youtube-transcript](https://github.com/jkawamoto/mcp-youtube-transcript) (timed transcripts with paging) and [transcriptor-mcp](https://github.com/samson-art/transcriptor-mcp) (11 platforms through yt-dlp, with Whisper). They are MIT-licensed and good at what they do. vid2context is an MCP server too, built for the cases a captions fetcher cannot cover.

## What each one does

| | Caption-fetching MCP servers | vid2context |
|---|---|---|
| YouTube captions | Yes | Yes: creator, auto and translated tracks |
| Video has no captions | No transcript (transcriptor-mcp runs Whisper) | Speech-to-text, free first: local Whisper, then free tiers, then keyless hosts |
| Other sources | YouTube (transcriptor-mcp: 11 platforms) | X posts, podcasts, Bilibili, Vimeo, Loom, Wistia, media links, share links, local files, embedded videos, and the 1,000+ sites yt-dlp supports |
| Long videos | The whole transcript at once, or pages | An outline with token counts, then only the sections the agent needs (about 12k tokens per hour of speech) |
| Tools | One to a few | 28: transcripts, outlines, sections, comments, key moments, playlists, search, Q&A and cited briefs, collections, live streams, exports |
| Remote use | Local stdio | Local stdio, or your own remote server over HTTPS with a bearer token or OAuth 2.1 |
| What it tried | Usually not reported | Every result lists each provider tried and why it moved on |

## When to pick a small captions server

- Your agent only needs YouTube captions and every video you use has them.
- You want the smallest possible dependency.

## When to pick vid2context

- Some videos have no captions, or are not on YouTube.
- Your agent should read long videos without loading the whole transcript.
- You want answers with timestamp citations, briefs across several videos, or a context pack for ChatGPT or Claude Projects.
- You want the same server reachable remotely ([remote MCP](/docs/guides/remote-mcp/)), or to try it with no install first: [vid2context.com](https://vid2context.com) runs the web app and HTTP API.

## Setup

```bash
npx -y vid2context-mcp
```

Claude Code: `claude mcp add --scope user --transport stdio vid2context -- npx -y vid2context-mcp`. Other clients and the remote server: [the MCP guide](/docs/guides/mcp/).

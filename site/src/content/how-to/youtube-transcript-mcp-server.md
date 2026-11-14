---
title: YouTube transcript MCP server
label: YouTube transcript MCP server
description: An MCP server that gives Claude, Cursor, VS Code and other agents the transcript, chapters and metadata of any YouTube video, with timestamps. Free, no API key.
order: 1
---

vid2context is an MCP server that lets your agent read YouTube videos. Give it a link and it returns the transcript with `[m:ss]` timestamps, the title, channel, duration and chapters. It needs no YouTube API key and no account: captions come from YouTube directly, and when a video has none, the audio goes through free speech-to-text.

## Install

The steps below are for Claude Code and use {{mcp.installMode}}. Every other client has its own page under [Agent clients](/docs/clients/claude-desktop/).

{{client:claude-code}}

## Ask for a transcript

Once it is connected, ask in plain words:

> Get the transcript of https://www.youtube.com/watch?v=jNQXAC9IVRw and summarize it with timestamps.

The agent calls `get_transcript`. This is the exact text the tool returns for that video, rendered by vid2context from a recorded run:

```text
{{demo.mcpTranscript}}
```

The header tells the agent where the transcript came from (`creator-captions` here, so nothing was transcribed). The timestamps let it cite the moment a claim comes from.

## The tools for one video

| Tool | What it returns |
|---|---|
| `get_transcript` | The header and the whole transcript, in any format: {{formats.ids}}. Set `maxTokens` to get long transcripts in pages. |
| `get_metadata` | Title, channel, description, duration, chapters, tags and language, without the transcript. |
| `get_outline` | The chapters or sections of a long video with their token sizes, so the agent can choose what to read. |
| `get_section` | One chapter or time range, with the same header. |
| `list_caption_languages` | Every caption track the video has, and the languages YouTube can translate them into. |
| `get_comments` | Top comments, with creator replies and pinned comments flagged. |

Speech is about 12,000 tokens per hour of video, so for anything longer than about 20 minutes the agent should read the outline first and pull only the sections it needs. The tool descriptions tell it so.

The server has more tools for playlists, collections, search and cited briefs. See [Turn a YouTube playlist into research notes](/docs/how-to/youtube-playlist-research-notes/) and the [MCP tools contract](/docs/contracts/mcp-tools/).

## When a video has no captions

The chain moves on by itself: creator captions, then auto-captions, then speech-to-text. With no keys set, speech-to-text uses the keyless rungs ({{sttKeyless.list}}). A free Groq key or a local Whisper makes it faster. See [Transcribe a video with Whisper for free](/docs/how-to/transcribe-a-video-with-whisper-for-free/).

## When something fails

Failures come back as tool errors with a stable code, a hint that says how to recover, and every attempt that was made. The most common one is `blocked`: YouTube refuses requests from many cloud and datacenter IP ranges. On your own machine requests come from your own connection, which is why the server runs locally by default.

## Questions

**Does it need a YouTube Data API key?** No. It reads the same data the YouTube apps read.

**Does it download the video?** Only the audio, and only when there are no captions and speech-to-text is needed.

**Can it read other sites?** Yes. Vimeo and others have their own providers, and anything yt-dlp supports works through the yt-dlp provider. See [Sources](/#sources).

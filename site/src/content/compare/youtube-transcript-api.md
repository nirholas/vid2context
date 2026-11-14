---
title: vid2context vs youtube-transcript-api
label: vs youtube-transcript-api
description: youtube-transcript-api is a focused Python library for YouTube captions. vid2context adds speech-to-text fallback, metadata, chapters, other sites and an MCP server. When to pick which.
order: 1
---

[youtube-transcript-api](https://github.com/jdepoix/youtube-transcript-api) is a mature Python library (MIT) that fetches the captions of a YouTube video, including auto-generated and translated tracks. vid2context does that too, then keeps going when there are no captions, and packages the result for agents.

## What each one does

| | youtube-transcript-api | vid2context |
|---|---|---|
| Language | Python library and CLI | TypeScript: CLI, MCP server, HTTP API, library |
| YouTube creator and auto captions | Yes | Yes |
| YouTube translated captions | Yes | Yes |
| Video has no captions | Fails with an error | Speech-to-text fallback, free-first |
| Other sites and local files | No, YouTube only | Vimeo and others natively, the rest through yt-dlp, local files |
| Metadata and chapters | No | Title, channel, description, duration, chapters, tags |
| Output formats | JSON, text, SRT, WebVTT formatters | {{formats.ids}}, and a .zip with all of them |
| Agents | Call it from your own code | MCP server with tools for transcripts, outlines, playlists and search |
| License | MIT | Apache-2.0 |

## When to pick youtube-transcript-api

- You write Python and only need YouTube captions inside your own program.
- You want one small dependency with proxy and cookie options you control.

## When to pick vid2context

- Some of your videos have no captions, or are not on YouTube.
- You want the transcript in an agent (Claude, Cursor, VS Code, ChatGPT) without writing glue code.
- You need metadata and chapters with the transcript, or long videos read section by section.

## Same video, both tools

For "Me at the zoo", vid2context returns the header and timed transcript below (rendered from a recorded run). youtube-transcript-api returns the same caption lines as a list of `{ text, start, duration }` objects, without the header.

```text
{{demo.mcpTranscript}}
```

vid2context learned from youtube-transcript-api's error taxonomy: blocked IPs and other failures come back with a stable code and a hint on how to recover.

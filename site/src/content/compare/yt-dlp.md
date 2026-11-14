---
title: vid2context vs yt-dlp
label: vs yt-dlp
description: yt-dlp downloads media and subtitles from thousands of sites. vid2context uses it as one provider and adds transcripts when subtitles are missing, agent-ready formats and an MCP server.
order: 2
---

[yt-dlp](https://github.com/yt-dlp/yt-dlp) (Unlicense) downloads video, audio, subtitles and metadata from thousands of sites. It is the reference for site extractors. vid2context is not a replacement: it runs yt-dlp as one of its providers, for sites without a native provider and for audio, and turns what comes back into context an agent can read.

## What each one does

| | yt-dlp | vid2context |
|---|---|---|
| Download video and audio | Yes, every format | Audio only, when speech-to-text needs it |
| Subtitles | Downloads them (`--write-subs`, `--write-auto-subs`) | Fetches them, and transcribes when there are none |
| Video has no subtitles | Nothing to give | Speech-to-text, free-first |
| Sites | Every extractor it has | Native providers for some sites, yt-dlp for the rest |
| Metadata | Full JSON (`--dump-json`) | Normalized metadata and chapters |
| Output | Media files, subtitle files, JSON | {{formats.ids}}, a .zip, MCP tool results |
| For agents | A command line to script | MCP server, HTTP API |
| License | Unlicense | Apache-2.0 |

## When to pick yt-dlp

- You want the media itself: to archive, edit or watch offline.
- You need a subtitle file and the video has one.

## When to pick vid2context

- You want text an agent can cite, whether or not the video has subtitles.
- You want timestamps, chapters and metadata in one Markdown file or one tool call.
- You want your agent to fetch videos itself over MCP.

## Using them together

vid2context finds yt-dlp on your `PATH` or installs the official release into `.vid2context/bin/` with a checksum check, then keeps it updated weekly. Any URL that no native provider understands goes to yt-dlp, so the long tail of sites works without extra setup. Details are in [Providers and rungs](/docs/providers/).

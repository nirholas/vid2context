---
title: Give Claude a YouTube video
description: Let Claude read any YouTube video: add the free vid2context MCP server to Claude Code or Claude Desktop, or upload a context pack to a Claude Project.
order: 2
---

Claude cannot watch a video, but it reads transcripts well. vid2context hands it the transcript of any YouTube video with timestamps, plus the title, channel and chapters, so Claude can summarize, answer questions and cite the moment each answer comes from.

There are two ways: let Claude fetch videos itself through MCP (Claude Code and Claude Desktop), or upload a file to a Claude Project.

## Claude Code

These steps use {{mcp.installMode}}.

{{client:claude-code}}

Then ask:

> Get the transcript of https://www.youtube.com/watch?v=jNQXAC9IVRw and tell me what he says about the elephants, with timestamps.

## Claude Desktop

Claude Desktop reads servers from `claude_desktop_config.json`. The full steps, including where the file lives on macOS and Windows, are on the [Claude Desktop page](/docs/clients/claude-desktop/). After a restart, the tools menu in a new chat lists vid2context.

## What Claude receives

When Claude calls `get_transcript`, this is the text it gets back for "Me at the zoo", rendered by vid2context from a recorded run:

```text
{{demo.mcpTranscript}}
```

## A Claude Project, without MCP

To give Claude a video in the web app, upload a context pack: one Markdown file with the header, the chapters and the timed transcript, written for a model to read and cite. From a clone of the repo:

```sh
{{cli}} pack "https://www.youtube.com/watch?v=jNQXAC9IVRw" > context.md
```

Add `context.md` to the Project's files. This is that file for "Me at the zoo":

```markdown
{{demo.contextMd}}
```

`pack` also takes several links or a whole playlist and fits them into a token budget with `--max-tokens`.

## Long videos

A transcript costs about 12,000 tokens per hour. For long videos Claude can call `get_outline` first and read only the chapters it needs with `get_section`, or receive the transcript in pages with `maxTokens`.

---
title: Give ChatGPT a YouTube video
description: Turn a YouTube video or playlist into one Markdown context pack and upload it to a ChatGPT Project or custom GPT, with timestamps ChatGPT can cite. Free.
order: 3
---

ChatGPT cannot open YouTube links for you reliably, and it connects only to MCP servers reachable over HTTPS, not to local ones. The simple way that works today is a file: vid2context turns the video into one Markdown context pack with the transcript, timestamps and chapters, and you upload it.

## Make the context pack

{{chatgpt.steps}}

## What is in the file

This is the context pack for "Me at the zoo", exactly as vid2context renders it from a recorded run:

```markdown
{{demo.contextMd}}
```

The citation rule at the top tells ChatGPT how to cite: the video title, the `[m:ss]` time and the link. Each paragraph starts with its timestamp, so it has something precise to point at.

## Many videos at once

`pack` accepts several links and whole playlists, and fits the result into a token budget:

```sh
{{cli}} pack "https://www.youtube.com/playlist?list=PLHeawKfarQSPKIjpe86at3Ttc2sz7uD_b" --max-tokens 120000 > g-wagon.md
```

For every format at once (SRT, VTT, JSON, Markdown, the pack and a README for agents), make a .zip:

```sh
{{cli}} bundle "https://www.youtube.com/watch?v=jNQXAC9IVRw" -o me-at-the-zoo.zip
```

The zip for that video holds {{demo.fileList}}.

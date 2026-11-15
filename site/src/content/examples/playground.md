---
title: Library playground
label: Library playground
description: Run the vid2context core library in your browser on a real VideoContext: render every output format with its options, chunk, count tokens, clean the transcript and write your own code.
order: 7
---

Everything below runs `@vid2context/core`, the library behind the CLI, the MCP server and the HTTP API, in your browser. Pick a context, change an option and the output follows. The box under each operation shows the exact code it ran; **Edit as code** copies it into the code box, where you can change anything.

```widget playground
```

## What you can change

- **Context**: one of the real fixtures from the repo, a `VideoContext` you paste (the body of `GET /api/v1/context`), or one fetched live from this site's API or your own server.
- **Section and cleanup**: `getSection` cuts a time range or a chapter; `cleanTranscript` removes sound tags, rebuilds sentences and drops fillers. Both return new objects, so the raw transcript is never changed.
- **Operation**: `render` with each format's own options, `chunkTranscript`, `transcriptOutline`, `estimateTokens` across every format, `agentPrompt` and the cleanup report.
- **Your code**: an async function body with `core`, `context` and `secondary` in scope. It runs in a Web Worker with no access to this page.

The address bar keeps every choice and your code, so a copied link opens the same run. Pasted JSON stays on your machine and is never put in a link.

Token counts come from `estimateTokens`, a fast estimate made for budgets, not billing. [Read a long video by chapter](/docs/tutorials/long-videos/) does the same with outlines and sections through the API.

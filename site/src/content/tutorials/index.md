---
title: Tutorials
label: Overview
description: Step-by-step lessons for the vid2context HTTP API, with every request runnable in the page: transcripts, long videos, playlists, cited answers and your own files.
order: 0
---

Each tutorial is a short path through the HTTP API, one request at a time. Every request is a runnable block: edit the fields, press **Run**, and the response appears under it. Before you run anything, each block shows a real response recorded from a vid2context server, so you can read a tutorial end to end without running it.

## The tutorials

{{pages:tutorials}}

## How the Run button works

Every block calls the HTTP API directly from your browser. Pick where with the **Server** menu on any block (the choice applies to all of them and is remembered):

- **This site**: the API on the same host as these docs. On a deployment that serves both (the Cloudflare Worker in this repo does), this needs no setup.
- **Local server**: `http://127.0.0.1:8787`, a server you start from a clone of the repo. Start it so that this page may read its responses:

  ```sh
  git clone https://github.com/nirholas/vid2context.git
  cd vid2context
  npm install
  VID2CONTEXT_CORS_ORIGINS=https://vid2context.com npm run start:server
  ```

  Use this page's own address in `VID2CONTEXT_CORS_ORIGINS` if you read the docs somewhere else. Your browser may ask whether the site may reach devices on your local network; allow it.
- **Custom URL**: any other vid2context server. The gear button next to the menu sets the URL and an optional API key for servers that require one. The key stays in this browser tab and never appears in the snippets, which read `$VID2CONTEXT_API_KEY` instead.

Each block also shows the same request as curl, JavaScript, Python and, where one exists, the CLI command and the MCP tool call. The snippets follow your edits and the server you picked, so you can copy a request you have just tried.

**Share** copies a link to the block with your edits in it: whoever opens it sees the same fields, ready to run. **Reset** puts the fields back to the example's defaults. Press Ctrl+Enter (or Cmd+Enter) in any field to run the block without reaching for the button.

## Before you start

No account and no key are needed. Captions come straight from the platform; when a video has none, speech-to-text runs on free and keyless Whisper rungs, and answers and briefs run on the free LLM chain. Keys you add to a server only add more rungs, tried before the keyless ones. The [Examples](/docs/examples/) section has every request on its own, grouped by what it does.

## More to try

- [Library playground](/docs/examples/playground/): run the vid2context library in your browser on real contexts, with live formats, chunking and a code box.
- [Embed vid2context](/docs/embed/): put a searchable transcript, chapters, a quote or a video card on any page, and build the embed live in the page.

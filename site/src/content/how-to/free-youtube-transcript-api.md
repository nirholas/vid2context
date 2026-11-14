---
title: Free YouTube transcript API
description: A free, open-source HTTP API for YouTube transcripts with timestamps, metadata and chapters. Self-host it in one command; no YouTube API key needed.
order: 4
---

vid2context includes an HTTP API that returns the transcript of a YouTube video (or any supported video) in text, Markdown, SRT, VTT, JSON or a context pack. It is free and open source, and it needs no YouTube API key. Run it on your own machine, where YouTube does not block the requests.

## Run it

From a clone of the repo (Node.js 22 or newer):

```sh
git clone https://github.com/nirholas/vid2context.git
cd vid2context
npm install
npm run start:server
```

The server listens on `http://127.0.0.1:8787`.

## Get a transcript

```sh
curl "http://127.0.0.1:8787/api/v1/transcript?url=https://www.youtube.com/watch?v=jNQXAC9IVRw&timestamps=1"
```

The response, as vid2context renders it from a recorded run:

```text
{{demo.text}}
```

`format` picks the formatter:

{{formats.list}}

## Get everything as JSON

```sh
curl "http://127.0.0.1:8787/api/v1/context?url=https://www.youtube.com/watch?v=jNQXAC9IVRw"
```

This returns the full `VideoContext`: metadata, chapters, timed segments and every attempt that was made. The metadata part for "Me at the zoo":

```json
{{demo.metadataJson}}
```

## Errors you can act on

Every error has a stable code, a hint that says how to recover, and the attempts list:

```json
{
  "error": { "code": "not-found", "message": "YouTube xxxxxxxxxxx: ERROR (This video is unavailable)", "hint": "Check the video id or URL; the video may have been removed." },
  "attempts": [{ "id": "youtube", "stage": "metadata", "outcome": "error", "reason": "not-found", "detail": "..." }]
}
```

That example is from the [HTTP API contract](/docs/contracts/http-api/), which lists every route, parameter and error code.

## The hosted endpoint

The same API answers on this site at `https://vid2context.com/api/v1/`, and the [live demo](/#try) on the home page calls it. YouTube often blocks requests from cloud servers, so treat the hosted endpoint as a demo and self-host for real use: on [Docker](/docs/deploy/docker/), [Cloudflare](/docs/deploy/cloudflare/) or your own machine.

## Why it is free

Captions cost nothing to fetch. When a video has no captions, speech-to-text runs free-first: local models, then free tiers with your key, then keyless hosts. Paid services run only when you set their key. See [Providers and rungs](/docs/providers/).

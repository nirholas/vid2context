---
title: Your first transcript
label: Your first transcript
description: Get a video's transcript from the vid2context HTTP API in five runnable requests: plain text, timestamps, captions files, the full JSON context and how it was made.
order: 1
---

This tutorial takes one short video, "Me at the zoo" (19 seconds, the first video on YouTube), from a URL to a transcript an AI model can cite. Every step is a request you can run here.

## 1. Check the server

Start by asking the server what it is. `/health` needs no video and returns the version, the runtime, the output formats, and every provider and model rung with whether it can run.

```run health
```

## 2. Get the transcript

One request with the video URL returns the transcript as plain text. Any input a source understands works in `url`: a full YouTube link, a short `youtu.be` link, or the bare id `jNQXAC9IVRw`.

```run transcript
```

The first request for a video does the work: it reads the platform's captions (or, when there are none, downloads the audio and runs speech-to-text) and saves the result in the server's library. Later requests for the same video answer from the library, which is why the recorded time can be a few milliseconds.

## 3. Add timestamps

Agents cite moments, so they need times. `timestamps=1` prefixes each caption line with `[m:ss]`.

```run transcript-timestamps
```

## 4. Captions files

The same transcript renders in every format the server has. SRT and WebVTT are captions files for players and editors: at most two lines of 42 characters per cue, and no overlaps.

```run transcript-srt
```

Change **Format** to `markdown`, `json` or `vtt` and run it again; the snippets follow. The list comes from the server's formatter map, so `GET /api/v1/formats` always has the current one.

## 5. See how it was made

`/context` returns the whole `VideoContext` as JSON: the metadata and chapters, the timed segments, and two fields that matter when you build on it:

- `transcript.origin` says how much to trust the text: `creator-captions`, `auto-captions`, `native-transcript`, `stt` or `video-model`.
- `attempts` lists every provider and rung that was tried, in order, with the outcome and, for failures, the reason.

```run context
```

The response carries an `ETag`. Send it back as `If-None-Match` and an unchanged context answers `304` with no body.

## When something fails

Errors have one shape on every route: a stable `code`, a `message`, a `hint` that says how to recover, and the same `attempts` list.

```run transcript-error
```

## Next

- [Read a long video by chapter](/docs/tutorials/long-videos/), without sending the whole transcript to a model.
- [All transcript requests](/docs/examples/transcripts/): languages, translation, sponsor removal and captions-only mode.

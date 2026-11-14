---
title: Transcripts
label: Transcripts
description: Runnable transcript requests for the vid2context HTTP API: plain text, timestamps, SRT, WebVTT, Markdown and JSON, languages, translation, sponsor removal and captions-only mode.
order: 1
---

All of these call `GET /api/v1/transcript` with different parameters. The CLI equivalent is `{{cli}} <url>` with the same flags, and agents use the MCP tool `get_transcript`.

## Plain text

```run transcript
```

## With timestamps

```run transcript-timestamps
```

## SRT captions

```run transcript-srt
```

## WebVTT captions

```run transcript-vtt
```

## Markdown

Title and metadata first, chapters as headings, and paragraphs that start with timestamp links.

```run transcript-markdown
```

## JSON

The full `VideoContext`: metadata, chapters, timed segments, and how the transcript was produced.

```run transcript-json
```

## Captions only

`mode=captions` never downloads audio. When a video has no captions it fails at once with `no-transcript`, which is what you want for a quick, cheap check. `mode=stt` does the opposite and always transcribes the audio.

```run transcript-captions-only
```

## Translate

`lang` with `translate=1` returns the transcript in that language. The platform's own track or translation is used when there is one; otherwise an LLM translates it on the free chain, keeping every segment and timestamp. `X-Translated-Via` says which happened. The stored transcript is never replaced.

```run transcript-translate
```

## Remove sponsor segments

`skip` cuts SponsorBlock segments from a copy of the transcript: name the categories (`sponsor`, `selfpromo`, `intro`, `outro`, `interaction` and others), or send `skip=1` for the default set. This video's self-promotion and outro are gone from the response; compare the last timestamps with the [segments](/docs/examples/structure/#sponsorblock-segments) that were removed.

```run transcript-skip
```

## The full context

`GET /api/v1/context` returns the same `VideoContext` as the JSON format, with an `ETag` for caching.

```run context
```

## Errors

```run transcript-error
```

Every error has this shape. [Call the API from your code](/docs/tutorials/api-from-code/) lists the codes and which ones to retry.

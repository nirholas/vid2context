---
title: Video structure
label: Video structure
description: Runnable requests for a video's structure: metadata, outlines with token counts, single chapters and time ranges, comments, caption languages, SponsorBlock segments, generated chapters and key moments.
order: 2
---

These requests read the parts of a video around the transcript, or one piece of it.

## Metadata only

Title, channel, duration, chapters and tags, without fetching captions or audio.

```run metadata
```

## Outline

Chapters with start times, timestamp links and token counts, so an agent can pick what to read.

```run outline
```

## Outline of a video without chapters

```run outline-sections
```

## One chapter

```run section-chapter
```

## A time range

```run section-time
```

## Top comments

The source's own comment order, with likes, the pinned flag and replies. Raise `limit` for more (up to 1000).

```run comments
```

## Caption languages

```run caption-languages
```

## SponsorBlock segments

Sponsor reads, self-promotion, intros, outros and reminders, with their times and the share of the transcript each covers. Segment data comes from SponsorBlock under CC BY-NC-SA 4.0, and the response says so.

```run skips
```

## Generate chapters

For a video without chapters, an LLM on the free chain proposes chapter titles from the transcript. A video that already has chapters answers `bad-request` unless you send `force: true`.

```run chapters-auto
```

## Key moments

```run key-moments
```

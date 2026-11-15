---
title: Many videos at once
label: Many videos at once
description: Expand a playlist, put several videos into one context pack, download every format as a zip, and find where a topic comes up across videos, all as runnable requests.
order: 3
---

Research rarely stops at one video. This tutorial expands a YouTube playlist of G-Wagon buyer videos, turns videos into one document a model can read, and searches across them.

## 1. Expand a playlist

`/items` turns a playlist, a channel or a podcast feed into a list of video references. A single video lists as itself, so you can send any input through this step.

```run items
```

## 2. One pack for several videos

`POST /pack` takes a list of inputs and returns one Markdown document with every video's metadata, chapters and transcript, sized by `maxTokens`. Playlists in the list are expanded first. When one video fails, the others still go in, and the failure is listed under "Not included" so the model knows what is missing.

```run pack-many
```

## 3. Every format in a zip

`/bundle` returns a zip: `context.md` (the pack), the transcript in each format you ask for, the metadata, and a README that tells an agent what each file is. The block lists the files; when you run it, **Download** saves the zip.

```run bundle
```

`POST /bundle` takes the same `inputs` list as `POST /pack` for a zip of many videos.

## 4. Find a topic across videos

`POST /research` finds where words come up in each video and returns ranked excerpts with the surrounding context and timestamp links. It reads the videos itself, so it needs nothing saved first.

```run research
```

## 5. Search everything you have read

Every video a request has read is saved in the server's library. `/search` searches all of them at once, with `"exact phrases"` and `-excluded` words.

```run search
```

On a server with an embedding model configured, the same route also runs a vector search and merges the two lists; the response's `meta` says which sides ran.

## Next

- [Build a research collection](/docs/tutorials/collections/): keep these videos together under one id, then pack, export and share them.
- [Cited answers and briefs](/docs/tutorials/cited-answers/) from the same videos.
- [Many-video examples](/docs/examples/many-videos/) on one page.

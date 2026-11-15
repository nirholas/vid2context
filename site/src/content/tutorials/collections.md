---
title: Build a research collection
label: Build a collection
description: Group videos into a named vid2context collection, read it back, turn it into one context pack, export Obsidian notes and share the definition, all as runnable requests that chain into each other.
order: 4
---

A collection is a named group of videos in the server's library: the G-Wagon buyer videos, one course's lectures, a channel you follow. Once videos are in a collection, one id stands for all of them, in a context pack, a zip, an export or a search. This tutorial builds one from two G-Wagon buyer videos.

The steps chain: run step 1 and its collection id fills in every block below it. Until you run it, each block shows the response recorded when this tutorial was written.

## 1. Create the collection

`POST /collections` needs only a `name`. `sources` is optional: playlists, channels or feeds the collection follows, so that a refresh adds their new videos. Change the name if you like; the id is the name as a slug plus a random suffix, so two collections never collide.

```run collection-create
```

## 2. Add videos

`POST /collections/{id}/items` takes a list of inputs. Each video is read once (captions first, then speech-to-text) and saved in the library, so the steps below never contact YouTube again. A playlist in the list adds each of its videos.

With a jobs queue, the server answers `202` and a Job right away, and the block polls `GET /jobs/{id}` until it finishes. The finished job's `result.summary` lists the videos that were added and those that failed (with the reason), and counts the ones it skipped.

```run collection-add
```

Try adding the [playlist](https://www.youtube.com/playlist?list=PLHeawKfarQSPKIjpe86at3Ttc2sz7uD_b) itself: put its URL on a line of its own and run the block again. Videos already in the collection are skipped and counted, not read twice.

## 3. Read it back

`GET /collections/{id}` returns the collection with a summary of each video: title, channel, duration, language, and `origin`, which says how its transcript was made.

```run collection-get
```

## 4. One pack for the whole collection

`POST /pack` with `collectionId` instead of `inputs` builds one Markdown document from every video in the collection, sized by `maxTokens`. Paste it into any chat model, or have an agent read it: the citation rule at the top tells the model to cite each claim as a timestamp link.

```run collection-pack
```

`POST /bundle` takes the same `collectionId` for a zip with every format, and `GET /search?collectionId=<id>` searches only this collection's transcripts.

## 5. Notes for Obsidian

`POST /exports/obsidian` turns videos into Markdown notes with frontmatter, chapter headings and timestamp links, plus an index note. The server writes nothing: the answer holds the files, for you or your agent to save into a vault. The MCP tool `export_obsidian` writes them into a vault path for you.

The block exports one video. Paste your collection id from step 1 into **Collection id** to export every video in the collection as well.

```run obsidian-export
```

## 6. Share the definition

`GET /collections/{id}/export` returns a small, portable definition: the name, the sources, the video URLs and the refresh schedule. Send it to another vid2context server with `POST /collections/import` (add `?refresh=1` to read the videos right away) and that server rebuilds the same collection from the platforms.

```run collection-export
```

## Keep it up to date

A collection with `sources` can refresh itself. `PATCH /collections/{id}` with a `watch` schedule (for example `{"every": "daily", "at": "06:00"}`, in UTC) checks the sources on that schedule and adds new videos, and a webhook can tell you when it did. The [collections guide](/docs/guides/collections/) covers schedules, webhooks and limits.

## Next

- [Cited answers and briefs](/docs/tutorials/cited-answers/): ask questions across the videos you just collected.
- [Collections and library examples](/docs/examples/collections/): every request on one page, plus the library itself.

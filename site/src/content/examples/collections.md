---
title: Collections and library
label: Collections and library
description: Runnable requests for vid2context collections and the saved-video library: create a collection, add videos, read it, pack it, export Obsidian notes and the definition, list and read saved videos.
order: 4
---

Every video a request reads is saved in the server's library. Collections are named groups of saved videos that one id stands for. The blocks on this page chain: run **Create a collection** and its id fills in the blocks after it. The CLI equivalents are `{{cli}} collection ...` and `{{cli}} library ...`, and agents use the MCP tools `create_collection`, `add_to_collection` and `get_collection`.

## Create a collection

```run collection-create
```

## Add videos

```run collection-add
```

## Read a collection

```run collection-get
```

## Pack a collection

```run collection-pack
```

## Export Obsidian notes

```run obsidian-export
```

## Export the definition

```run collection-export
```

## List the library

```run library
```

## Read one saved video

```run library-item
```

Saved videos answer without contacting the platform. `GET /context?url=...&refresh=1` reads a video again and replaces the saved copy. [Build a research collection](/docs/tutorials/collections/) walks through these requests in order.

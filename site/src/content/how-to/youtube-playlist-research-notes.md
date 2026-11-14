---
title: Turn a YouTube playlist into research notes
label: Playlist into research notes
description: Turn a whole YouTube playlist into research notes your agent can cite by episode and timestamp, from the command line or over MCP. Free.
order: 6
requires: playlist
---

A buying decision, a course or a conference often lives in a playlist. vid2context expands the playlist into its videos, fetches every transcript with timestamps, and gives your agent one document (or a set of tools) to research across all of them, citing the episode and the moment for each claim.

The example here is "{{playlist.title}}", a {{playlist.count}}-video series on choosing a Mercedes G-Wagon.

## See what is in the playlist

```sh
{{cli}} list "{{playlist.url}}"
```

The YouTube source lists these videos (replayed from a recorded response when this site was built):

```text
{{playlist.list}}
```

## One file for your agent

`pack` expands the playlist, fetches each transcript and writes one Markdown context pack sized to a token budget:

```sh
{{cli}} pack "{{playlist.url}}" --max-tokens 150000 > g-wagon.md
```

Upload `g-wagon.md` to a Claude or ChatGPT Project and ask:

> Which G-Wagon model year should I buy for reliability, and what mileage is too high? Cite the episode and timestamp for every claim.

Every paragraph in the pack starts with its timestamp, and the pack's citation rule tells the model to cite `[Title @ m:ss](link)`. To get every format per video instead, use `bundle` with `-o g-wagon.zip`.

## Let the agent do the research

With the [MCP server](/docs/how-to/youtube-transcript-mcp-server/) connected, the agent can work on the playlist itself:

- `list_items` expands the playlist into its videos.
- `research_videos` searches up to 10 videos for a question and returns only the relevant excerpts, each with its timestamp link.
- `export_context_pack` writes the same pack as the CLI.
- `build_brief` writes a cited brief across the videos with a free LLM.
- `create_collection` and `add_to_collection` keep the playlist as a collection you can search later with `search_transcript`.

Collections live in the library, so they need a storage backend that persists (SQLite by default on Node); without one they last only for the process.

## What a transcript looks like

The last video in the playlist is "{{gwagon.title}}" ({{gwagon.duration}}, {{gwagon.segments}} caption lines). These are its first lines as the agent receives them, from a recorded run:

```text
{{gwagon.header}}

{{gwagon.textExcerpt}}
```

The captions are YouTube's automatic ones, so they are lowercase and unpunctuated, but each line carries its time, which is what makes citations possible.

## Keep it current

A collection can follow the playlist: `{{cli}} collection create "G-Wagon" --source "{{playlist.url}}"`, then `collection refresh <id>` fetches only the videos added since the last run.

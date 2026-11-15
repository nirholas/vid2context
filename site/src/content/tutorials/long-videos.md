---
title: Read a long video by chapter
label: Long videos by chapter
description: Read long videos without sending the whole transcript to a model: an outline with token counts, then one chapter or time range, or a context pack sized to a token budget.
order: 2
---

Speech runs at about 12,000 tokens per hour of video. A model can read that, but it rarely needs all of it, and long transcripts crowd out everything else in its context. The pattern that works: look at the outline first, then fetch only the part you need.

The MCP server gives agents the same steps as tools (`get_outline`, then `get_section`), and each block below shows the tool call next to the HTTP request.

## 1. Look at the outline

`/outline` lists the chapters with their start times, timestamp links and an estimate of the tokens in each. For "Me at the zoo" these are the creator's three chapters.

```run outline
```

## 2. Videos without chapters

When a video has no chapters, the outline splits it into sections of about five minutes, cut where the speech pauses, so the same next step works on any video. Up to about seven minutes of speech stays one section, as in this 7:26 video; a longer one gets one entry per five minutes or so.

```run outline-sections
```

## 3. Fetch one chapter

`/section` returns one chapter of the transcript, by its outline index (`0`, `1`, ...) or by its title. A title matches exactly first, then as a prefix, then as a substring, so `cool` would find "The cool thing" too.

```run section-chapter
```

## 4. Or a time range

`from` and `to` take seconds (`300`), `m:ss` (`5:00`) or `h:mm:ss`. `to` is exclusive. This is the sixth minute of an 18-minute G-Wagon buyer's guide.

```run section-time
```

## 5. Fit a token budget

When a model should see the whole video but has a fixed budget, ask for a context pack. `maxTokens` sets the size: the pack keeps the metadata, the chapters and the citation rule, shortens the description, and cuts the transcript where the budget runs out. Each cut is marked with what was left out, so the model knows which section to fetch next.

```run pack
```

The pack starts with a citation rule written for the model: cite moments as `[Title @ m:ss](link)`, with links that open the video at that second.

## Next

- [Many videos at once](/docs/tutorials/many-videos/): playlists, one pack for several videos, and a zip with every format.
- [Structure examples](/docs/examples/structure/): metadata, comments, caption languages, SponsorBlock segments and generated chapters.

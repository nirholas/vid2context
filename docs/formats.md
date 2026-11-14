# Output formats

Every surface (CLI `--format`, MCP tools, HTTP API, web app, .zip bundle) renders through the `formatters` map in [packages/core/src/format/index.ts](../packages/core/src/format/index.ts). `render(context, id, opts)` renders one video. `renderMany(contexts, id, opts)` renders several videos as one document, for formats that support it (today: `pack`); other formats throw a `bad-request` error whose hint lists the ones that do.

Options (`FormatOptions`), all optional:

| Option | Used by | Meaning |
|---|---|---|
| `timestamps` | `text` | Prefix each caption line with `[m:ss]`. |
| `linkTimestamps` | `markdown`, `pack` | Timestamps are links into the video where the platform allows. Default true. |
| `includeComments` | `markdown`, `pack` | Add fetched comments. `markdown`: off unless true. `pack`: on unless false. |
| `includeVisual` | `markdown`, `pack` | Add on-screen notes. `markdown`: off unless true. `pack`: on unless false. |
| `maxTokens` | `pack` | Token budget, measured with `estimateTokens` from `packages/core/src/tokens.ts`. |

Timestamps use `h:mm:ss` throughout a video's output when the video is an hour or longer, and `m:ss` otherwise. Caption text has HTML entities decoded (including double-encoded ones such as `&amp;#39;`) and control characters removed.

The samples below are real output for "Me at the zoo" (`tests/fixtures/contexts/youtube-jNQXAC9IVRw.json`).

## text

Plain transcript text, one paragraph. With `timestamps`, one `[m:ss] line` per caption. Extension `txt`.

```
[0:01] All right, so here we are, in front of the elephants
[0:05] the cool thing about these guys is that they have really...
```

## json

The full `VideoContext`: metadata, chapters, timed segments, comments and visual notes when fetched, and every attempt that produced the transcript. Extension `json`.

## markdown

A readable transcript for people and agents. Extension `md`.

- Title, then a metadata list: channel (linked when known), published date, duration, source URL, language, and how the transcript was made ("auto-captions from youtube-captions", "speech-to-text by ...", plus "machine-translated" when it was).
- A `## Description` excerpt of at most 600 characters, cut on a word boundary, with a note when it was shortened.
- Chapters as `##` headings at their start times. Videos without chapters get one `## Transcript` heading.
- Paragraphs grouped from segments: a paragraph ends on a sentence end or a pause of 1.5 s or more once it holds 30 s or 120 words, always ends at 90 s or 160 words, and never splits a segment. Each starts with a timestamp link. When segments carry speakers, every speaker change starts a new paragraph prefixed with `**Speaker:**`.
- `## On screen` and `## Comments` sections when the data exists and the option is set.

```markdown
# Me at the zoo

- Channel: [jawed](https://www.youtube.com/channel/UC4QobU6STFB0P71PMvOGN5A)
- Duration: 0:19
- Source: https://www.youtube.com/watch?v=jNQXAC9IVRw
- Language: en
- Transcript: creator captions from youtube-captions

## Intro (0:00)

[0:01](https://www.youtube.com/watch?v=jNQXAC9IVRw&t=1s) All right, so here we are, in front of the elephants
```

## srt

SubRip captions for players and video editors. Extension `srt`.

- Cues numbered from 1, timings `HH:MM:SS,mmm --> HH:MM:SS,mmm`.
- At most 2 lines of at most 42 characters per cue. Long segments become several cues of about equal length, with the segment's time shared out in proportion to text length.
- No overlapping or zero-length cues: each cue ends no later than the next one starts, and lasts at least 0.5 s when the gap to the next cue allows it.
- Plain text. When segments carry speakers, the first cue of each turn starts with `Speaker: `.

```
1
00:00:01,200 --> 00:00:03,360
All right, so here we are,
in front of the elephants
```

## vtt

WebVTT captions for the HTML `<track>` element. Extension `vtt`. Same cue rules as `srt`, plus:

- A `NOTE` block with the title, source URL and how the transcript was made.
- `&`, `<` and `>` escaped in cue text, and `<v Speaker>` voice tags when segments carry speakers.

```
WEBVTT

NOTE
Me at the zoo
Source: https://www.youtube.com/watch?v=jNQXAC9IVRw
Transcript: creator captions from youtube-captions

00:00:01.200 --> 00:00:03.360
All right, so here we are,
in front of the elephants
```

## pack

The context pack: one Markdown file for one or many videos, written for the model that reads it. Upload it to a Claude or ChatGPT Project, a custom GPT, or hand it to an agent. Extension `md`. `render(context, 'pack')` is the one-video case of `renderMany`.

- A header saying what the document is, how many videos and their total duration, and the citation rule: cite as `[Title @ m:ss](link)`.
- A table of contents with anchors when there are two or more videos.
- Per video: metadata, description (up to 1500 characters), chapter list with timestamp links, on-screen notes and comments when present, then the transcript as timestamped paragraphs (same grouping as `markdown`, chapter titles as `####` headings).

With `maxTokens`, the pack never exceeds the budget. It degrades in this order and stops as soon as it fits:

1. Drop comments.
2. Drop on-screen notes.
3. Link one timestamp in three (the others stay as plain `[m:ss]`).
4. Shorten descriptions to 200 characters.
5. Cut each transcript in proportion to its length, at paragraph boundaries.

Every cut leaves a marker, so nothing disappears silently, for example `> The rest, 13:38 to 18:05, is omitted for length. Fetch it with the get_section tool or the full transcript.` When even the headers do not fit, it throws `bad-request` with a hint naming the smallest budget that works.

```markdown
# Video context pack

This document holds the transcripts and metadata of one video (0:19 in total), prepared by vid2context for an AI model to read. ...

Citation rule: when you use something from a video, cite it as [Title @ m:ss](link), using the time and link of the paragraph you drew on (or [Title @ m:ss] when the video has no link).

## Me at the zoo
...
### Chapters

- [0:00](https://www.youtube.com/watch?v=jNQXAC9IVRw&t=0s) Intro
- [0:05](https://www.youtube.com/watch?v=jNQXAC9IVRw&t=5s) The cool thing
- [0:17](https://www.youtube.com/watch?v=jNQXAC9IVRw&t=17s) End
```

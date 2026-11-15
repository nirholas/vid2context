# Output formats

Every surface (CLI `--format`, MCP tools, HTTP API, web app, .zip bundle) renders through the `formatters` map in [packages/core/src/format/index.ts](../packages/core/src/format/index.ts). `render(context, id, opts)` renders one video. `renderMany(contexts, id, opts)` renders several videos as one document, for formats that support it (today: `pack`); other formats throw a `bad-request` error whose hint lists the ones that do.

Options (`FormatOptions`), all optional:

| Option | Used by | Meaning |
|---|---|---|
| `timestamps` | `text` | Prefix each caption line with `[m:ss]`. |
| `offsetSec` | `srt`, `vtt`, `ass`, `ttml`, `sbv`, `lrc`, `csv`, `text` with `timestamps` | Shift every timestamp by this many seconds (negative moves earlier), to fit a cut or re-encoded copy of the video. Cues that end at or before 0 are dropped; a cue that starts before 0 is clamped to start at 0. Not a number: `bad-request`. |
| `maxLineChars` | `srt`, `vtt`, `ass`, `ttml`, `sbv`, `lrc` | Longest caption line in characters. Default 42, clamped to 10..200. |
| `maxLines` | `srt`, `vtt`, `ass`, `ttml`, `sbv`, `lrc` | Most lines per cue. Default 2, clamped to 1..4. |
| `secondary` | `srt`, `vtt`, `ass`, `ttml`, `sbv`, `text`, `csv` | A second `Transcript` of the same video, usually a translation, for bilingual subtitles. See [Bilingual subtitles](#bilingual-subtitles). |
| `linkTimestamps` | `markdown`, `pack` | Timestamps are links into the video where the platform allows. Default true. |
| `includeComments` | `markdown`, `pack` | Add fetched comments. `markdown`: off unless true. `pack`: on unless false. |
| `includeVisual` | `markdown`, `pack` | Add on-screen notes. `markdown`: off unless true. `pack`: on unless false. |
| `maxTokens` | `pack` | Token budget, measured with `estimateTokens` from `packages/core/src/tokens.ts`. |

Each formatter declares `timed` (`'always'`, or `'timestamps'` for `text`) when `offsetSec` applies, and `bilingual: true` when it shows `secondary`, so a surface can offer only the options that do something. `shiftSegments(segments, offsetSec)` is exported for code that needs the same shift outside a formatter.

Timestamps use `h:mm:ss` throughout a video's output when the video is an hour or longer, and `m:ss` otherwise. Caption text has HTML entities decoded (including double-encoded ones such as `&amp;#39;`) and control characters removed.

The samples below are real output for "Me at the zoo" (`tests/fixtures/contexts/youtube-jNQXAC9IVRw.json`).

## text

Plain transcript text, one paragraph. With `timestamps`, one `[m:ss] line` per caption. Extension `txt`. When segments carry speakers, each turn starts with `Speaker: ` (a new paragraph per turn without `timestamps`). With `secondary`, the second-language text follows each caption on its own line.

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

## ass

Advanced SubStation Alpha (v4.00+) for mpv, VLC, ffmpeg burn-in and Aegisub. Extension `ass`, type `text/x-ssa`. Same cue rules as `srt`.

- `[Script Info]` with `PlayResX: 1920` and `PlayResY: 1080`, then `[V4+ Styles]` with a readable `Default` style (white Arial 64, black outline and shadow, bottom center) and a smaller pale yellow `Secondary` style, then `[Events]` with one `Dialogue` per cue.
- Times `H:MM:SS.cc`, lines joined with `\N`, the speaker in the Name field.
- `{` and `}` are written `\{` and `\}` so text never opens an override block; a backslash gets a word joiner (U+2060) after it so text like `\N` stays literal.
- With `secondary`, the second language follows in the same Dialogue after `{\rSecondary}`, so it always sits under the primary text.

```
[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:01.20,0:00:03.36,Default,,0,0,0,,All right, so here we are,\Nin front of the elephants
```

## ttml

TTML 1 in the IMSC 1 text profile style, for broadcast, streaming packagers and players that read TTML or DFXP. Extension `ttml`, type `application/ttml+xml`. Same cue rules as `srt`.

- `<tt xmlns="http://www.w3.org/ns/ttml" xml:lang="...">` with the title and source in `<metadata>`, a default and a `secondary` style, and a bottom region.
- One `<p begin end>` per cue with `HH:MM:SS.mmm` clock times and `<br/>` between lines. Text is XML-escaped, and characters XML 1.0 forbids are dropped. Speakers as `Speaker: ` at each turn.
- With `secondary`, a `<span style="secondary" xml:lang="..">` after the primary lines.

```xml
<p begin="00:00:01.200" end="00:00:03.360">All right, so here we are,<br/>in front of the elephants</p>
```

## sbv

YouTube SubViewer, the format YouTube Studio imports and exports. Extension `sbv`. Same cue rules as `srt`: a `H:MM:SS.mmm,H:MM:SS.mmm` line, the text lines, a blank line. Speakers as `Speaker: `; `secondary` lines follow the primary ones.

```
0:00:01.200,0:00:03.360
All right, so here we are,
in front of the elephants
```

## lrc

LRC timed lyrics for music players and karaoke apps. Extension `lrc`.

- Header tags `[ti:]` (title), `[ar:]` (channel) and `[length:]` when the duration is known.
- One `[mm:ss.xx]text` line per cue, its lines joined by a space; minutes keep counting past 59.
- LRC has no end times, so a gap of 1 s or more before the next cue (and the end of the last cue) gets an empty timed line that clears the text.
- `secondary` is not shown: LRC has no two-language convention that players agree on.

```
[ti:Me at the zoo]
[ar:jawed]
[length:00:19]
[00:01.20]All right, so here we are, in front of the elephants
[00:03.36]
[00:05.32]the cool thing about these guys is that they have really...
```

## csv

One row per segment for spreadsheets and data tools. Extension `csv`, type `text/csv`.

- Header `start,end,speaker,text`, plus `secondary_text` when `secondary` is given. Times in seconds with 3 decimals.
- RFC 4180: CRLF line ends; fields with a comma, double quote or line break are quoted, with inner quotes doubled.
- Caption text comes from third parties, so a field a spreadsheet would run as a formula (starting with `=`, `+`, `@`, or `-` not followed by a space) gets a leading apostrophe. A dialogue dash (`- Hi`) is kept.

```
start,end,speaker,text
1.200,3.360,,"All right, so here we are, in front of the elephants"
5.318,7.974,,the cool thing about these guys is that they have really...
```

## Bilingual subtitles

Pass a second transcript of the same video as `secondary` (for example the output of the translate package, or another caption track) to get dual-language output. This is how translated tracks are combined:

- Each secondary segment goes to exactly one primary segment: the one it overlaps most in time, or the nearest one when it overlaps none. A primary segment shows the text of every secondary segment it received, joined in time order. So no secondary text is lost or repeated, and a translation on the source timings lines up one to one.
- In cue formats the secondary text is shared out over the segment's cues like the primary text, and both languages keep the `maxLineChars` and `maxLines` limits; a long translation can add cues.
- `srt` and `sbv` add the secondary lines under the primary ones, `vtt` adds them as separate lines (and names the second language in the NOTE), `ttml` adds a `secondary` span, `ass` uses the smaller `Secondary` style, `text` adds a line under each caption and `csv` a `secondary_text` column.
- `offsetSec` shifts both transcripts.

Real output for "Me at the zoo" with its German creator track as `secondary`:

```
3
00:00:07,974 --> 00:00:12,616
really really long trunks
Das Coole an den Typen ist dass sie
sehr, sehr, sehr, lange Rüssel haben.
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

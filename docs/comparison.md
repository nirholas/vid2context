# vid2context compared

How vid2context relates to the tools people usually reach for when they need a video's words, and when one of those is the better choice. Facts about other projects come from [prior-art.md](prior-art.md), checked against their repositories on 2026-11-14; follow the links for their current state.

Side-by-side pages with worked examples are on the site: [vs youtube-transcript-api](https://vid2context.com/docs/compare/youtube-transcript-api/), [vs yt-dlp](https://vid2context.com/docs/compare/yt-dlp/), [vs plain Whisper](https://vid2context.com/docs/compare/whisper/) and [vs YouTube transcript MCP servers](https://vid2context.com/docs/compare/youtube-mcp-servers/).

## At a glance

| | What it is | Sources | No captions? | For agents |
|---|---|---|---|---|
| **vid2context** | MCP server, CLI, HTTP API, web app and TypeScript library | YouTube (videos, Shorts, playlists, channels), X posts, podcasts, Bilibili, Vimeo, Loom, Wistia, direct media links, cloud share links, local files, and the 1,000+ sites yt-dlp supports | Speech-to-text: local Whisper first, then free tiers, then keyless hosts | 28 MCP tools (transcript, outline, sections, search, Q&A, briefs), context packs, citations with timestamp links |
| [youtube-transcript-api](https://github.com/jdepoix/youtube-transcript-api) | Python library and CLI | YouTube | No transcript | Bring your own |
| [mcp-server-youtube-transcript](https://github.com/kimtaeyoon83/mcp-server-youtube-transcript) | MCP server | YouTube | No transcript | `get_transcript` |
| [mcp-youtube-transcript](https://github.com/jkawamoto/mcp-youtube-transcript) | MCP server (Python) | YouTube | No transcript | Timed transcript with paging |
| [transcriptor-mcp](https://github.com/samson-art/transcriptor-mcp) | MCP server | 11 platforms via yt-dlp | Whisper | Transcripts, frames, playlists |
| [summarize](https://github.com/steipete/summarize) | CLI and Chrome extension | YouTube, podcasts, web pages | Transcription | Summaries |
| [yt-dlp](https://github.com/yt-dlp/yt-dlp) | Downloader | 1,000+ sites | Subtitle files only | None (vid2context uses it as a provider) |

## What vid2context does differently

- **Free first, and it says what it used.** Every result lists each provider it tried and why it moved on (`attempts`), and the order is fixed: local models, then free tiers with your key, then keyless hosts, paid APIs last and only when allowed. With no keys at all, captions and speech-to-text still work.
- **The raw transcript is never replaced.** Summaries, briefs, translations and cleanup are added layers next to it, so an agent can always quote the source.
- **Built for agents that cite.** Outlines with token counts let an agent read only the chapters it needs (about 12k tokens per hour of speech), and every line carries a timestamp that links back to the moment in the video.
- **Many sources, one shape.** A YouTube video, an X post, a podcast episode and a local file all come back as the same `VideoContext`, in text, JSON, Markdown, SRT or VTT.
- **Runs where you need it.** Node, Cloudflare Workers (the public instance at [vid2context.com](https://vid2context.com) is one), the browser, Docker, or behind a Cloudflare Tunnel from a home machine.
- **Long and messy audio.** Audio of any length is split, transcribed in parallel and stitched with exact timestamps; Whisper decoder loops are detected and re-transcribed instead of silently replacing speech ([long-audio.md](long-audio.md)).

## When to use something else

- **You only need YouTube captions inside a Python script.** youtube-transcript-api is one small dependency and does exactly that. vid2context's [Python client](../clients/python) talks to a vid2context server instead.
- **You want the media file itself.** yt-dlp is the downloader. vid2context's `download` command wraps it, but if you never need transcripts, use yt-dlp directly.
- **You want a one-line summary in a browser tab.** summarize's Chrome extension is built around that. vid2context focuses on giving agents the full text to reason over.
- **You need a hosted transcript API with an SLA.** vid2context is self-hosted software with a free public instance; the [Supadata provider](providers.md) can be one of its rungs if you want a hosted service behind it.

## Common questions

**Is vid2context a YouTube transcript API?** Yes, and more: the HTTP API (`vid2context serve`, OpenAPI at `/api/v1/openapi.json`) returns transcripts for every source above. See [guides/http-api.md](guides/http-api.md).

**Which MCP server should I use for YouTube in Claude, Cursor or VS Code?** Any of the YouTube transcript servers above fetches captions. Choose vid2context when videos lack captions, when you need other sites (X, podcasts, local files), or when your agent should read long videos chapter by chapter. Setup: [guides/mcp.md](guides/mcp.md).

**Can I transcribe X (Twitter) videos?** Yes, from the post link with no account: [guides/x.md](guides/x.md).

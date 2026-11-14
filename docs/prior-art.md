# Prior art and reusable code

Open-source projects doing similar work, checked on 2026-11-14 against the live GitHub and npm APIs. Licenses were read from each repo's LICENSE file, not the badge. Stars and weekly npm downloads are as of that date.

## License rules for reuse

| License | What we may do |
|---|---|
| MIT, ISC, BSD, 0BSD, Unlicense | Add as a dependency, or copy code. When copying, keep the original copyright line in a comment at the top of the copied file and add the project to `THIRD_PARTY_NOTICES.md`. |
| Apache-2.0 | As above, and keep the project's NOTICE text (if it has one) in `THIRD_PARTY_NOTICES.md`. State changes in the copied file's header. |
| GPL, AGPL, LGPL, or no LICENSE file | Ideas only. Do not copy code, do not add as a dependency. A `license` field in package.json without a LICENSE file is not enough. |
| CC BY-NC-SA (data, e.g. SponsorBlock) | Use the data with attribution, non-commercially. A paid hosted plan must not depend on it. |

## Projects

| Project | Stars or npm/week | Last activity | Lang | License | What it offers vid2context | Reuse |
|---|---|---|---|---|---|---|
| [LuanRT/YouTube.js](https://github.com/LuanRT/YouTube.js) (npm `youtubei.js`) | 5.4k, 261k/wk | 2026-11 | TS | MIT | Full innertube client: captions, chapters, comments, playlists, search, on Node, Deno, Workers and browsers | dependency or copy |
| [LuanRT/BgUtils](https://github.com/LuanRT/BgUtils) (npm `bgutils-js`) | 350, 90k/wk | 2026-10 | TS | MIT | Generates PO tokens (YouTube's anti-bot proof) | dependency |
| [yt-dlp/ejs](https://github.com/yt-dlp/ejs) | 484 | 2026-10 | TS | Unlicense | yt-dlp's JS signature and n-parameter solver, multi-runtime | copy |
| [jdepoix/youtube-transcript-api](https://github.com/jdepoix/youtube-transcript-api) | 8.6k | 2026-11 | Py | MIT | Error taxonomy (IpBlocked, RequestBlocked) with recovery hints, translated tracks, proxy and cookie options, SRT/VTT formatters (`_errors.py`, `_transcripts.py`) | port |
| [ericmmartin/youtube-transcript-plus](https://github.com/ericmmartin/youtube-transcript-plus) | 169, 28k/wk | 2026-11 | TS | MIT | Transcript fetcher that accepts a custom fetch (fits `ctx.fetch`) | copy |
| [devhims/youtube-caption-extractor](https://github.com/devhims/youtube-caption-extractor) | 175, 20k/wk | 2026-10 | TS | MIT | Captions and metadata for edge runtimes | copy |
| [Kakulukian/youtube-transcript](https://github.com/Kakulukian/youtube-transcript) | 589, 214k/wk | 2026-04 | TS | no LICENSE file | Minimal transcript fetcher | ideas only |
| fent/node-ytdl-core | 4.7k | 2023-07 | JS | MIT | Abandoned (paused since 2023) | skip |
| @distube/ytdl-core | 95k/wk | 2026-11 | JS | MIT in package.json; repo returns 404 | Maintained fork, unverifiable source | avoid |
| YunzheZJU/youtube-po-token-generator | 141 | 2025-08 | JS | no LICENSE file | PO tokens | ideas only |
| Brainicism/bgutil-ytdlp-pot-provider | 904 | 2026-10 | TS | GPL-3.0 | PO token server for yt-dlp | ideas only |
| [kimtaeyoon83/mcp-server-youtube-transcript](https://github.com/kimtaeyoon83/mcp-server-youtube-transcript) | 604 | 2026-07 | TS | MIT | MCP: `get_transcript` with `strip_ads`, `max_tokens` | copy |
| [ZubeidHendricks/youtube-mcp-server](https://github.com/ZubeidHendricks/youtube-mcp-server) | 598 | 2026-08 | TS | MIT | MCP over the Data API: channels, playlists, search | copy |
| [anaisbetts/mcp-youtube](https://github.com/anaisbetts/mcp-youtube) | 553 | 2026-08 | TS | MIT | MCP: one yt-dlp download tool | copy |
| [jkawamoto/mcp-youtube-transcript](https://github.com/jkawamoto/mcp-youtube-transcript) | 497 | 2026-11 | Py | MIT | MCP: `get_available_languages`, `get_timed_transcript`, `next_cursor` paging | port |
| [kevinwatt/yt-dlp-mcp](https://github.com/kevinwatt/yt-dlp-mcp) | 310 | 2026-10 | TS | MIT | MCP: search, subtitle languages, threaded comments, comment summaries, downloads | copy |
| [coyaSONG/youtube-mcp-server](https://github.com/coyaSONG/youtube-mcp-server) | 27 | 2026-11 | TS | MIT | MCP: `research-video(s)`: transcript search returning cited excerpts with timestamp links and context; resources and prompts | copy |
| [samson-art/transcriptor-mcp](https://github.com/samson-art/transcriptor-mcp) | 24 | 2026-11 | TS | MIT | MCP: 11 platforms via yt-dlp, `get_video_frame`, playlist transcripts, Whisper fallback, Redis cache, MCP Apps widgets | copy |
| [kirbah/mcp-youtube](https://github.com/kirbah/mcp-youtube) | 34 | 2026-11 | TS | MIT | MCP: token-trimmed output, comments, trending | copy |
| [steipete/summarize](https://github.com/steipete/summarize) | 6.8k, 20k/wk | 2026-11 | TS | MIT | Captions then transcription, slides from frames with OCR, ffmpeg in WebAssembly, podcasts, Chrome extension | copy |
| [danielmiessler/Fabric](https://github.com/danielmiessler/Fabric) | 44.6k | 2026-11 | Go | MIT | YouTube input; prompt patterns such as `data/patterns/extract_wisdom` | copy prompts |
| JimmyLv/BibiGPT-v1 | 6.3k | 2026-11 | TS | GPL-3.0 | Multi-platform summarizer, chat with a video | ideas only |
| [microsoft/markitdown](https://github.com/microsoft/markitdown) | 195k | 2026-11 | Py | MIT | YouTube page to Markdown | port |
| [yt-dlp/yt-dlp](https://github.com/yt-dlp/yt-dlp) | 208k | 2026-11 | Py | Unlicense | Reference extractors for every site | copy |
| [ggml-org/whisper.cpp](https://github.com/ggml-org/whisper.cpp) | 55k | 2026-11 | C++ | MIT | Local speech-to-text | dependency |
| [@huggingface/transformers](https://github.com/huggingface/transformers.js) | 16.4k, 4.8M/wk | 2026-10 | JS | Apache-2.0 | Whisper on ONNX/WebGPU in the browser or Node | dependency (keep NOTICE) |
| nodejs-whisper, smart-whisper | 212 and 77; 33k/wk and 10k/wk | 2026-10, 2024-10 | TS | MIT | whisper.cpp bindings for Node; smart-whisper keeps the model loaded | dependency |
| xenova/whisper-web | 3.3k | 2024-10 | TS | no LICENSE file | Browser Whisper demo | ideas only |
| cottongeeks/podscript | 169 | archived | TS | MIT | Podcast transcription | ideas only (archived) |

## Where each finding applies

| Finding | Work item |
|---|---|
| `youtubei.js` as the innertube transport, `bgutils-js` for PO tokens, `yt-dlp/ejs` for signatures | 06 (clients, resilience), 08 (browse), 09 (comments) |
| youtube-transcript-api's error taxonomy and proxy/cookie options | 06 |
| `@huggingface/transformers` Whisper, `smart-whisper` | 18, 19 |
| summarize's scene-change frames and OCR, transcriptor-mcp's `get_video_frame` | 31 |
| Fabric's `extract_wisdom` pattern | 32 (brief prompt text) |
| coyaSONG's `research-video(s)`, jkawamoto's `get_available_languages` and `next_cursor` | 54 (research tools), 44 (paging) |
| transcriptor-mcp's MCP Apps widgets | 52 |
| kimtaeyoon83's `strip_ads` | 53 (SponsorBlock and ad skipping) |

## Features popular MCP servers expose that the wave-1 plan lacked

YouTube search as a tool, caption language listing, YouTube-translated transcripts as a tool, a frame at a timestamp, key moments, playlist transcripts in one call, comment summaries, audio and video downloads, `next_cursor` paging and `max_tokens` limits, ad stripping, MCP Apps widgets, and a shared transcript cache. Wave 2 (prompts 51 to 62) covers the ones that fit vid2context; downloads stay out of scope (vid2context produces context, not media copies).

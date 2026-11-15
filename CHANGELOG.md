# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- Web app Captions page (`?view=captions`, in the sidebar and linked from every result): list every caption track of a video, preview one, save it as SRT, WebVTT, text or JSON, save all tracks as one .zip (tracks the platform refuses are listed, not fatal), or translate into a language the video has no track for. A playlist or channel saves every video's captions in one .zip. Captions only: no media is downloaded or transcribed.
- Web app: in-browser Whisper runs in a Web Worker, so transcribing a long file no longer freezes the page and Cancel really stops it. The worker reads the app's 16 kHz WAV without Web Audio, which workers lack.
- Stall protection in the rung chain: a hosted rung that does not answer within `VID2CONTEXT_RUNG_TIMEOUT_MS` (default 3 minutes) is abandoned, recorded as `timeout`, skipped for a minute, and the next rung gets its turn. Rate-limit cooldowns are capped at 10 minutes, so one huge `Retry-After` cannot disable a provider for a day.
- Web app: a run shows the server's progress and, after 30 seconds, offers other ways to get the result (the import panel, or downloading the video) without stopping the run; whichever finishes first is shown. Runs without the user's own keys go through a server job, so long transcriptions are not cut off by proxy response timeouts.

- Video links inside a playlist (`watch?v=...&list=...`, what YouTube's share button gives) now surface the playlist instead of dropping it. The video stays the default. The web app shows "This video is part of a playlist: <title> (N videos)" above the result and on the Download page, with a link that opens every video. The CLI takes `--playlist` on `list`, `pack`, `bundle` and `download` and prints a note otherwise; `GET /items` returns `list` and takes `playlist=1`; MCP `list_items` returns `list` and takes `playlist: true`. Providers report it through the optional `SourceProvider.matchList`, `Registry.resolve` returns it as `list`, and `expandInput` takes `{ list: true }`. Mixes are never offered.
- Failures are never dead ends. `suggestRecoveries` (core `recovery.ts`) turns any error into ranked ways to still get the result: download the audio and transcribe it, use a local file, get the captions from your browser, paste or upload a transcript, add a free key, wait and retry, switch to transcription, run locally. The HTTP API returns them as `recovery` in every error body, the CLI prints them with ready-to-run commands (also in `--json`), and MCP tool errors include them.
- Web app: a failed run opens a "Let's get this another way" panel with those options usable in place (including an inline form to add a key and retry), and the raw error, hint and attempts folded under "Technical details".
- Provider keys per request: `X-Vid2Context-Keys` lets a caller retry with its own key, used for that request only and never stored. Only registered provider credential names are accepted; `GET /health` lists them under `requestKeys`. `VID2CONTEXT_REQUEST_KEYS=0` turns it off. In the web app, sending saved keys to the server is opt-in (Settings, or the recovery form).
- Rung cooldowns are keyed by credential, so one caller's rejected or exhausted key never cools a rung down for others.

- `@vid2context/core`: data model, provider contracts, the free-first rung chain with cooldowns and key pools, the video-to-context pipeline (`auto`, `captions`, `stt` and `video` modes), `text` and `json` formatters, in-memory storage.
- `@vid2context/registry`: provider registries generated per runtime (node, workers, browser).
- `@vid2context/cli`: minimal command line with `text` and `json` output, transcript modes and language selection.
- `youtube` provider: URL matching, metadata, description chapters, creator and auto captions. No API key.
- `media-file` provider: local audio and video files as speech-to-text sources.
- `stt-openai-compatible` provider: local servers, Groq, OVH (keyless) and OpenAI speech-to-text.
- Runnable examples in `examples/` (library, CLI, HTTP API, MCP, LangChain.js, Python, LangChain and LlamaIndex) with a docs section in `docs/examples/`. Code blocks and the output of offline examples are synced by `npm run examples:docs` and checked by `npm test`; `LIVE=1` runs the live examples too.
- `llm-openai-compatible` provider: Ollama, LM Studio, local servers, Groq, Cerebras, Mistral, GitHub Models, Gemini, OVH and Pollinations (keyless), and OpenAI.

[Unreleased]: https://github.com/nirholas/vid2context/commits/main

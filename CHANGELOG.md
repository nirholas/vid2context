# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Fixed

- Long audio: chunks running at the same time could race on the learned length limit, so when keyed rungs failed on auth for two chunks at once the second rethrew and failed the whole job. Found in review and reproduced; both chunks now split.
- When a looped answer is transcribed again, the pieces are sized from the audio's measured length (MP3 frames or the WAV header, `audioDurationSec`) instead of the looped transcript's last timestamp, which could fall far short and cut many small pieces. Audio of unknown length falls back to cutting the loop back.
- An abort during the loop retry no longer starts another long-audio run, and a half that fails during a loop re-split is no longer logged twice.
- X: a GraphQL 404 is now reported as a rotated operation id (`X_GRAPHQL_QUERY_ID`), not as a missing post, and failures of the GraphQL lane no longer hide a not-found that both keyless lanes agree on. A `TweetUnavailable` answer (age-restricted or protected posts) is reported as unavailable instead of passing as an empty post. A guest token refused with 401, 403 or 429 is dropped and replaced once instead of staying cached for 2.5 hours.

## [0.2.0] - 2026-11-19

### Added

- Playlist view in the web app: rows show each video's title and length from the list page (new optional `VideoRef.title` and `durationSec` listing hints, read by the YouTube lister; also in `GET /items` and MCP `list_items`). Repeated entries are left out. A video waiting on a retry shows a live countdown and "Retry now", which cancels that job and starts it again. Stop and Retry now cancel the server job (`DELETE /jobs/:id`) instead of leaving it to retry for nobody.
- Job `progress` events carry `retryAt` while a failed attempt waits to be retried.

- X provider: a third lane for reading posts, x.com's GraphQL `TweetResultByRestId` with a guest token, the lane xactions runs for xactions.app/video. Tried after syndication and FxTwitter, only when `X_BEARER_TOKEN` (or `TWITTER_BEARER_TOKEN`) is set; `X_GRAPHQL_QUERY_ID` follows X when it rotates the operation id. Recorded fixtures and a gated live test.

### Fixed

- Speech-to-text decoder loops no longer cost the speech under them. A 9-minute interview on the keyless OVH lane came back with "issuance of" repeated 39 times over 45 seconds of real speech: the long-audio path never ran the repetition guard, and the guard alone would only have cut the junk back. Now every piece is checked; a looped piece is sent to the other rungs, then split in two at new cut points (once per piece), and only when every retry still loops is it cut back, with a `loop-kept` attempt saying the speech is missing. The single-request path re-transcribes a looped answer in two pieces the same way, and the stitched long-audio transcript gets the repetition guard too. See docs/long-audio.md, "Decoder loops".
- The keyless OVH rung declares its 60 s audio cap (`maxDurationSec`, now a field of `SttRung`), so long audio is split before the first upload instead of after refused ones, and audio of known length over every rung's cap goes straight to the long-audio path.
- Long-audio attempts no longer list every cooldown skip while a chunk waits out rate limits: the 429s stay, and one `rate-limit-wait` attempt gives the total wait.
- X links work on Cloudflare Workers (the public vid2context.com instance). Workers' fetch sends no user-agent, and without one X's syndication endpoint answers 400 and FxTwitter 401, so every X link failed there while Node, which always sends one, worked. The X provider now names its client on every lane.
- Long X videos can be transcribed on the keyless lane. X audio is m4a, which no built-in splitter cuts, and the ffmpeg splitter in `@vid2context/ffmpeg` was never passed to the pipeline, so anything over 60 s ended in "no splitter for audio/mp4". `Registry` now carries optional `splitters`, tried after the built-in MP3 and WAV ones, and the Node registry adds `ffmpeg-silence`, so the CLI, HTTP server and MCP server all get it.
- Long audio no longer stalls behind a rung with a bad key. A rejected key puts a rung on a 10-minute cooldown, and the chunk wait loop counted those cooldowns as rate limits, so a chunk waited its whole 10-minute budget and then failed. Cooldowns now remember their cause (`cooldownReason`), and only rate limits, 5xx errors and timeouts are waited for. A chunk planned for keyed rungs that all failed is split again for the length cap of the rungs that are left (OVH's 60 s).
- A rung skipped up front for a declared limit now counts as a too-large refusal, so audio still reaches the long-audio path when the only other rungs fail on auth (seen live: a bad Cloudflare key plus OVH skipped for length ended in "every rung failed").
- Web playlist view: the progress line no longer counts failures as done ("1 of 3 done, 1 failed"), and long status messages wrap instead of being cut off.
- The no-transcript hint follows what was tried: it suggests installing yt-dlp only when no source could download the audio, and otherwise says whether the download was blocked or speech-to-text failed.

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

[Unreleased]: https://github.com/nirholas/vid2context/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/nirholas/vid2context/releases/tag/v0.2.0

# vid2context build prompts

Fifty self-contained prompts (plus twelve in wave 2, below) that take vid2context from its foundation to an enterprise-grade product: the core pipeline and its quality bones first, then every source, speech-to-text and LLM option (free first), the research library, and the surfaces people use (CLI, MCP, HTTP API, web app, chat, landing site, extension). Each prompt is written for its own Claude Code chat, and all fifty can run at the same time in this one working folder.

## How to run the wave

1. Start from a green foundation: `npm install && npm run check`.
2. Open one chat per prompt in VS Code and paste one line, changing the file name:
   `Read docs/prompts/10-security.md and do everything it says.`
3. Each chat works only in the directories its prompt owns, commits its own paths, and does not push. Every chat ends with a report: what it built, what it verified live, what it could not verify, and what the integration pass needs.
4. When the wave settles: `npm install && npm run check`, read the reports, then run the integration pass (below).

You do not have to start all fifty at once. A good first batch is the bones and the main path: 01 to 05, 10, 15, 21, 23, 06, 11, 24, 25, 37, 43, 44, 46, 47.

## Index

Numbers match `docs/ROADMAP.md` and the owner columns in `docs/contracts/`. Every roadmap item that survived keeps its number; the nine new items take the numbers freed by merges (see "Changes from the roadmap").

| # | Prompt | Owns | Track |
|---|---|---|---|
| 01 | [Output formats: Markdown, SRT, WebVTT, context pack](archive/01-output-formats.md) | `packages/core/src/format/` | A. Core bones |
| 02 | [Caption and transcript cleanup](archive/02-caption-cleanup.md) | `packages/core/src/clean/` | A. Core bones |
| 03 | [Token estimates, chunking and sections](archive/03-chunking-sections.md) | `packages/core/src/chunk/` | A. Core bones |
| 04 | [Long audio: split, transcribe in parallel, stitch, resume](archive/04-long-audio.md) | `packages/core/src/longform/` | A. Core bones |
| 05 | [Config files, profiles and provider policy](archive/05-config-profiles.md) | `packages/config/` | A. Core bones |
| 06 | [YouTube: player clients, caption formats, IP-block resilience](archive/06-youtube-captions-resilience.md) | `providers/youtube/src/captions/`, `src/resilience/` | B. YouTube |
| 07 | [YouTube: metadata, chapters and video states](07-youtube-metadata-chapters.md) | `providers/youtube/src/metadata/` | B. YouTube |
| 08 | [YouTube: playlists, channels and search](08-youtube-playlists-channels-search.md) | `providers/youtube/src/browse/` | B. YouTube |
| 09 | [YouTube comments](09-youtube-comments.md) | `providers/youtube/src/comments/` | B. YouTube |
| 10 | [Security hardening and threat model](10-security.md) | `packages/core/src/security/` | A. Core bones |
| 11 | [yt-dlp universal source with a self-managed binary](11-ytdlp.md) | `providers/ytdlp/` | C. Other sources |
| 12 | [Local files, direct media URLs and ffmpeg tooling](12-media-files-ffmpeg.md) | `packages/ffmpeg/`, `providers/media-file/`, `providers/media-url/` | C. Other sources |
| 13 | [Podcasts: RSS, podcast:transcript, Apple and Spotify](13-podcasts.md) | `providers/podcast/` | C. Other sources |
| 14 | [Web pages with embedded video; Vimeo, Loom, Wistia transcripts](14-web-pages-native-transcripts.md) | `providers/web-page/`, `providers/native-transcripts/` | C. Other sources |
| 15 | [The .zip bundle and "copy for agents"](15-bundle-zip.md) | `packages/core/src/bundle/` | A. Core bones |
| 16 | [Agent integrations: one-command setup for every client](16-agent-integrations.md) | `integrations/` | H. Surfaces |
| 17 | [Speech-to-text: more OpenAI-compatible rungs](17-stt-openai-compatible.md) | `providers/stt-openai-compatible/` | D. Speech-to-text |
| 18 | [Local speech-to-text with whisper.cpp](18-whisper-cpp.md) | `providers/stt-whisper-cpp/` | D. Speech-to-text |
| 19 | [In-browser and offline AI](19-browser-offline-ai.md) | `providers/stt-transformers/`, `providers/llm-browser/` | D. Speech-to-text |
| 20 | [Cloudflare: Workers AI rungs and D1, R2, KV storage](20-cloudflare.md) | `providers/cloudflare-ai/`, `providers/storage-cloudflare/` | D. Speech-to-text |
| 21 | [Observability: tracing, metrics, usage and cost](21-telemetry.md) | `packages/core/src/telemetry/` | A. Core bones |
| 22 | [Hosted diarization and speaker naming](22-diarization.md) | `providers/stt-deepgram-assemblyai/`, `packages/speakers/` | D. Speech-to-text |
| 23 | [Provider conformance kit and fixture recorder](23-testkit.md) | `packages/testkit/` | A. Core bones |
| 24 | [LLM free catalog, OpenRouter free picker, check:llm](24-llm-free-catalog.md) | `providers/llm-free-catalog/`, `providers/llm-openrouter/`, `scripts/check-llm.ts` | E. LLM and embeddings |
| 25 | [LLM streaming, model catalog and model choice](25-llm-streaming-models.md) | `packages/core/src/llm/` | E. LLM and embeddings |
| 26 | [Native Anthropic and Gemini providers, with Vertex AI](26-llm-native.md) | `providers/llm-native/` | E. LLM and embeddings |
| 27 | [Local LLM servers with auto-detection](27-local-llm.md) | `providers/llm-local/` | E. LLM and embeddings |
| 28 | [Chat workspace with a model picker](28-chat.md) | `packages/chat/` | H. Surfaces |
| 29 | [Embedding rungs, free first](29-embeddings.md) | `providers/embed/`, `providers/embed-transformers/` | E. LLM and embeddings |
| 30 | [Gemini: video understanding and audio transcription](30-gemini-video.md) | `providers/video-gemini/` | F. Intelligence |
| 31 | [On-screen text and slides: frames, OCR, vision](31-visual-notes.md) | `providers/visual-frames/` | F. Intelligence |
| 32 | [Cited briefs and structured extraction](32-briefs-extraction.md) | `packages/insights/` | F. Intelligence |
| 33 | [Evaluation harness: accuracy, citations, latency, cost](33-evals.md) | `packages/evals/` | I. Deploy and quality |
| 34 | [Ask and chat: answers with timestamp citations](34-ask.md) | `packages/ask/` | F. Intelligence |
| 35 | [Translation and auto-chapters](35-translate-chapters.md) | `packages/translate/`, `packages/chapters/` | F. Intelligence |
| 36 | [Landing site](36-landing-site.md) | `site/` | H. Surfaces |
| 37 | [SQLite library with full-text search](37-storage-sqlite.md) | `providers/storage-sqlite/` | G. Library and search |
| 38 | [Local CI, Cloud Build and release engineering](38-ci-release.md) | `tooling/` | I. Deploy and quality |
| 39 | [Postgres and pgvector storage](39-storage-postgres.md) | `providers/storage-postgres/` | G. Library and search |
| 40 | [Hybrid search engine](40-search.md) | `packages/search/` | G. Library and search |
| 41 | [Collections and watch lists](41-library-watch.md) | `packages/library/` | G. Library and search |
| 42 | [Jobs, queues and live progress](42-jobs.md) | `packages/jobs/` | G. Library and search |
| 43 | [The full CLI](43-cli.md) | `packages/cli/` | H. Surfaces |
| 44 | [MCP server: tools, resources and prompts](44-mcp-tools.md) | `packages/mcp/` | H. Surfaces |
| 45 | [Remote MCP over HTTPS with OAuth](45-remote-mcp.md) | `packages/mcp-http/` | H. Surfaces |
| 46 | [The full HTTP API](46-http-api.md) | `packages/server/` | H. Surfaces |
| 47 | [Web app: paste a link or upload a video, get everything](47-web-app.md) | `packages/web/` | H. Surfaces |
| 48 | [Browser extension](48-extension.md) | `packages/extension/` | H. Surfaces |
| 49 | [Docker image and container deploys](49-containers.md) | `deploy/containers/` | I. Deploy and quality |
| 50 | [Serverless and static deploys](50-serverless-static.md) | `deploy/serverless/`, `wrangler.jsonc` | I. Deploy and quality |
| 51 | [Discovery: npm, MCP Registry, directories, SEO](../guides/discovery.md) (built; the guide replaces a prompt) | `packages/discovery/`, root `server.json`, `glama.json`, `gemini-extension.json`, `context7.json`, `llms-install.md`, `Dockerfile`, `.dockerignore` | J. Discovery |

## Wave 2: gaps found after wave 1 was written

A review of wave 1 against popular open-source projects (`docs/prior-art.md`) found features no wave-1 prompt covers. Wave 2 adds them under the same rules: each prompt owns new directories, depends only on the foundation, and exports `src/mcp.ts` and `src/http.ts` factories instead of editing `packages/mcp` or `packages/server`. Contracts: the "Wave 2" sections of `docs/contracts/mcp-tools.md` and `docs/contracts/http-api.md`.

| # | Prompt | Owns | Track |
|---|---|---|---|
| 51 | [MCP sampling, elicitation, completions and subscriptions](51-mcp-agentic.md) | `packages/mcp-agentic/` | J. Agent experience |
| 52 | [MCP Apps: interactive transcript viewer in ChatGPT and Claude](52-mcp-apps.md) | `packages/mcp-apps/` | J. Agent experience |
| 53 | [SponsorBlock: skip sponsor reads, intros and self-promotion](53-sponsorblock.md) | `packages/skips/` | K. Content quality |
| 54 | [Research tools: cited excerpts, caption languages, key moments](54-research-tools.md) | `packages/research/` | J. Agent experience |
| 55 | [Client libraries: Python, LangChain and LlamaIndex](55-client-libraries.md) | `clients/python/`, `packages/langchain/` | L. Reach |
| 56 | [Chat bots: Telegram, Discord and Slack](56-chat-bots.md) | `packages/bots/` | L. Reach |
| 57 | [Note exports: Obsidian vaults and Notion pages](57-note-exports.md) | `packages/exporters/` | L. Reach |
| 58 | [Hosted mode: accounts, quotas, shared cache, abuse protection](58-hosted-accounts.md) | `packages/accounts/` | M. Hosting |
| 59 | [Outbound webhooks and an n8n node](59-webhooks-n8n.md) | `packages/webhooks/`, `packages/n8n-nodes/` | L. Reach |
| 60 | [More sources: cloud share links and Bilibili](60-share-links-bilibili.md) | `providers/share-links/`, `providers/bilibili/` | N. Sources |
| 61 | [Live streams: transcribe while the stream runs](61-live-streams.md) | `packages/live/` | N. Sources |
| 62 | [Duplicate, reupload and clip detection](62-dedupe.md) | `packages/dedupe/` | K. Content quality |

Wave 2 was started on 2026-11-14 by the owner's coordinating session as background agents, one per prompt. Do not open chats for 51 to 62 unless that session reports one of them failed.

## What every prompt repeats

- Read `AGENTS.md`, `docs/ARCHITECTURE.md`, the core contracts and the relevant `docs/contracts/` page first.
- Own the listed directories only. Shared files take small additive edits from the prompts named in [SHARED-CONTRACTS.md](SHARED-CONTRACTS.md) section 8, and nobody else. Only 46 edits `packages/server`; only 44 edits `packages/mcp`; other packages export `src/http.ts` and `src/mcp.ts` factories for them to mount.
- Real data only: recorded fixtures or `LIVE=1` tests. No mocks, stubs, TODOs or placeholders.
- `npm install` and `git` run through `flock` on `.vid2context/locks/` so fifty agents cannot corrupt `node_modules` or the git index. Commits name explicit paths (`git commit -- <paths>`), so nobody commits another agent's staged files.
- When a key, tool or network is missing: use keyless or local rungs and recorded fixtures, and report what was not verified.

[SHARED-CONTRACTS.md](SHARED-CONTRACTS.md) holds what several prompts must agree on that `docs/contracts/` does not cover yet: four small shared core files (storage KV and vector extensions, LLM streaming, audio splitting, token estimates), the formatter ids and .zip layout, the `/models`, `/chat`, `/uploads` and `/bundle` routes, the web stack, URL layout and design tokens, and the shared fixtures.

## Changes from the roadmap

The owner asked for enterprise grade, with the bones first, plus a landing page, a paste-or-upload app and a chat page where users choose their LLM. Nine roadmap items were merged into neighbours to make room for nine new ones.

| Freed number | Roadmap item | Now done by | New item in that slot |
|---|---|---|---|
| 10 | YouTube resilience | 06 | Security hardening and threat model |
| 15 | Web page discovery | 14 | The .zip bundle and "copy for agents" |
| 21 | Gemini audio transcription | 30 | Observability: tracing, metrics, usage, cost |
| 23 | Local diarization (sherpa-onnx) | deferred; LLM speaker naming moved to 22 | Provider conformance kit and fixture recorder |
| 25 | OpenRouter picker and check:llm | 24 | LLM streaming, model catalog, model choice |
| 28 | In-browser LLMs | 19 | Chat workspace with a model picker |
| 33 | Schema extraction templates | 32 | Evaluation harness |
| 36 | Auto-chapters | 35 | Landing site |
| 38 | Cloudflare D1, R2, KV storage | 20 | Local CI, Cloud Build, release engineering |

So where `docs/contracts/` names item 33 (extract), read 32; item 36 (chapters), read 35; item 15 (pages), read 14; item 38 (Cloudflare storage), read 20.

Directory changes from the roadmap, and why:

- 05 is `packages/config/`, not `packages/core/src/config`: loading config files and `.env` needs Node, and the core must stay runtime-neutral.
- 09 is `providers/youtube/src/comments/`, not a separate package: the pipeline calls `getComments` on the YouTube source itself.
- 27 is `providers/llm-local/`: it holds the local rungs as well as detection.
- 36 builds on the existing `site/` and 50 on the existing root `wrangler.jsonc` (both landed during the foundation), instead of new directories.

## After the wave: the integration pass

Some wiring cannot happen while its pieces are built at the same time. Each chat lists what it left for this pass in its report. Expect:

- Surfaces: mount every `src/http.ts` sub-app in the server (46) and every `src/mcp.ts` registration in the MCP server (44) that landed after those prompts finished; add CLI commands for briefs, ask, translate, chapters, search and collections.
- Pipeline: use the ffmpeg splitter (12) for long audio in every surface, offer the cleanup option (02), visual notes (31) and config profiles (05) everywhere, and switch the chat route to the hybrid search engine (40).
- Web: merge the chat app into `/app/`, extract shared UI into `packages/ui`, and serve site, app and chat from one Cloudflare deploy.
- Quality: adopt the testkit suites (23) in every provider and storage package, turn on telemetry (21) in the server and CLI, enable the git hooks (38), and record the first eval baselines (33).

These can be written as a second, smaller set of prompts once wave 1 has landed.

## Open questions for the owner

- NVIDIA GPU or not: decides whether local whisper.cpp (18) leads the speech-to-text chain or hosted free rungs do.
- Domain: vid2context.com (with vidtocontext.com redirecting) on Cloudflare DNS, used by 36, 45 and 50.
- ChatGPT: the context pack and .zip (01, 15) work on day one; the live remote MCP connector (45) needs the server reachable over HTTPS.
- CI: there is no GitHub Actions workflow (billing is locked; the dead `ci.yml` was removed). 38 builds local CI and Cloud Build instead. Dependabot opens weekly npm PRs with no CI: verify them locally.

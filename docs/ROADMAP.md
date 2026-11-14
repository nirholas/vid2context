# Roadmap

## Foundation (done, 2026-11-14)

- Core: types, provider contracts with `rungs(env)`, the free-first rung chain, pipeline, `text` and `json` formats, `MemoryStorage`, key pools, test helpers (`@vid2context/core/testing`).
- Providers: YouTube (source + captions), local media files, OpenAI-compatible speech-to-text (local, Groq, OVH keyless, OpenAI), OpenAI-compatible LLMs (Ollama, LM Studio, local, Groq, Cerebras, Mistral, GitHub Models, Gemini, OVH and Pollinations keyless, OpenAI).
- Surfaces: minimal CLI, stdio MCP server (`get_transcript`, `get_metadata`), Hono HTTP API (`/health`, `/context`, `/transcript`).
- Verified live from a GCP VM: YouTube captions, a local mp3 through keyless OVH Whisper, the keyless LLM chain, and the MCP tool called from Claude Code.

## The 50 parallel work items

Each item owns one directory and depends only on the foundation. Contracts they build against: [contracts/providers.md](contracts/providers.md), [contracts/http-api.md](contracts/http-api.md), [contracts/mcp-tools.md](contracts/mcp-tools.md).

Shared surfaces have a single owner: only item 46 edits `packages/server` and only item 44 edits `packages/mcp`. Items whose packages back routes or tools export factories from their own package (`src/http.ts`, `src/mcp.ts`), and the surface owners mount them, so no two items edit the same file.

### A. Core output (`packages/core/src/<subdir>`)

| # | Item | Directory |
|---|---|---|
| 01 | Output formats: markdown with timestamp links and chapters, srt, vtt, the context pack | `packages/core/src/format` |
| 02 | Caption cleanup: punctuation and paragraphs for auto-captions, rolling-caption dedupe, Whisper repetition-loop guard | `packages/core/src/clean` |
| 03 | Chunking, token estimates, chapter-aware sections, time-range fetch | `packages/core/src/chunk` |
| 04 | Long-audio orchestrator: split on silence, parallel transcription across rungs, stitch, resume | `packages/core/src/longform` |
| 05 | Config files, profiles, provider policy (prefer, allowPaid, ordering overrides) | `packages/core/src/config` |

### B. YouTube (`providers/youtube` subfolders)

| # | Item | Directory |
|---|---|---|
| 06 | Captions hardening: multiple clients, json3/srv3/vtt, translated tracks, language choice, error taxonomy | `providers/youtube/src/captions` |
| 07 | Metadata and chapters: description and engagement panel; Shorts, live, premieres, age-gated, members-only | `providers/youtube/src/metadata` |
| 08 | Playlists, channels and search through innertube browse with continuations | `providers/youtube/src/browse` |
| 09 | Comments | `providers/youtube-comments` |
| 10 | Resilience: browser cookies, PO tokens, proxies, backoff, IP-block detection with actionable errors | `providers/youtube/src/resilience` |

### C. Other sources

| # | Item | Directory |
|---|---|---|
| 11 | yt-dlp universal source (catch-all) with self-managed binary and JS runtime | `providers/ytdlp` |
| 12 | Local files and direct media URLs: HLS, DASH, ffprobe, 16 kHz mono normalization | `providers/media-file` |
| 13 | Podcasts and RSS: `podcast:transcript`, Apple and Spotify shows through the iTunes Search API | `providers/podcast` |
| 14 | Native transcripts from Vimeo, Loom and Wistia | `providers/native-transcripts` |
| 15 | Web page video discovery: embedded videos in any article | `providers/web-page` |
| 16 | Agent integrations: one-command MCP install for Claude Code, Claude Desktop, ChatGPT, Cursor, VS Code Copilot, Codex, Windsurf; a Claude skill; custom GPT instructions | `integrations/` |

### D. Speech-to-text

| # | Item | Directory |
|---|---|---|
| 17 | More OpenAI-compatible rungs: Fireworks, DeepInfra, LocalAI, speaches, multi-key pools | `providers/stt-openai-compatible` |
| 18 | whisper.cpp with binary and model management and GPU detection | `providers/stt-whisper-cpp` |
| 19 | Transformers.js Whisper in Node and the browser (WebGPU), offline | `providers/stt-transformers` |
| 20 | Cloudflare Workers AI Whisper (binding and REST) | `providers/stt-cloudflare` |
| 21 | Gemini audio transcription (AI Studio free tier, Vertex) | `providers/stt-gemini` |
| 22 | Deepgram and AssemblyAI with diarization | `providers/stt-deepgram-assemblyai` |
| 23 | Local speaker diarization with sherpa-onnx, LLM speaker naming | `providers/diarize-sherpa` |

### E. LLM

| # | Item | Directory |
|---|---|---|
| 24 | Free LLM catalog: Kilo keyless, NVIDIA, SambaNova, Zhipu, SiliconCloud, Cloudflare, more Groq rungs, key pools | `providers/llm-free-catalog` |
| 25 | OpenRouter live `:free` picker and a `check:llm` audit CLI | `providers/llm-openrouter` |
| 26 | Native Anthropic, Gemini and Vertex providers | `providers/llm-native` |
| 27 | Local LLM auto-detection: Ollama, LM Studio, llama.cpp, vLLM, Jan | `providers/llm-local-detect` |
| 28 | In-browser LLMs: WebLLM, Chrome built-in AI | `providers/llm-browser` |
| 29 | Embeddings chain, free first: OVH bge-m3 keyless, Ollama, Transformers.js, Gemini, Cloudflare, paid | `providers/embed` |

### F. Intelligence

| # | Item | Directory |
|---|---|---|
| 30 | Gemini video understanding mode: direct YouTube URL input, visual notes | `providers/video-gemini` |
| 31 | On-screen text and slides: scene detection, tesseract.js, vision LLM | `providers/visual-frames` |
| 32 | Collection briefs with citations: map-reduce, consensus and disagreement | `packages/insights` |
| 33 | Schema extraction templates: buyer guide, tutorial steps, comparison, custom JSON Schema | `packages/extract` |
| 34 | Ask: RAG Q&A with timestamp citations | `packages/ask` |
| 35 | Translation: YouTube tlang first, LLM fallback | `packages/translate` |
| 36 | Auto-chapters for videos without chapters | `packages/chapters` |

### G. Library

| # | Item | Directory |
|---|---|---|
| 37 | SQLite library (`node:sqlite`, FTS5) | `providers/storage-sqlite` |
| 38 | Cloudflare D1, R2 and KV storage | `providers/storage-cloudflare` |
| 39 | Postgres with pgvector (Neon, Supabase, Cloud SQL, Railway, ApsaraDB) | `providers/storage-postgres` |
| 40 | Hybrid search: FTS, vectors, rerank | `packages/search` |
| 41 | Collections and watch lists with scheduled refresh | `packages/library` |
| 42 | Jobs and progress: in-process, Cloudflare Queues, Cloud Tasks, SSE | `packages/jobs` |

### H. Surfaces and deploy

| # | Item | Directory |
|---|---|---|
| 43 | Full CLI | `packages/cli` |
| 44 | MCP tools expansion: outline, sections, search, lists, collections, brief prompt, resources | `packages/mcp` |
| 45 | Remote MCP over Streamable HTTP with auth for ChatGPT and Claude.ai, Cloudflare Tunnel guide | `packages/mcp-http` |
| 46 | Full HTTP API: REST per the contract, SSE, rate limits, API keys, OpenAPI | `packages/server` |
| 47 | Web app | `packages/web` |
| 48 | Browser extension | `packages/extension` |
| 49 | Container deploys: Docker image (Node, yt-dlp, deno, ffmpeg, optional whisper.cpp), Railway, Cloud Run, Alibaba Cloud | `deploy/containers` |
| 50 | Serverless and static deploys: Cloudflare Workers and Pages, Vercel, GitHub Pages client-only | `deploy/serverless` |

## Open items for the owner

- Domain: vid2context.com, with vidtocontext.com redirecting (Namecheap, DNS on Cloudflare).
- GPU: whether the owner has an NVIDIA GPU decides if local whisper.cpp leads the speech-to-text chain or hosted free rungs do.
- ChatGPT: the context pack export (item 01) is the day-one path; the live remote MCP connection (item 45) comes after.
- CI: GitHub Actions billing on the account has been locked since 2026-09-15, so workflows there fail. Use `npm run check` locally, or Cloud Build.

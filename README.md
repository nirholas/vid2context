# vid2context

[![npm](https://img.shields.io/npm/v/vid2context-mcp?label=vid2context-mcp)](https://www.npmjs.com/package/vid2context-mcp) [![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE) [![Node 22+](https://img.shields.io/badge/node-%3E%3D22-339933?logo=nodedotjs&logoColor=white)](https://nodejs.org) [![Ask DeepWiki](https://deepwiki.com/badge.svg)](https://deepwiki.com/nirholas/vid2context)

**Turn any video into context for AI agents.** An MCP server, CLI and library that gives Claude, ChatGPT, Cursor, VS Code Copilot and any other agent the transcript, metadata and chapters of a YouTube video or media file, with timestamps it can cite.

Paste a video link or drop in a media file. vid2context returns the transcript, metadata and chapters in a form your agent can read and cite: plain text with `[m:ss]` timestamps, JSON, or (soon) a single Markdown context pack you can upload to ChatGPT Projects, Claude Projects or a custom GPT.

It is free first. Local models run first, then hosted free tiers with your own key, then keyless hosts that need no account. Paid APIs are used last, and only when you set their key. With zero configuration it already works.

```
$ vid2context https://www.youtube.com/watch?v=jNQXAC9IVRw --timestamps
[0:01] All right, so here we are, in front of the elephants
[0:05] the cool thing about these guys is that they have really...
[0:07] really really long trunks
[0:12] and that's cool
```

## Why

Research happens on video. A playlist explaining which used car to buy, a conference talk, a course, a podcast. Agents cannot watch any of it. vid2context turns those videos into text with timestamps, so an agent can absorb a whole series and answer "which model year should I buy?" while citing the episode and the moment that said so.

Design rule: raw transcripts are always kept. Summaries, briefs and extractions are an added layer, never a replacement.

## How it works

For every input, vid2context resolves the source, fetches metadata and chapters, then walks a fallback chain until it has a transcript:

1. Creator-uploaded captions
2. Platform auto-captions
3. Download the audio and run speech-to-text
4. Video model mode, where a multimodal model watches the video so on-screen text, slides and code are captured too (planned)

Each speech-to-text and LLM step runs through a **rung chain**. A rung is one provider, one model and one credential. Rungs are tried in tier order and the chain falls through on errors, rate limits and outages, with cooldowns so a failing rung is skipped for a while. Every attempt is recorded, so you can always see what was tried and why it succeeded or failed:

```
Attempts:
  resolve  ok      youtube  youtube:jNQXAC9IVRw
  metadata ok      youtube
  captions ok      youtube-captions  creator-captions
```

| Tier    | Meaning                        | Example                          |
| ------- | ------------------------------ | -------------------------------- |
| local   | Your machine, free and private | Ollama, LM Studio, speaches      |
| free    | Hosted free tier, your own key | Groq, Cerebras, Gemini AI Studio |
| keyless | Hosted, no account needed      | OVH AI Endpoints, Pollinations   |
| paid    | Last backstop, only with a key | OpenAI                           |

## Status

Early and pre-release (0.1.0). What works today:

| Area                                                                                                   | State                                               |
| ------------------------------------------------------------------------------------------------------ | --------------------------------------------------- |
| Core library: types, provider contracts, rung chain, pipeline                                          | Working, tested                                     |
| YouTube: URL matching, metadata, chapters from description, creator and auto captions (no key, no SDK) | Working, tested                                     |
| Local media files as speech-to-text input (Node)                                                       | Working, tested                                     |
| Speech-to-text: any OpenAI-compatible `/audio/transcriptions` API                                      | Working, tested                                     |
| LLM: any OpenAI-compatible chat API                                                                    | Working, tested                                     |
| CLI                                                                                                    | Working (minimal)                                   |
| MCP server over stdio                                                                                  | Working (minimal: `get_transcript`, `get_metadata`) |
| HTTP API (Hono)                                                                                        | Scaffolded, not implemented                         |
| Web app, browser extension, remote MCP, context pack, other platforms                                  | Planned, see [Roadmap](#roadmap)                    |

## Quick start (zero keys)

Requires Node.js 22 or newer.

```sh
npx vid2context "https://www.youtube.com/watch?v=jNQXAC9IVRw" --timestamps
```

From source:

```sh
git clone https://github.com/nirholas/vid2context.git
cd vid2context
npm install
npm run cli -- "https://www.youtube.com/watch?v=jNQXAC9IVRw" --timestamps
```

A local audio or video file works too. With no keys set, it is transcribed by the keyless OVH Whisper rung:

```sh
npm run cli -- ./interview.mp3 --format json > interview.json
```

## CLI

```
vid2context <url-or-file> [options]

  --format <id>     Output format: text | json (default: text)
  --timestamps      Prefix lines with timestamps where the format allows
  --mode <mode>     auto | captions | stt | video (default: auto)
  --lang <code>     Preferred transcript language, e.g. en, de, pt-BR
  --verbose         Log progress and the attempts list to stderr
```

Program output goes to stdout and everything else to stderr, so `vid2context URL > transcript.txt` stays clean. On failure the CLI prints the error code, a hint on how to fix it, and every attempt that was made.

## Use it from your agent

The MCP server is the npm package [`vid2context-mcp`](https://www.npmjs.com/package/vid2context-mcp), listed in the [MCP Registry](https://registry.modelcontextprotocol.io) as `io.github.nirholas/vid2context`. It needs no keys.

[![Install in VS Code](https://img.shields.io/badge/VS_Code-Install_vid2context-0098FF?logo=visualstudiocode&logoColor=white)](https://vscode.dev/redirect?url=vscode%3Amcp%2Finstall%3F%257B%2522name%2522%253A%2522vid2context%2522%252C%2522command%2522%253A%2522npx%2522%252C%2522args%2522%253A%255B%2522-y%2522%252C%2522vid2context-mcp%2522%255D%257D) [![Install in VS Code Insiders](https://img.shields.io/badge/VS_Code_Insiders-Install_vid2context-24bfa5?logo=visualstudiocode&logoColor=white)](https://vscode.dev/redirect?url=vscode-insiders%3Amcp%2Finstall%3F%257B%2522name%2522%253A%2522vid2context%2522%252C%2522command%2522%253A%2522npx%2522%252C%2522args%2522%253A%255B%2522-y%2522%252C%2522vid2context-mcp%2522%255D%257D) [![Install in Cursor](https://cursor.com/deeplink/mcp-install-dark.svg)](https://cursor.com/install-mcp?name=vid2context&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsInZpZDJjb250ZXh0LW1jcCJdfQ%3D%3D)

### Claude Code

```sh
claude mcp add --scope user --transport stdio vid2context -- npx -y vid2context-mcp
```

### Codex, Gemini CLI

```sh
codex mcp add vid2context -- npx -y vid2context-mcp
gemini extensions install https://github.com/nirholas/vid2context
```

### Claude Desktop, Cursor, Windsurf, Cline and other clients

```json
{
  "mcpServers": {
    "vid2context": { "command": "npx", "args": ["-y", "vid2context-mcp"] }
  }
}
```

To pass a key, add `"env": { "GROQ_API_KEY": "..." }` to the entry. Agents setting this up for you can follow [llms-install.md](llms-install.md).

### From source

From the repo root:

```sh
claude mcp add vid2context -- "$PWD/node_modules/.bin/tsx" "$PWD/packages/mcp/src/bin.ts"
```

### Tools

Ask your agent something like "get the transcript of https://youtu.be/jNQXAC9IVRw and summarize it with timestamps". The server exposes:

| Tool             | Input                                                                     | Returns                                                                                   |
| ---------------- | ------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `get_transcript` | `url`, optional `format`, `timestamps` (default true), `mode`, `language` | A header (title, channel, URL, duration, chapters, transcript origin) plus the transcript |
| `get_metadata`   | `url`                                                                     | Title, channel, description, duration, chapters, tags and language as JSON                |

Failures come back as tool errors carrying the error code, hint and attempts, so the agent can explain the problem or retry with another mode.

### ChatGPT

ChatGPT connects only to remote MCP servers over HTTPS. Two paths are planned:

- **Context pack export:** one Markdown file per video or collection, sized for upload to a ChatGPT Project or custom GPT. Zero setup.
- **Remote MCP:** Streamable HTTP with auth, plus a Cloudflare Tunnel guide so requests to YouTube still come from your own connection.

## Add free keys (optional)

Everything is optional. Each key you add unlocks more rungs, and the chain uses them before falling back to keyless hosts. Set them in your shell or a `.env` file.

**Speech-to-text**

| Env var                                  | Rung                                                                          | Tier    |
| ---------------------------------------- | ----------------------------------------------------------------------------- | ------- |
| `LOCAL_STT_BASE_URL` + `LOCAL_STT_MODEL` | Any local OpenAI-compatible server (speaches, faster-whisper-server, LocalAI) | local   |
| `GROQ_API_KEY`                           | Groq `whisper-large-v3-turbo`, 25 MB per file                                 | free    |
| (none)                                   | OVH AI Endpoints `whisper-large-v3-turbo`                                     | keyless |
| `OPENAI_API_KEY`                         | OpenAI `whisper-1`                                                            | paid    |

**LLM**

| Env var                                    | Rung                                                                                       | Tier    |
| ------------------------------------------ | ------------------------------------------------------------------------------------------ | ------- |
| `OLLAMA_MODEL` (and `OLLAMA_BASE_URL`)     | Ollama, default `http://localhost:11434/v1`                                                | local   |
| `LMSTUDIO_MODEL` (and `LMSTUDIO_BASE_URL`) | LM Studio, default `http://localhost:1234/v1`                                              | local   |
| `LOCAL_LLM_BASE_URL` + `LOCAL_LLM_MODEL`   | Any local OpenAI-compatible server                                                         | local   |
| `GROQ_API_KEY`                             | Groq: `qwen/qwen3.8-27b`, `openai/gpt-oss-120b`, `openai/gpt-oss-20b` (one rung per model) | free    |
| `CEREBRAS_API_KEY`                         | Cerebras: `gpt-oss-120b`, `llama-3.3-70b`                                                  | free    |
| `MISTRAL_API_KEY`                          | Mistral `mistral-small-latest`                                                             | free    |
| `GITHUB_TOKEN`                             | GitHub Models `meta/Llama-3.3-70B-Instruct`                                                | free    |
| `GEMINI_API_KEY`                           | Gemini AI Studio `gemini-2.5-flash-lite`                                                   | free    |
| (none)                                     | OVH AI Endpoints: Llama 3.3 70B, `gpt-oss-120b`                                            | keyless |
| (none)                                     | Pollinations `openai-fast`                                                                 | keyless |
| `OPENAI_API_KEY`                           | OpenAI `gpt-5.4-nano`                                                                      | paid    |

Every model id can be overridden with `<PROVIDER>_MODEL` (a comma-separated list, in order) for LLMs, or `<PROVIDER>_STT_MODEL` for speech-to-text. To pool several free keys for one provider, put the extras in `<PROVIDER>_FALLBACK_KEYS`, for example `GROQ_FALLBACK_KEYS=key2,key3`. Each key becomes its own rung.

### Chain controls

| Env var                      | Effect                                                                                                                                        |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `VID2CONTEXT_POLICY`         | `free` (default: local, free, keyless, paid), `local-only` (nothing leaves your machine) or `quality` (best model first, tier as tie-breaker) |
| `VID2CONTEXT_ALLOW_PAID=0`   | Never use paid rungs, even when a key is set                                                                                                  |
| `VID2CONTEXT_KEYLESS=0`      | Turn off keyless rungs, which send data to third parties without an account                                                                   |
| `VID2CONTEXT_SKIP=svc1,svc2` | Skip named services, e.g. `pollinations,ovh`                                                                                                  |
| `VID2CONTEXT_LOG_LEVEL`      | Log verbosity on stderr, e.g. `info`                                                                                                          |

## Architecture

TypeScript, ESM and npm workspaces, so the same code runs on Node, Cloudflare Workers, Vercel and in the browser.

```
packages/
  core/        Contracts, rung chain, pipeline, formatters. Runtime-neutral, no Node-only imports.
  registry/    Per-runtime provider registries (node, workers, browser), generated on install.
  cli/         The vid2context command.
  mcp/         The MCP server.
  server/      HTTP API on Hono (scaffold).
  discovery/   npm packages, MCP Registry and directory manifests (server.json, glama.json, ...).
providers/
  youtube/                 Source and captions through the innertube player API.
  media-file/              Local files and file:// URLs (Node only).
  stt-openai-compatible/   Speech-to-text rungs.
  llm-openai-compatible/   Chat completion rungs.
scripts/
  gen-registry.mjs         Scans providers/*/package.json and writes the generated registries.
```

Key decisions:

- **Providers are separate packages.** Each declares the runtimes it supports in its `package.json` (`"vid2context": {"runtimes": [...]}`) and default-exports a provider. `npm run gen` builds one registry per runtime, so Node-only providers never end up in a Workers or browser bundle.
- **Plain `fetch` over vendor SDKs.** Most speech-to-text and LLM APIs are OpenAI-compatible HTTP, which keeps providers edge-compatible and dependencies few.
- **Providers never read `process.env` or the global `fetch`.** Everything comes through the `ctx` object passed to each call, so the same provider works in every runtime and in tests.
- **Formats live in one map.** Every surface lists formats from `formatters` in `packages/core/src/format`, so a new formatter appears in the CLI, MCP and API at once.
- **stdout is for output only.** Logs go to stderr, which keeps CLI pipes and the MCP stdio protocol clean.

Start reading at [packages/core/src/types.ts](packages/core/src/types.ts), [packages/core/src/provider.ts](packages/core/src/provider.ts) and [packages/core/src/chain.ts](packages/core/src/chain.ts).

## Development

```sh
npm install          # also generates the provider registries
npm run typecheck    # tsc
npm run lint         # Biome
npm test             # vitest, against real recorded fixtures
npm run test:live    # LIVE=1: hits the real services
npm run check        # typecheck + lint + test
npm run cli -- <url> # run the CLI from source
npm run mcp          # run the MCP server on stdio
```

Tests use real responses recorded from the live services, never invented data. Live tests run only with `LIVE=1`.

### Adding a provider

1. Create `providers/<name>/` with a `package.json` that names the package `@vid2context/provider-<name>`, depends on `@vid2context/core`, and declares `"vid2context": {"runtimes": [...]}`.
2. Default-export a provider built with `defineProvider` from `src/index.ts`. Read config and make requests only through `ctx`.
3. Add tests under `providers/<name>/test/` with a recorded fixture, plus a live test gated by `LIVE=1`.
4. Run `npm install` (or `npm run gen`) to pick it up in the registry. Never hand-edit the generated files.

## Roadmap

- **Output:** Markdown with timestamp links and chapters, SRT, VTT and the context pack; caption cleanup; chunking and chapter-aware sections; long-audio splitting.
- **Sources:** any site yt-dlp supports (Vimeo, TikTok, X, Instagram, Reddit, Twitch VODs, Loom, Rumble), podcasts via RSS, direct media URLs including HLS and DASH, YouTube playlists, channels and comments. DRM services are out of scope.
- **Speech-to-text:** whisper.cpp, Transformers.js (Node and in-browser WebGPU), Cloudflare Workers AI, Gemini, Deepgram and AssemblyAI, speaker diarization.
- **LLM:** a wider free catalog, a live OpenRouter `:free` picker, native Anthropic and Gemini providers, local auto-detection, in-browser models, embeddings.
- **Intelligence:** Gemini video mode, on-screen text via OCR or a vision model, cited cross-video briefs that flag consensus and disagreement, extraction templates, Q&A over a collection, translation, auto-chapters.
- **Library:** collections fed from playlists, watch lists that ingest new uploads, hybrid keyword and vector search, on SQLite, Cloudflare D1 or Postgres with pgvector.
- **Surfaces:** a full CLI, more MCP tools, remote MCP for ChatGPT and Claude.ai, a full HTTP API with OpenAPI, a web app where you paste a link or upload a video, pick your LLM, and get everything as copyable text or a .zip, and a browser extension.
- **Deploy:** Docker, Railway, Cloud Run, Alibaba Cloud, Cloudflare Workers and Pages, Vercel, and a client-only GitHub Pages build.

## FAQ

**How do I give Claude, ChatGPT or Cursor a YouTube video?** Add the MCP server (above) and paste the link into your chat. The agent calls `get_transcript` and gets the transcript with `[m:ss]` timestamps. ChatGPT needs a remote MCP server, which is on the roadmap.

**Does it need an API key?** No. Creator captions and auto-captions need no key, and speech-to-text falls back to keyless hosts. Keys only add faster or local options.

**What if a video has no captions?** vid2context downloads the audio and runs speech-to-text, preferring a local Whisper server, then free tiers such as Groq, then keyless hosts.

**Can I keep AI processing on my machine?** Point it at a local speech-to-text server and a local LLM and set `VID2CONTEXT_POLICY=local-only`. No hosted AI service is used; fetching a YouTube video still needs the network, a local file does not.

**Is it a YouTube transcript API?** Yes, as a library and CLI today, and as an HTTP API with OpenAPI soon. It returns text, JSON and timestamps, keeps the raw transcript, and records every provider it tried.

## License

[Apache-2.0](LICENSE)

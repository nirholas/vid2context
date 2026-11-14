# Architecture

vid2context turns a video (a URL, a playlist, a podcast episode, a local file) into context an AI agent can read and cite: metadata, chapters and a timed transcript, plus optional on-screen notes, comments and cited briefs across many videos. One TypeScript core runs behind every surface: a CLI, an MCP server, an HTTP API and, later, a web app and a browser extension.

## Layout

```
packages/
  core/        types, provider contracts, rung chain, pipeline, formatters, storage contract (runtime-neutral)
  registry/    per-runtime provider registries, generated from providers/* (node, workers, browser)
  cli/         the vid2context command
  mcp/         the MCP server (stdio now, Streamable HTTP later)
  server/      the HTTP API on Hono
providers/
  youtube/                 source + captions (innertube, keyless)
  media-file/              local files (node only)
  stt-openai-compatible/   speech-to-text rungs
  llm-openai-compatible/   chat rungs
scripts/gen-registry.mjs   scans providers/*/package.json, writes packages/registry/src/generated/
tests/fixtures/            shared real fixtures (public-domain audio, real VideoContext JSON)
docs/contracts/            the contracts parallel work builds against
```

Every package exports its TypeScript source directly (`"exports": { ".": "./src/index.ts" }`) and imports with explicit `.ts` extensions. `tsx` runs it, `vitest` tests it, Biome lints it. Bundles for `npx` (CLI, MCP) come later with tsup.

## Data model

```
input string ──resolve──▶ VideoRef { platform, kind, id = "platform:nativeId", url }
                              │
                              ▼
VideoContext {
  metadata:   VideoMetadata  (title, channel, description, duration, chapters[], tags, language)
  transcript: Transcript     (language, origin, producer, model, segments[{startSec, endSec, text}])
  visual?:    VisualNote[]   (slide text, code, charts seen on screen)
  comments?:  Comment[]
  attempts:   Attempt[]      (every provider and rung tried, with outcome and reason)
}
```

`TranscriptOrigin` says how trustworthy the text is: `creator-captions`, `auto-captions`, `native-transcript`, `stt`, `video-model`.

Design rule: raw transcripts are always kept. Summaries, briefs, extractions and translations are layers stored next to them, never replacements.

## The pipeline

`getVideoContext(registry, input, opts, ctx)` in [packages/core/src/pipeline.ts](../packages/core/src/pipeline.ts):

```
resolve input ─▶ storage hit? ─▶ metadata ─▶ transcript ─▶ comments? ─▶ save
                                              │
            mode auto:     captions (creator, auto, translated) ─▶ audio + speech-to-text chain
            mode captions: captions only, never download audio
            mode stt:      always transcribe the audio
            mode video:    a multimodal video rung reads the whole video (transcript + visual notes)
```

- Source resolution: the registry asks each source's synchronous `match()`; platform-specific sources go before catch-alls (yt-dlp, web page discovery).
- Metadata failures that mean "this video cannot be had" (`not-found`, `unavailable`, `blocked`) stop the pipeline; any other metadata failure falls back to minimal metadata and keeps going.
- Audio can come from any source whose `canProvideAudio(ref)` is true, so yt-dlp can supply audio for YouTube refs.
- Speech-to-text rungs whose `maxBytes` is below the audio size are skipped before the chain runs (long audio is split by the longform orchestrator, item 04).
- Every step appends to `attempts`. Errors carry the attempts too, so every surface can show why something failed.

`expandInput` turns playlist, channel, feed and page refs into video refs. `transcribe` and `chat` expose the speech-to-text and LLM chains directly.

## The rung chain

[packages/core/src/chain.ts](../packages/core/src/chain.ts). A rung is one provider + one model + one credential (Groq and Cerebras meter quota per model, so each model is its own rung; each pooled key is its own rung too).

- A rung is present only when its credential is set; keyless and local rungs need none.
- Default policy `free` orders by tier: `local` (this machine, private), `free` (hosted free tier, your key), `keyless` (hosted, no account), `paid` (only when its key is set). Then by `priority`.
- `local-only` keeps only local rungs. `quality` orders by quality score, tier breaking ties.
- `runChain` tries rungs in order, falls through on any error except caller input errors, and records every attempt.
- Per-process cooldowns: rate-limited for `Retry-After` or 60 s, auth failures 10 min, a retired model 30 min, 5xx 30 s.
- Env controls: `VID2CONTEXT_POLICY`, `VID2CONTEXT_ALLOW_PAID=0`, `VID2CONTEXT_SKIP=svc1,svc2`, `VID2CONTEXT_KEYLESS=0`.

The same chain serves every rung kind: `stt`, `llm`, `embed`, `video`, `visual`. Providers build rungs from env (`rungs(env)`), so model overrides and key pools need no code change.

## Providers and the registry

Providers are separate workspace packages under `providers/<name>/`. Each declares `"vid2context": { "runtimes": [...] }` in its package.json and default-exports one provider or an array. `scripts/gen-registry.mjs` (run on install and before typecheck and test) writes one registry per runtime:

```
packages/registry/src/generated/node.ts      every provider with "node"
packages/registry/src/generated/workers.ts   ... "workers"
packages/registry/src/generated/browser.ts   ... "browser"
```

So node-only providers (child processes, filesystem) never reach a Workers or browser bundle, and adding a provider never means editing a shared file: fifty agents can each add one at once. The generated files are gitignored.

Providers never read `process.env` or call the global `fetch`. Everything comes through the `Ctx` passed to each call (`env`, `fetch`, `log`, `signal`, `runtime`), which is what lets one provider run on Node, Workers, the browser and in tests with recorded responses. See [contracts/providers.md](contracts/providers.md).

## Formats

[packages/core/src/format/index.ts](../packages/core/src/format/index.ts) holds a `formatters` map (`text`, `json` today). Every surface lists formats from that map and renders through `render()`, so a formatter added there appears in the CLI, MCP, HTTP API and web app at once.

## Storage

The `Storage` interface in [packages/core/src/storage.ts](../packages/core/src/storage.ts) covers saved contexts, collections and search. `MemoryStorage` is the zero-dependency default. Storage providers (SQLite, Cloudflare D1, Postgres) register like any provider; the enabled one with the lowest priority wins. The pipeline reads through storage as a cache and saves every result.

## Surfaces

| Surface | Package | Notes |
|---|---|---|
| CLI | `@vid2context/cli` | stdout is program output only; errors, hints and attempts go to stderr |
| MCP | `@vid2context/mcp` | stdio for Claude Code and other local agents; Streamable HTTP with auth for ChatGPT and Claude.ai |
| HTTP API | `@vid2context/server` | one Hono app for Node, Workers, Vercel, Cloud Run, Railway, Alibaba Cloud |
| Web app | `packages/web` (planned) | paste a link or upload a file, pick an LLM, copy or download results |
| Extension | `packages/extension` (planned) | send the current tab's video to vid2context |

All of them log to stderr. stdout belongs to program output and to the MCP stdio protocol.

### Who synthesizes

By default the calling agent does. The MCP server returns transcripts, sections and search hits, and offers a "brief" prompt, so there is no extra API key or cost. Server-side map-reduce on a cheap free model is optional, for collections too large for the agent's context (item 32).

Size guide: speech is about 12k tokens per hour, so a 15-episode series of 30-minute videos is about 90k tokens. That is why outlines, sections, chapters and search exist.

## Runtimes and deployment

| Target | How |
|---|---|
| Node (local, Docker, Cloud Run, Railway, Alibaba SAE / Function Compute) | `packages/server/src/node.ts`, a container with Node, yt-dlp, deno, ffmpeg |
| Cloudflare Workers + Pages, D1, R2, KV, Workers AI | a Workers entry using the workers registry (item 50) |
| Vercel | the same Hono app on Vercel's Node or edge runtime |
| GitHub Pages | client-only build: in-browser Whisper and LLMs on local files, plus a configurable API base URL |

YouTube blocks many datacenter IPs ("sign in to confirm you're not a bot"). Running locally, or behind a Cloudflare Tunnel to a home network, is the robust path; the YouTube provider reports a `blocked` error with that hint.

## Decisions and why

| Decision | Why |
|---|---|
| TypeScript, ESM, npm workspaces | Workers, Vercel edge and the browser all run JS; Python would split the codebase. Node 22 or newer. |
| Source-exporting packages, explicit `.ts` imports | No build step in development; `tsx` and `vitest` run the source. |
| Hono for HTTP | One app runs on every target. |
| Official MCP SDK | stdio and Streamable HTTP from one server definition. |
| Plain `fetch` over vendor SDKs | Most speech-to-text and LLM APIs are OpenAI-compatible HTTP; this keeps providers edge-compatible and dependencies few. |
| Providers as packages plus codegen | Parallel work never collides on a shared registry file, and runtime filtering is automatic. |
| Free first, keyless safety net | Works with zero configuration; every key added only adds rungs. |
| Real recorded fixtures, `LIVE=1` live tests | Tests reflect what services really return, without hitting them on every run. |

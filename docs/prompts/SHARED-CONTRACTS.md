# Shared contracts for the 50-prompt wave

Fifty agents build vid2context at the same time, in one working folder, each owning one directory. Most of them never need to agree on anything beyond the foundation (`packages/core`). This file pins the few things several prompts do need to agree on, so nobody waits for anybody.

Rules for this file:

- Where `docs/contracts/*.md` or the foundation code already defines something, they win. This file only adds to them.
- The code blocks in section 1 are exact. Copy them byte for byte. Do not "improve" them while copying.
- The surfaces in sections 2 to 7 are the plan the wave codes against. The prompt that owns a surface implements it and moves its final form into `docs/contracts/`. Consumers code against the shapes here.
- Changing anything here is a contract change: additive only, and update this file in the same commit.

## 1. Shared core files (create if missing)

Four small files in `packages/core/src/` are needed by several prompts that run in parallel. The first prompt that needs one creates it. Every later prompt finds it already there and uses it as is.

| File | Needed by prompts | Who may change it later |
|---|---|---|
| `storage-ext.ts` | 05, 22, 32, 34, 35, 36, 37, 38, 41, 42 | additive only; storage backends implement its interfaces |
| `llm-stream.ts` | 21, 25, 26, 28, 32, 42, 45 | additive only; prompt 28 owns streaming |
| `audio-split.ts` | 05, 16 | additive only |
| `tokens.ts` | 01, 02, 04, 31, 32, 33, 40, 42, 45 | prompt 04 may improve accuracy, never the signature |

Procedure, every time you need one of these files:

1. Check whether `packages/core/src/<file>` exists.
2. If it exists, use it. Do not edit it (except as the table allows).
3. If it does not exist, create it with exactly the content below. Writing a file that another agent just created will fail, which is the lock: re-read it and use it.
4. Re-read `packages/core/src/index.ts` and, if the line is not there yet, append `export * from './<file>';` (keep the `.ts` extension).
5. Run `npx tsc -p tsconfig.json --noEmit 2>&1 | grep 'packages/core/src/<file>'` and expect no output.
6. Commit the shared file on its own, right away, so other agents see it in git: `git add packages/core/src/<file> packages/core/src/index.ts` then `git commit -m "feat(core): add shared <name> contract from docs/prompts/SHARED-CONTRACTS.md" -m "<trailer>" -- packages/core/src/<file> packages/core/src/index.ts`. If `index.ts` has other agents' uncommitted lines in it, commit only the new file and leave `index.ts` for its owners (mention it in your report).

### 1.1 `packages/core/src/storage-ext.ts`

Optional KV and vector extensions for any Storage backend, with process-local fallbacks.

```ts
/**
 * Optional storage extensions shared by feature packages. A Storage backend
 * may also implement KvStore (small JSON state: watch lists, jobs, API keys,
 * OAuth clients, resume checkpoints) and VectorStore (embedding search).
 * Callers detect them with hasKv / hasVectors and otherwise fall back to the
 * process-local MemoryKv / MemoryVectors below, so every feature works with
 * every backend.
 *
 * Created verbatim from docs/prompts/SHARED-CONTRACTS.md. Change it only
 * additively, and update that file in the same commit.
 */
import type { Storage } from './storage.ts';

export interface KvStore {
  kvGet<T = unknown>(key: string): Promise<T | null>;
  /** Stores a JSON-serialisable value. `ttlSec` expires it; omit it to keep the value until deleted. */
  kvSet(key: string, value: unknown, opts?: { ttlSec?: number }): Promise<void>;
  kvDelete(key: string): Promise<void>;
  /** Live keys starting with `prefix`, in lexical order. Pass the returned cursor to get the next page. */
  kvList(prefix: string, opts?: { limit?: number; cursor?: string }): Promise<{ keys: string[]; cursor?: string }>;
}

export interface VectorRecord {
  /** Unique per chunk and model, e.g. `${videoId}#${startSec}`. */
  id: string;
  videoId: string;
  startSec: number;
  endSec: number;
  text: string;
  /** Embedding rung model id. Vectors from different models are never compared. */
  model: string;
  vector: number[];
}

export interface VectorQuery {
  vector: number[];
  model: string;
  limit?: number;
  /** Restrict to these videos (a collection's videoIds, for example). */
  videoIds?: string[];
}

export interface VectorHit {
  id: string;
  videoId: string;
  startSec: number;
  endSec: number;
  text: string;
  /** Cosine similarity, -1 to 1. */
  score: number;
}

export interface VectorStore {
  upsertVectors(records: VectorRecord[]): Promise<void>;
  deleteVectors(filter: { videoId: string; model?: string }): Promise<void>;
  queryVectors(query: VectorQuery): Promise<VectorHit[]>;
}

export function hasKv<S extends Storage>(storage: S | null | undefined): storage is S & KvStore {
  const s = storage as (S & Partial<KvStore>) | null | undefined;
  return typeof s?.kvGet === 'function' && typeof s.kvSet === 'function' && typeof s.kvList === 'function';
}

export function hasVectors<S extends Storage>(storage: S | null | undefined): storage is S & VectorStore {
  const s = storage as (S & Partial<VectorStore>) | null | undefined;
  return typeof s?.queryVectors === 'function' && typeof s.upsertVectors === 'function';
}

/** Process-local KvStore. State is lost on restart. */
export class MemoryKv implements KvStore {
  private data = new Map<string, { json: string; expiresAt?: number }>();

  async kvGet<T = unknown>(key: string): Promise<T | null> {
    const entry = this.data.get(key);
    if (!entry) return null;
    if (entry.expiresAt !== undefined && entry.expiresAt <= Date.now()) {
      this.data.delete(key);
      return null;
    }
    return JSON.parse(entry.json) as T;
  }

  async kvSet(key: string, value: unknown, opts: { ttlSec?: number } = {}): Promise<void> {
    const expiresAt = opts.ttlSec && opts.ttlSec > 0 ? Date.now() + opts.ttlSec * 1000 : undefined;
    this.data.set(key, { json: JSON.stringify(value), expiresAt });
  }

  async kvDelete(key: string): Promise<void> {
    this.data.delete(key);
  }

  async kvList(prefix: string, opts: { limit?: number; cursor?: string } = {}): Promise<{ keys: string[]; cursor?: string }> {
    const now = Date.now();
    const after = opts.cursor ?? '';
    const keys = [...this.data.entries()]
      .filter(([k, e]) => k.startsWith(prefix) && k > after && (e.expiresAt === undefined || e.expiresAt > now))
      .map(([k]) => k)
      .sort();
    const limit = opts.limit ?? 100;
    const page = keys.slice(0, limit);
    return keys.length > limit ? { keys: page, cursor: page.at(-1) } : { keys: page };
  }
}

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  return na === 0 || nb === 0 ? 0 : dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/** Process-local VectorStore with exact (brute-force) cosine search. Fine up to tens of thousands of chunks. */
export class MemoryVectors implements VectorStore {
  private records = new Map<string, VectorRecord>();

  async upsertVectors(records: VectorRecord[]): Promise<void> {
    for (const r of records) this.records.set(`${r.model}\u0000${r.id}`, r);
  }

  async deleteVectors(filter: { videoId: string; model?: string }): Promise<void> {
    for (const [key, r] of this.records) {
      if (r.videoId === filter.videoId && (filter.model === undefined || r.model === filter.model)) this.records.delete(key);
    }
  }

  async queryVectors(query: VectorQuery): Promise<VectorHit[]> {
    const allow = query.videoIds ? new Set(query.videoIds) : null;
    const hits: VectorHit[] = [];
    for (const r of this.records.values()) {
      if (r.model !== query.model) continue;
      if (allow && !allow.has(r.videoId)) continue;
      hits.push({
        id: r.id,
        videoId: r.videoId,
        startSec: r.startSec,
        endSec: r.endSec,
        text: r.text,
        score: cosine(query.vector, r.vector),
      });
    }
    return hits.sort((a, b) => b.score - a.score).slice(0, query.limit ?? 20);
  }
}
```

Usage pattern:

```ts
import { hasKv, MemoryKv, type KvStore } from '@vid2context/core';
const kv: KvStore = hasKv(storage) ? storage : new MemoryKv();
```

Key namespaces (prefix your keys so features never collide): `longform:`, `library:`, `jobs:`, `auth:apikey:`, `auth:oauth:`, `ratelimit:`, `cache:`, `config:`. Values are JSON. Keep each value under 1 MB (Cloudflare KV and D1 row limits).

### 1.2 `packages/core/src/llm-stream.ts`

Optional streaming for LLM rungs, with a fallback that makes every rung streamable.

```ts
/**
 * Optional streaming for LLM rungs. A rung that can stream implements
 * StreamingLlmRung. Callers use streamFromRung(), which streams natively when
 * the rung supports it and otherwise calls chat() and emits the whole text as
 * one delta, so every rung works behind a streaming UI.
 *
 * Created verbatim from docs/prompts/SHARED-CONTRACTS.md. Change it only
 * additively, and update that file in the same commit.
 */
import type { ChatRequest, ChatResult, LlmRung } from './provider.ts';
import type { Ctx } from './types.ts';

export type ChatStreamEvent =
  /** Visible answer text, in order. */
  | { type: 'delta'; text: string }
  /** Model reasoning text when the upstream exposes it. Never mixed into the answer. */
  | { type: 'reasoning'; text: string }
  /** Exactly one, last: the complete result (full text, model, usage). */
  | { type: 'done'; result: ChatResult };

export interface StreamingLlmRung extends LlmRung {
  stream(req: ChatRequest, ctx: Ctx): AsyncIterable<ChatStreamEvent>;
}

export function canStream(rung: LlmRung): rung is StreamingLlmRung {
  return typeof (rung as Partial<StreamingLlmRung>).stream === 'function';
}

/** Stream from any rung: native streaming when available, otherwise one delta from chat(). */
export async function* streamFromRung(rung: LlmRung, req: ChatRequest, ctx: Ctx): AsyncIterable<ChatStreamEvent> {
  if (canStream(rung)) {
    yield* rung.stream(req, ctx);
    return;
  }
  const result = await rung.chat(req, ctx);
  yield { type: 'delta', text: result.text };
  yield { type: 'done', result };
}
```

A provider adds streaming by returning a `StreamingLlmRung` (an `LlmRung` with a `stream` method) from `rungs(env)`. Type the rung as `StreamingLlmRung` where you build it, so the object literal type-checks, then return it in the `LlmRung[]`.

### 1.3 `packages/core/src/audio-split.ts`

```ts
/**
 * Audio splitting contract shared by the long-audio orchestrator
 * (core/src/longform) and media tooling (packages/ffmpeg). A splitter cuts
 * audio that is too large for any speech-to-text rung into chunks that fit,
 * preferably at silences, with a small overlap so words on a cut are not lost.
 *
 * Created verbatim from docs/prompts/SHARED-CONTRACTS.md. Change it only
 * additively, and update that file in the same commit.
 */
import type { AudioInput, Ctx } from './types.ts';

export type AudioBytes = Extract<AudioInput, { kind: 'bytes' }>;

export interface AudioChunk {
  /** 0-based position in the original audio. */
  index: number;
  /** Where this chunk starts in the original audio, in seconds (including its overlap). */
  startSec: number;
  durationSec: number;
  /** Seconds at the start of this chunk that repeat the end of the previous chunk. 0 for the first chunk. */
  overlapSec: number;
  audio: AudioBytes;
}

export interface SplitOptions {
  /** Every chunk's byte length must be at most this. */
  maxBytes: number;
  /** Preferred chunk length in seconds. Splitters that can detect silence cut near this point. */
  targetSec?: number;
  /** Overlap between consecutive chunks in seconds. Default chosen by the splitter (about 2s). */
  overlapSec?: number;
}

export interface AudioSplitter {
  /** Stable id for attempts and logs: 'mp3-frames', 'wav-pcm', 'ffmpeg-silence'. */
  id: string;
  /** Synchronous and cheap: true when this splitter handles this input's container in this runtime. */
  canSplit(audio: AudioInput): boolean;
  split(audio: AudioInput, opts: SplitOptions, ctx: Ctx): AsyncIterable<AudioChunk>;
}
```

### 1.4 `packages/core/src/tokens.ts`

```ts
/**
 * Token estimates for budgeting: context packs, chunking, fitting text into a
 * model's window. A fast heuristic, not a tokenizer: about 4 characters per
 * token for alphabetic scripts and about 1 token per CJK character. Use it
 * for budgets with headroom, never for billing.
 *
 * Created verbatim from docs/prompts/SHARED-CONTRACTS.md. Prompt 04 (chunking)
 * owns its accuracy and may improve the implementation, but must keep this
 * signature.
 */
const CJK = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af\uf900-\ufaff]/g;

export function estimateTokens(text: string): number {
  if (!text) return 0;
  const cjk = text.match(CJK)?.length ?? 0;
  return Math.ceil(cjk + (text.length - cjk) / 4);
}
```

## 2. Output formats and the .zip bundle

### Formatter ids

Prompt 01 adds formatters to the `formatters` map in `packages/core/src/format/`. Ids, so every surface and the bundle agree:

| id | extension | what |
|---|---|---|
| `text` | `txt` | foundation: plain text, optional `[m:ss]` lines |
| `json` | `json` | foundation: the full VideoContext |
| `markdown` | `md` | title block, chapters as headings, paragraphs prefixed with timestamp links |
| `srt` | `srt` | SubRip captions |
| `vtt` | `vtt` | WebVTT captions |
| `pack` | `md` | the context pack: one Markdown file for one or many videos, sized for a token budget, with citation instructions for the reading model |

Surfaces never hard-code this list. They read `formatters` at runtime, so a formatter added later shows up everywhere.

### Bundle layout (prompt 02)

One video:

```
<slug>/                     slug = lowercased title, a-z0-9 and hyphens, max 60 chars
  README.md                 what each file is, and how to use it with Claude Projects, ChatGPT Projects or a custom GPT, Claude Code and Cursor
  context.md                the `pack` formatter output (the one file to give an agent)
  transcript.md             `markdown`
  transcript.txt            `text`
  transcript.srt            `srt`
  transcript.vtt            `vtt`
  context.json              `json`
  metadata.json             VideoMetadata only
  chapters.md               when the video has chapters
  comments.md               when comments were fetched
  visual.md                 when visual notes exist
  manifest.json             see below
```

Several videos (a playlist, collection or batch):

```
<slug>/
  README.md
  context.md                combined pack for all videos, within the budget
  index.md                  table: n, title, channel, duration, origin, link, folder
  llms.txt                  llmstxt.org-style index of the bundle's files
  manifest.json
  videos/<nn>-<video-slug>/ the single-video layout above, without README.md
```

File names for formatters not in the table above: `<id>.<extension>`.

`manifest.json`:

```json
{
  "tool": "vid2context",
  "toolVersion": "0.1.0",
  "createdAt": "2026-11-14T16:00:00.000Z",
  "videos": [
    {
      "id": "youtube:jNQXAC9IVRw",
      "title": "Me at the zoo",
      "url": "https://www.youtube.com/watch?v=jNQXAC9IVRw",
      "origin": "creator-captions",
      "language": "en",
      "durationSec": 19,
      "estimatedTokens": 60,
      "folder": "."
    }
  ],
  "files": [{ "path": "context.md", "bytes": 1234, "sha256": "..." }]
}
```

## 3. HTTP API v1 additions (prompt 42 implements)

The foundation defines `GET /api/v1/health`, `GET /api/v1/context` and `GET /api/v1/transcript`, plus the error body and status mapping, in `docs/contracts/http-api.md`. These routes are added by the wave. All paths are under `/api/v1`. JSON unless stated. Errors use the foundation's error body.

| Method and path | Owner | Request | Response |
|---|---|---|---|
| `GET /formats` | 42 | | `{ formats: { id, description, mimeType, extension }[] }` |
| `GET /items?url=&limit=` | 42 | | `{ items: VideoRef[] }` (playlist, channel, feed or page expansion) |
| `GET /bundle?url=&formats=&comments=` | 42 | | `application/zip`, `Content-Disposition: attachment` |
| `POST /bundle` | 42 | `{ inputs: string[], formats?: string[], comments?: boolean }` | `application/zip` |
| `POST /uploads` | 42 | multipart, field `file` | `201 { input: "upload:<sha256>", filename, bytes, mimeType, expiresAt }` |
| `GET /models?kind=llm\|stt\|embed\|video\|visual` | 42 | | `{ models: ModelInfo[], defaultPolicy: Policy }` |
| `POST /chat` | 42 | ChatApiRequest | `text/event-stream`, events below |
| `GET /library?limit=&cursor=` | 42 | | `Page<VideoSummary>` |
| `GET /library/:id` | 42 | id URL-encoded (`youtube%3AjNQXAC9IVRw`) | `VideoContext` |
| `DELETE /library/:id` | 42 | | `204` |
| `GET /collections` | 42 | | `{ collections: Collection[] }` |
| `POST /collections` | 42 | `{ name, description?, sources? }` | `201 Collection` |
| `GET /collections/:id` | 42 | | `Collection` |
| `PATCH /collections/:id` | 42 | `{ name?, description?, sources? }` | `Collection` |
| `DELETE /collections/:id` | 42 | | `204` |
| `POST /collections/:id/items` | 42 | `{ inputs: string[] }` | `Collection` |
| `DELETE /collections/:id/items` | 42 | `{ videoIds: string[] }` | `Collection` |
| `GET /search?q=&collectionId=&limit=` | 42 | | `{ hits: (SearchHit & { url?: string })[] }` |
| `POST /jobs` | 38 | `{ kind, input, options? }` | `202 Job` |
| `GET /jobs/:id` | 38 | | `Job` |
| `GET /jobs/:id/events` | 38 | | `text/event-stream`: `progress`, `item`, `done`, `error` |
| `DELETE /jobs/:id` | 38 | | `202 Job` (cancel requested) |
| `GET /openapi.json` | 42 | | OpenAPI 3.1 for every route above |

`upload:<sha256>` is a server-side input: `GET /context?url=upload:<sha256>` and `POST /jobs` accept it for as long as the upload lives. Uploaded media is never written to the library unless the user saves the result.

### ModelInfo

```ts
interface ModelInfo {
  /** Rung id. Pass it back as ChatApiRequest.model.rung. */
  id: string;
  kind: 'llm' | 'stt' | 'embed' | 'video' | 'visual';
  /** Display name: the model id without vendor prefixes, e.g. "gpt-oss-120b". */
  label: string;
  /** Upstream service: 'groq', 'ovh', 'ollama', 'anthropic'. */
  service: string;
  provider: string;
  model: string;
  tier: 'local' | 'free' | 'keyless' | 'paid';
  quality: number;
  /** Rung capabilities plus 'streaming' when the rung streams natively. */
  capabilities: string[];
  contextTokens?: number;
  enabled: boolean;
  /** Env var NAMES the rung needs. Never values. */
  requires: string[];
}
```

### Chat over SSE

```ts
interface ChatApiRequest {
  messages: { role: 'user' | 'assistant'; content: string }[];
  /** Omit for Auto (the server's policy, free-first). */
  model?: { rung: string; strict?: boolean } | { policy: 'free' | 'quality' | 'local-only' };
  /** What to ground the answer in. Inputs are URLs, ids like youtube:abc, or upload:<sha256>. */
  context?: { inputs?: string[]; collectionId?: string };
  maxTokens?: number;
  temperature?: number;
}
```

`model.rung` with `strict: false` (the default) means "start with this rung, then fall back along the chain". `strict: true` means "this rung or an error".

Events, in order (`event:` name, `data:` one JSON object per line):

| event | data |
|---|---|
| `meta` | `{ rung, model, contextTokens?, sources: { n, videoId, title, url?, startSec, endSec }[] }` |
| `reasoning` | `{ text }` (zero or more, only when the model exposes reasoning) |
| `delta` | `{ text }` (one or more) |
| `done` | `{ text, rung, model, usage?, attempts }` |
| `error` | `{ code, message, hint?, attempts? }` (instead of `done`) |

The answer cites sources as `[n]` where `n` matches `meta.sources[].n`. Clients render `[n]` as a chip "Title @ m:ss" linking to the source `url` (a timestamp link).

### Job

```ts
interface Job {
  id: string;
  kind: string;          // 'context', 'items', 'bundle', 'collection-refresh', ...
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'canceled';
  input: unknown;
  progress?: { stage: string; done?: number; total?: number; message?: string };
  result?: unknown;
  error?: { code: string; message: string; hint?: string };
  createdAt: string;     // ISO 8601
  updatedAt: string;
}
```

## 4. MCP tools (prompts 40 and 41)

The foundation ships `get_transcript` and `get_metadata` (see `docs/contracts/mcp-tools.md`). The wave adds the tools below. Names are final; other prompts (integrations, docs, the site) refer to them.

| Tool | Input | Purpose |
|---|---|---|
| `list_formats` | `{}` | formats from the `formatters` map |
| `get_outline` | `{ url }` | metadata, chapters and estimated tokens per chapter, so an agent can fetch only what it needs |
| `get_section` | `{ url, from?, to?, chapter?, format? }` | a time range or chapter of a transcript |
| `list_items` | `{ url, limit? }` | expand a playlist, channel, feed or page |
| `search_transcripts` | `{ query, urls?, collection?, limit? }` | keyword search over saved transcripts, hits with timestamp links |
| `get_comments` | `{ url, limit?, sort? }` | top comments, creator replies flagged |
| `export_context_pack` | `{ urls?, collection?, maxTokens? }` | the `pack` format for one or many videos |
| `list_collections` | `{}` | |
| `create_collection` | `{ name, description?, sources? }` | |
| `add_to_collection` | `{ collection, urls }` | fetches and saves each video |
| `get_collection` | `{ collection }` | collection with video summaries |
| `list_models` | `{ kind? }` | ModelInfo list (no secrets) |

MCP prompts: `build_brief`, `buyer_guide`, `summarize_video`, `ask_collection`. Resource templates: `vid2context://video/{id}/transcript`, `vid2context://video/{id}/metadata`, `vid2context://collection/{id}`.

Remote MCP endpoint path: `/mcp` (Streamable HTTP). OAuth metadata: `/.well-known/oauth-protected-resource` and `/.well-known/oauth-authorization-server`.

## 5. CLI commands (prompt 39)

`vid2context <input>` (same as `get`), `get`, `list`, `formats`, `bundle`, `pack`, `search`, `library`, `collection`, `models`, `doctor`, `config`, `serve`, `mcp`. Global flags: `--format`, `--timestamps`, `--mode`, `--lang`, `--policy`, `--only`, `--skip`, `--allow-paid`, `--json`, `--quiet`, `--verbose`, `--out`. Other prompts that ship setup steps (whisper.cpp, local LLM detection, yt-dlp) export a function the CLI can call later and document a `npx tsx <their package>/src/<script>.ts` command for now.

## 6. Web: stack, URL layout, storage keys, design tokens

Stack for `packages/web`, `packages/chat` and `packages/extension`: React 19, Vite, TypeScript, Tailwind CSS v4, `lucide-react` icons, self-hosted fonts through `@fontsource` (no requests to Google Fonts). `packages/site` uses Astro with React islands and the same tokens. No Next.js: everything must build to static files that Cloudflare Pages, Vercel and GitHub Pages can all serve.

One domain, one layout:

| Path | Served by |
|---|---|
| `/` and `/docs/*` | `packages/site` (Astro, static) |
| `/app/` | `packages/web` (Vite `base: '/app/'`) |
| `/chat/` | `packages/chat` (Vite `base: '/chat/'`) until the integration pass merges it into `/app/` |
| `/api/v1/*` | `packages/server` |
| `/mcp`, `/.well-known/oauth-*` | `packages/mcp` remote transport, mounted by the server |
| `/llms.txt`, `/llms-full.txt` | `packages/site` |

Hand-off links between them:

- `/app/?url=<encoded input>&mode=&lang=` starts a run immediately (the site's hero input submits here).
- `/chat/?input=<encoded input>` opens a new chat with that video attached. `/chat/?collection=<id>` attaches a collection.

API base: `import.meta.env.VITE_API_BASE`, default `/api/v1`. A user override is stored in `localStorage` key `v2c.apiBase`. Theme: `localStorage` key `v2c.theme` (`dark` | `light` | `system`), applied as `data-theme` on `<html>`. Provider keys the user enters for client-only mode (env-style names such as `GROQ_API_KEY`): IndexedDB database `v2c-settings`, version 1, object store `kv`, key `providerKeys`, value `Record<string, string>`. Each app keeps its own data in its own database (`v2c-web`, `v2c-chat`) so schema versions never collide.

Design tokens: copy this into `src/styles/tokens.css` of every web package, unchanged. Dark is the default look.

```css
:root {
  --v2c-bg: #000000;
  --v2c-surface: #0b0b0d;
  --v2c-surface-2: #141417;
  --v2c-surface-3: #1c1c21;
  --v2c-border: #26262b;
  --v2c-border-strong: #3a3a42;
  --v2c-text: #fafafa;
  --v2c-muted: #a1a1aa;
  --v2c-subtle: #71717a;
  --v2c-accent: #3b82f6;
  --v2c-accent-2: #22d3ee;
  --v2c-accent-fg: #ffffff;
  --v2c-gradient: linear-gradient(135deg, var(--v2c-accent) 0%, var(--v2c-accent-2) 100%);
  --v2c-success: #22c55e;
  --v2c-warning: #f59e0b;
  --v2c-danger: #ef4444;
  --v2c-tier-local: #22c55e;
  --v2c-tier-free: #3b82f6;
  --v2c-tier-keyless: #a855f7;
  --v2c-tier-paid: #f59e0b;
  --v2c-radius-sm: 8px;
  --v2c-radius: 12px;
  --v2c-radius-lg: 20px;
  --v2c-radius-pill: 999px;
  --v2c-shadow: 0 1px 2px rgb(0 0 0 / 0.4), 0 8px 24px rgb(0 0 0 / 0.35);
  --v2c-font-sans: "Inter", ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  --v2c-font-mono: "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  color-scheme: dark;
}

:root[data-theme="light"] {
  --v2c-bg: #ffffff;
  --v2c-surface: #f7f7f8;
  --v2c-surface-2: #efeff1;
  --v2c-surface-3: #e6e6ea;
  --v2c-border: #e4e4e7;
  --v2c-border-strong: #d4d4d8;
  --v2c-text: #09090b;
  --v2c-muted: #52525b;
  --v2c-subtle: #71717a;
  --v2c-accent: #2563eb;
  --v2c-accent-2: #0891b2;
  --v2c-shadow: 0 1px 2px rgb(0 0 0 / 0.06), 0 8px 24px rgb(0 0 0 / 0.08);
  color-scheme: light;
}

@media (prefers-color-scheme: light) {
  :root[data-theme="system"] {
    --v2c-bg: #ffffff;
    --v2c-surface: #f7f7f8;
    --v2c-surface-2: #efeff1;
    --v2c-surface-3: #e6e6ea;
    --v2c-border: #e4e4e7;
    --v2c-border-strong: #d4d4d8;
    --v2c-text: #09090b;
    --v2c-muted: #52525b;
    --v2c-subtle: #71717a;
    --v2c-accent: #2563eb;
    --v2c-accent-2: #0891b2;
    --v2c-shadow: 0 1px 2px rgb(0 0 0 / 0.06), 0 8px 24px rgb(0 0 0 / 0.08);
    color-scheme: light;
  }
}
```

Visual language, from the owner's references (llm.energy, xactions.app/video, the LobeHub chat UI): black background, white type, thin borders, large rounded inputs, one accent gradient used sparingly on primary buttons and focus rings, monospace for transcripts and file viewers, generous spacing, no stock illustrations, no emojis in UI copy.

## 7. Shared test fixtures

- `tests/fixtures/contexts/youtube-jNQXAC9IVRw.json` and `tests/fixtures/contexts/youtube-cCPsdFdlshc.json`: real `VideoContext` objects produced by the foundation pipeline (short video with creator captions, and a longer video with auto-captions). Load them with `readFileSync(new URL('../../../tests/fixtures/contexts/<file>', import.meta.url))` from a package test. If they are not there when you start, produce one yourself with the foundation CLI against the real video (`npm run cli -- https://www.youtube.com/watch?v=jNQXAC9IVRw --format json > <your package>/test/fixtures/...`) and keep it in your own package.
- `providers/youtube/test/fixtures/`: real innertube player responses, srv1 and srv3 caption payloads, and a real 429 block page.
- `providers/stt-openai-compatible/test/fixtures/`: real OVH Whisper responses.
- Never edit another package's fixtures. Record your own into your package's `test/fixtures/`, and add a `test/fixtures/README.md` saying where and when each file was recorded and its license when it is media.

## 8. Shared files: who may edit what

Everything not listed belongs to exactly one prompt (see the index in `docs/prompts/README.md`). These shared files take small, additive edits from the prompts listed, and nobody else:

| Shared file | Prompts allowed to edit, and what |
|---|---|
| `packages/core/src/index.ts` | any prompt adding a core subdirectory or a section 1 file: one `export *` line |
| `packages/core/src/pipeline.ts` | 03 (repetition-loop guard on STT output), 05 (long-audio hook and `splitters` option), 07 (input policy check), 08 (stage spans), 23 (require `diarization` capability when asked), 38 (`onProgress` option) |
| `packages/core/src/chain.ts` | 07 (redact secrets in attempt details), 08 (rung spans and usage) |
| `packages/core/src/context.ts` | 07 (redacting logger), 08 (JSON log format, telemetry passthrough) |
| `packages/core/src/types.ts` | 08 (`Ctx.telemetry?`), 22 (`Ctx.bindings?`) |
| `packages/registry/src/workers.ts` | 22 (pass non-string bindings through as `ctx.bindings`) |
| `providers/youtube/src/index.ts` | 11, 12, 13, 14: only the properties each one owns |
| `providers/llm-openai-compatible/src/` | 24 owns it; 26 removes the local rungs it moves; 28 attaches `stream` to the rung factory |
| `packages/server/src/` (the Hono app file) | 42 owns it; 38 and 41 each add one line that mounts their routes |
| root `package.json` | 09, 10, 24, 50: add `scripts` entries only (and 10 its devDependencies) |
| `docs/providers.md`, `.env.example` | every provider prompt: add or update only the rows and variables for its own rungs |
| `docs/contracts/*.md` | the owner of the surface: 40 and 41 (`mcp-tools.md`), 42 (`http-api.md`), 08, 22 and 28 (`providers.md`) |

Nobody in the wave edits `CLAUDE.md`, `AGENTS.md`, the root `README.md`, `docs/ROADMAP.md`, `docs/prompts/` (except to fix this file additively), `.github/`, or another prompt's directory. The owner updates those after the wave.

## 9. Naming conventions

- Packages: `packages/<name>` is `@vid2context/<name>`. Providers: `providers/<dir>` is `@vid2context/provider-<dir>`.
- Provider ids are kebab-case and unique. Rung ids are `<kind>/<service>/<model>`, for example `llm/groq/openai/gpt-oss-120b`.
- Env vars: `<SERVICE>_API_KEY` (one key), `<SERVICE>_FALLBACK_KEYS` (extra keys, comma-separated, see `keyPool` in `packages/core/src/keys.ts`), `<SERVICE>_MODEL` or `<SERVICE>_<KIND>_MODEL` (model override), `<SERVICE>_BASE_URL` (endpoint override). App settings start with `VID2CONTEXT_`.
- Local data lives under `.vid2context/` in the working directory (gitignored), or under `VID2CONTEXT_HOME` when set: `bin/` (managed binaries), `models/` (downloaded models), `cache/` (media), `library.db` (SQLite), `locks/`.

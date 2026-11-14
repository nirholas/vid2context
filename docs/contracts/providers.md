# Provider contract

How to write a provider package. The types are the source of truth: [packages/core/src/provider.ts](../../packages/core/src/provider.ts) and [packages/core/src/types.ts](../../packages/core/src/types.ts). This page explains the rules around them. If this page and the types disagree, the types win; fix this page in the same commit.

## Package layout

```
providers/<name>/
  package.json        name "@vid2context/provider-<name>", "vid2context": { "runtimes": [...] }
  src/index.ts        default export: one Provider or Provider[]
  test/*.test.ts      unit tests on recorded fixtures, plus LIVE=1 tests
  test/fixtures/      real recorded responses, with a README saying where each came from
```

`package.json` essentials:

```json
{
  "name": "@vid2context/provider-<name>",
  "type": "module",
  "exports": { ".": "./src/index.ts" },
  "vid2context": { "runtimes": ["node", "workers", "browser"] },
  "dependencies": { "@vid2context/core": "*" }
}
```

- `runtimes` lists only what the code really supports. Anything that imports `node:*` modules, spawns processes or reads files is `["node"]`. `scripts/gen-registry.mjs` keeps such providers out of the Workers and browser registries.
- Run `npm install` (or `npm run gen`) after creating the package. Never edit `packages/registry/src/generated/`.
- Add dependencies only to your own `package.json`. Prefer plain `fetch` over vendor SDKs.

## Rules for every provider

1. **Use `ctx`, never globals.** Read config from `ctx.env`, make requests with `ctx.fetch` (or `fetchWithTimeout(ctx, url, init, ms)` from core), log with `ctx.log`, honour `ctx.signal`. Never touch `process.env` or the global `fetch` inside a provider. This is what makes one provider work on Node, Workers, the browser and in tests.
2. **stdout is not yours.** Log only through `ctx.log` (stderr). A stray `console.log` corrupts the MCP stdio protocol.
3. **Throw `Vid2ContextError`.** Every error a user can see has a stable `code` and, where you can say how to recover, a `hint`. Use `errorFromResponse(res, label)` for non-2xx responses: it maps 429 to `rate-limited` (with `Retry-After`), 401/402/403 to `auth`, 404/410 to `not-found`, 413 to `too-large`, other statuses to `upstream`.
4. **Input errors stop the chain.** Throw `bad-request` or `unsupported-input` only when the caller's input is wrong and no other rung could do better. Everything else falls through to the next rung.
5. **No placeholders.** No mock data, no TODO stubs, no fake responses. If something cannot be built yet, leave it out and say so in the docs.

## Source providers (`kind: 'source'`)

| Member | Contract |
|---|---|
| `match(input)` | Synchronous, cheap, no network. Return a `VideoRef` or `null`. Filesystem `stat` is acceptable for local paths. |
| `catchAll` | `true` for providers that accept almost any URL (yt-dlp, web page discovery). The registry tries specific sources first. |
| `getMetadata(ref, ctx)` | Return `VideoMetadata`; `chapters` is always an array (empty when none). Throw `not-found`, `unavailable` or `blocked` when the video itself cannot be had; the pipeline stops on those. Other errors make the pipeline fall back to minimal metadata. |
| `listItems(ref, ctx, {limit})` | Async iterable of video refs for playlist, channel, feed and page refs. Stream; do not buffer the whole list. |
| `canProvideAudio(ref, ctx)` / `getAudio(ref, ctx)` | Audio for speech-to-text. A provider can supply audio for refs from other platforms (yt-dlp does), so the pipeline asks every source whose `canProvideAudio` returns true. |
| `getComments(ref, ctx, {limit})` | Optional. |

`VideoRef` rules:

- `id` is `${platform}:${nativeId}` and is the storage and cache key. Lists use `${platform}:${kind}:${nativeId}`, for example `youtube:playlist:PL...`.
- `platform` is a short slug: `youtube`, `vimeo`, `file`, `podcast`, `web`.
- `url` is canonical when one exists. `timestampUrl` in core turns it into deep links.

## Captions providers (`kind: 'captions'`)

- `supports(ref)` is synchronous.
- `getCaptions(ref, opts, ctx)` returns the best `Transcript` for `opts`, or `null` when the video has no usable track. Throw only on real failures (network, blocking).
- Respect `opts.language`, `opts.allowAuto` (default true) and `opts.allowTranslated` (default true). A machine-translated result sets `translated: true` and keeps the source track's `origin`.
- `origin` is `creator-captions`, `auto-captions` or `native-transcript`.

## Rung providers (`stt`, `llm`, `embed`, `video`, `visual`)

A rung is one provider + one model + one credential. Providers build rungs from env on every call:

```ts
rungs(env: Env): SttRung[]   // and LlmRung[], EmbedRung[], VideoRung[], VisualRung[]
```

`rungs(env)` must be pure and fast (no network). Return every rung the provider knows, enabled or not, so `/api/v1/health` can show what a key would unlock.

### Rung fields

| Field | Rule |
|---|---|
| `id` | `<kind>/<service>/<model>`, e.g. `llm/groq/openai/gpt-oss-120b`, `stt/ovh/whisper-large-v3-turbo`. A rung with no model configured yet is `<kind>/<service>`. Cooldowns are keyed by id, so keep it stable. |
| `service` | Upstream name: `groq`, `ovh`, `ollama`. The nth pooled key is `groq#n` (n from 2). `VID2CONTEXT_SKIP` matches services. |
| `tier` | `local` (this machine), `free` (hosted free tier with your key), `keyless` (hosted, no key), `paid`. |
| `priority` | Lower runs first within a tier. Leave gaps of 10 between lanes. |
| `quality` | 1 (rough) to 5 (best). Used by the `quality` policy. |
| `capabilities` | See the vocabulary below. `rankRungs` filters on `needs`. |
| `requires` | Env var names that must be set. Empty for keyless and most local rungs. |
| `isEnabled(env)` | Optional synchronous override of the `requires` check. |

Capability vocabulary (add new words here when you need them):

| Kind | Capabilities |
|---|---|
| llm | `json` (json_object), `json-schema` (strict structured output), `tools`, `vision`, `stream` |
| stt | `segments`, `words`, `language-detect`, `prompt`, `diarization`, `translate` |
| video | `visual-notes`, `transcript` |
| visual | `ocr`, `describe` |

Kind-specific members: `SttRung.maxBytes` (largest upload; the pipeline skips rungs whose limit is below the audio size), `LlmRung.contextTokens` (usable window on that tier), `EmbedRung.dimensions`.

### Env var conventions

| Pattern | Meaning |
|---|---|
| `<PROVIDER>_API_KEY` | One key. Keep it a single value. |
| `<PROVIDER>_FALLBACK_KEYS` | Extra comma-separated keys. `keyPool(env, '<PROVIDER>_API_KEY')` returns all of them, de-duplicated; make one rung per key with `pooledService(service, index)`. |
| `<PROVIDER>_MODEL` | LLM model list for that provider, comma-separated, in order. Replaces the default list. |
| `<PROVIDER>_STT_MODEL`, `<PROVIDER>_EMBED_MODEL` | Same for speech-to-text and embeddings. |
| `<PROVIDER>_BASE_URL` | Base URL override where a provider can be self-hosted or proxied. |
| `VID2CONTEXT_*` | Reserved for vid2context itself (policy, skip, keyless switch, log level, env file). |

Every new env var goes into `.env.example` (commented, optional) and `docs/providers.md` in the same commit.

### Keyless lanes

Keyless rungs send data to a third party without an account. They are on by default (the zero-config path) and `VID2CONTEXT_KEYLESS=0` turns them all off. Never send an `Authorization` header to a keyless endpoint: OVH and Pollinations reject bogus ones.

### Model ids

Free model ids are retired without notice. Pin ids only where the provider keeps them stable, make every id overridable through env, and never pin an OpenRouter `:free` id (pick from the live list instead).

## Storage providers (`kind: 'storage'`)

`isEnabled(env)` decides from env alone; the enabled backend with the lowest `priority` wins. `create(ctx)` returns an object implementing `Storage` from [packages/core/src/storage.ts](../../packages/core/src/storage.ts). Unknown ids throw `Vid2ContextError('not-found')`. Raw transcripts are always stored; summaries and briefs are stored next to them, never instead of them.

## Testing

Unit tests replay real recorded responses; they never reach the network and never use invented payloads.

```ts
import { replayFetch, testContext } from '@vid2context/core/testing';

const fetch = replayFetch([
  { method: 'POST', url: 'https://api.example.com/v1/audio/transcriptions', response: { body: fixture('recorded.json') } },
  { url: /timedtext\?v=jNQXAC9IVRw/, response: { status: 429, headers: { 'retry-after': '31' }, body: fixture('429.html') } },
]);
const ctx = testContext({ fetch, env: { GROQ_API_KEY: 'gsk_test' } });
```

- `replayFetch` throws on any request without a recorded response and keeps every call in `.calls` (URL, method, headers, body) for assertions.
- `testContext` never reads `process.env`; pass the env the test needs.
- Live tests: `describe.skipIf(!process.env.LIVE)(...)` with `createContext({ runtime: 'node', env: process.env })`. Run them with `npm run test:live`.
- Record fixtures from the real service, then trim anything personal before committing: stream URLs that embed your IP, emails, phone numbers, keys. Grep the fixture for your public IP. Document each file in `test/fixtures/README.md` (source, date, what was trimmed).
- Shared real fixtures live in `tests/fixtures/` (a public-domain mp3 and real `VideoContext` JSON). Read them; do not edit them.
- When a credential is missing, test against recorded fixtures and the keyless or local lane, and say in your final report what could not be verified live.

## Reference implementations

| Package | Shows |
|---|---|
| [providers/youtube](../../providers/youtube) | source + captions, per-ctx response cache, playability errors, block detection |
| [providers/stt-openai-compatible](../../providers/stt-openai-compatible) | multipart upload, key pools, model overrides, keyless lane |
| [providers/llm-openai-compatible](../../providers/llm-openai-compatible) | lane table, per-model rungs, JSON modes, reasoning-model answers |
| [providers/media-file](../../providers/media-file) | node-only source, filesystem refs |

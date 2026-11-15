# Testing

How tests work in vid2context: unit tests replay real recorded responses, live tests are gated behind `LIVE=1`, and every provider, storage backend and formatter can adopt a shared conformance suite from `@vid2context/testkit`.

| Command | What it runs |
|---|---|
| `npm test` | every unit test, offline, on recorded fixtures |
| `npm run test:live` | the same plus the `LIVE=1` tests against real services |
| `npm run conformance` | registry invariants for every provider, plus the storage and formatter suites |
| `npm run record -- --out <dir> -- <input>` | records a real run into scrubbed fixture files and proves they replay |

## Unit tests on recorded fixtures

Providers never touch the global `fetch`; they call `ctx.fetch`. A test passes a `replayFetch` that answers only from recorded responses, so a unit test can never reach the network: any request without a recorded response throws.

```ts
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { replayFetch, testContext } from '@vid2context/core/testing';

const fixture = (name: string) => readFileSync(join(import.meta.dirname, 'fixtures', name), 'utf8');
const fetch = replayFetch([
  { method: 'POST', url: 'https://oai.endpoints.kepler.ai.cloud.ovh.net/v1/audio/transcriptions', response: { body: fixture('ovh-verbose.json') } },
  { url: /timedtext\?v=jNQXAC9IVRw/, response: { status: 429, headers: { 'retry-after': '31' }, body: fixture('429.html') } },
]);
const ctx = testContext({ fetch, env: { GROQ_API_KEY: 'gsk_test' } });
// fetch.calls holds every request (url, method, headers, body) for assertions.
```

Rules:

- Payloads come from the real service. Never write one by hand.
- `testContext` never reads `process.env`; pass the env the test needs.
- Each fixture gets a line in its folder's `README.md`: where, when and how it was recorded, and what was trimmed.
- Shared real fixtures live in `tests/fixtures/` (see its README). Read them; do not edit them.

## Recording fixtures

### From a whole pipeline run

```sh
npm run record -- --out providers/<name>/test/fixtures/run --name zoo -- https://www.youtube.com/watch?v=jNQXAC9IVRw
npm run record -- --out /tmp/rec -- <input> --mode stt --lang en
```

It runs `getVideoContext` with the node registry and a fetch that records every exchange to `<out>/<name>-001.json`, `-002.json`, and so on. Then it prints the files and what was scrubbed, writes the live result to `<name>.context.json`, and replays the files in a fresh process (so circuit breakers and caches start clean). It exits 0 only when the replay gives the same transcript. Pipeline options after `--`: `--mode auto|captions|stt|video`, `--lang xx`, `--no-auto`.

Requests a provider makes outside `ctx.fetch` cannot be recorded. For example, `yt-dlp` downloads audio in a subprocess, so a replay of an STT run still runs that subprocess.

### From a test or script

```ts
import { createContext } from '@vid2context/core';
import { recordingFetch } from '@vid2context/testkit';

const rec = recordingFetch(globalThis.fetch, { dir: 'test/fixtures/ovh', name: 'ovh', scrub: { env: process.env } });
const ctx = createContext({ runtime: 'node', env: {}, fetch: rec });
await rung.chat(request, ctx);
console.error(rec.files, rec.report());
```

Each file holds `{ recordedAt, request: { method, url, headers, body }, response: { status, headers, body, bodyEncoding } }`. Request headers are kept from an allowlist (content type, accept, user agent, the YouTube client headers). Response headers are kept from another allowlist (content type, `retry-after`, `location`, rate-limit headers). Request bodies over 32 KiB are cut; binary ones that large are left out, with their size kept. Response bodies are stored whole: text as text, binary as base64.

### What is scrubbed, always

- Headers: `Authorization`, `Proxy-Authorization`, `Cookie`, `Set-Cookie`, `x-api-key`, `api-key`, `x-goog-api-key` (kept, with the value `[redacted]`).
- Query parameters: `key`, `api_key`, `apikey`, `token`, `access_token`, `refresh_token`, `client_secret` (value becomes `REDACTED`).
- JSON fields named like secrets (`api_key`, `token`, `access_token`, `secret`, `password`, `authorization`, ...), in request and response bodies. A bare `key` field counts only when its value looks like a credential (20+ characters, no spaces), so `{key, value}` pairs survive.
- The literal value of every env var named `*_KEY`, `*_KEYS` (each comma-separated value), `*_TOKEN`, `*_SECRET`, `*_PASSWORD` or `*_ACCOUNT_ID`, wherever it appears.
- Known key shapes anywhere: `sk-`, `sk-ant-`, `gsk_`, `AIza`, `ghp_`, `github_pat_`, `hf_`.
- IP-bearing parameters in media stream URLs (`googlevideo.com`: `ip`, `ipbits`, `sig`, `lsig`, `signature`, `n`, `/ip/<addr>/`), and any query parameter whose value is an IP address: in the request URL always, and in URLs inside bodies (YouTube caption URLs, for one) when the address is routable (`0.0.0.0`, loopback and private ranges stay, so placeholders still match). These print a warning.

Still grep a new fixture for your public IP, emails and phone numbers before committing; the scrubber cannot know every personal detail.

## Replaying recorded files

```ts
import { replayFetch, testContext } from '@vid2context/core/testing';
import { fixtureRoutes } from '@vid2context/testkit';

const fetch = replayFetch(fixtureRoutes(join(import.meta.dirname, 'fixtures/ovh'), { name: 'ovh' }));
const res = await rung.chat(request, testContext({ fetch }));
```

Matching is exact URL plus method. A `REDACTED` segment in a recorded URL matches any value, so a request carrying a different key still finds its recording. A URL recorded several times answers with its responses in recorded order, then repeats the last.

## Live tests

```ts
import { createContext } from '@vid2context/core';
import { describe, expect, it } from 'vitest';

describe.skipIf(!process.env.LIVE)('keyless chat (live)', () => {
  it('answers through a real keyless lane', async () => {
    const ctx = createContext({ runtime: 'node', env: process.env });
    expect((await rung.chat(request, ctx)).text).toMatch(/1969/);
  });
});
```

Run with `npm run test:live` (or `LIVE=1 npx vitest run <path>`). When a credential is missing, test the keyless or local rung or the recorded fixtures instead, and say what could not be verified live.

## Conformance suites

Each suite declares vitest `describe`/`it` blocks, so adopting one is a few lines in your package's `test/conformance.test.ts`. All of them use real data only: the shared `tests/fixtures/contexts/*.json` and the recorded routes you pass. Every suite also checks that the code under test never uses the global `fetch` (it is swapped for one that throws during the calls).

### Source providers

```ts
import { describeSource } from '@vid2context/testkit';
import { youtubeSource } from '../src/index.ts';

describeSource(youtubeSource, {
  matches: [{ input: 'https://www.youtube.com/watch?v=jNQXAC9IVRw', id: 'youtube:jNQXAC9IVRw', kind: 'video' }, 'https://youtu.be/jNQXAC9IVRw'],
  rejects: ['https://vimeo.com/76979871', '/home/user/talk.mp3'],
  metadataCases: [{ input: 'https://www.youtube.com/watch?v=jNQXAC9IVRw', routes: recordedRoutes, title: 'Me at the zoo', chapters: 3 }],
  metadataErrors: [{ input: 'https://www.youtube.com/watch?v=6SJNVb0GnPI', routes: recordedRoutes, code: ['not-found', 'unavailable'] }],
});
```

`packages/testkit/test/youtube.test.ts` is a complete, working example with real recorded routes.

Checks: `match()` is synchronous, offline and returns well-formed refs (`id` is `platform:nativeId`, or `platform:kind:nativeId` for lists, with a valid `kind`) or null. `getMetadata()` on the recorded routes returns the same ref, a title, a `chapters` array with ascending starts, and ISO dates. Errors are `Vid2ContextError` with a hint.

### Captions providers

```ts
describeCaptions(youtubeCaptions, {
  source: youtubeSource,
  cases: [
    { input: 'https://www.youtube.com/watch?v=jNQXAC9IVRw', routes, expect: 'transcript', origin: 'creator-captions', language: 'en' },
    { input: 'https://www.youtube.com/watch?v=cCPsdFdlshc', routes, options: { allowAuto: false, allowTranslated: false }, expect: 'none' },
  ],
  unsupported: ['https://www.youtube.com/playlist?list=PLHeawKfarQSPKIjpe86at3Ttc2sz7uD_b'],
});
```

Checks: `supports()` is synchronous and true for the source's video refs. Transcripts have the ref, a BCP-47 language, a captions `origin`, a producer and an ISO `createdAt`. Segments are non-empty, ordered and do not overlap by more than `overlapToleranceSec` (default 0.5 s). A video with no usable track resolves to `null`.

### Speech-to-text, LLM and embedding rungs

```ts
describeSttRung(rung, {
  audio: { kind: 'bytes', data: apollo, mimeType: 'audio/mpeg', filename: 'apollo11-small-step.mp3' },
  routes: [{ method: 'POST', url: URL, response: { body: fixture('verbose.json') } }],
  expectText: 'one small step',
  errors: [{ name: '429', status: 429, routes: [{ url: URL, response: { status: 429, body: fixture('429.json') } }] }],
});
describeLlmRung(rung, { request: { messages, json: true }, routes, expectText: /1969/ });
describeEmbedRung(rung, { texts: ['one small step'], routes, env: { JINA_API_KEY: 'any value; the routes answer' } });
```

Checks: the id is `<kind>/<service>/<model>` and the service is a slug (`#n` for pooled keys). The tier is valid, keyless rungs require nothing, and free and paid rungs require at least one var. Quality is 1 to 5. `isEnabled` is synchronous, works on a frozen env and does no network. STT segments are timed and ordered with a BCP-47 language. Chat text is non-empty (valid JSON when `json` was asked). Embeddings have `dimensions` finite numbers each. Keyless rungs send no `Authorization` header. A recorded 4xx or 5xx rejects with a `Vid2ContextError` whose code follows `errorFromResponse` (429 `rate-limited`; 401, 402 and 403 `auth`; 404 and 410 `not-found`; 413 `too-large`; others `upstream`), unless the case names a `code`.

### Storage backends

```ts
import { describeStorage } from '@vid2context/testkit';
import { SqliteStorage } from '../src/index.ts';

describeStorage(() => new SqliteStorage({ path: ':memory:' }), { name: 'sqlite', cleanup: (s) => (s as SqliteStorage).close() });
```

Checks the whole `Storage` contract with the real context fixtures:
- contexts round-trip deep-equal, a second put overwrites, and list pages with cursors
- collections run through their lifecycle, adds and removes are idempotent, and unknown ids give `not-found` with a hint
- deleting a context removes it from every collection
- search finds "elephants" in "Me at the zoo" and scopes by collection and video

When the backend implements them (detected with `hasKv` and `hasVectors`), it also checks `KvStore` (TTL expiry, prefix listing in lexical order, cursor pages) and `VectorStore` (nearest first with cosine scores, overwrite on upsert, model isolation, delete by video and model). Backends without them skip those tests. The vector tests use 26-letter frequency vectors of real transcript lines, so the nearest vector to a line is its own.

### Formatters

```ts
for (const f of Object.values(formatters)) describeFormatter(f);
```

Checks: id, description, `mimeType` and `extension` are set. Every context fixture renders non-empty and identically twice under several option sets. `renderMany` combines all fixtures, when present.

## Registry invariants (`npm run conformance`)

`npm run conformance` regenerates the registries, then loads every provider package listed for the node, workers and browser runtimes, one package at a time, so a broken package is reported alone. It prints one report and fails one test per provider that has violations. Checks:

| Check | Rule |
|---|---|
| `package-loads` | the package imports and default-exports a Provider or Provider[] |
| `unique-provider-id`, `kebab-provider-id` | provider ids are unique per runtime and kebab-case |
| `provider-fields` | name set; the provider lists the runtime it is registered for |
| `rung-contract` | every rung passes the rung checks above, built from an empty env and from an env with every key set. A free or paid rung built from an empty env must be disabled. |
| `unique-rung-id` | no two rungs share an id in the same env |
| `rungs-deterministic`, `rungs-offline` | building rungs twice from one env gives the same ids, with no network |
| `portable-source:*` | providers registered for workers or browser have no `node:` imports, no `child_process`/`fs` imports, no `process.env`, and no global `fetch(` in any `src/` file that runtime loads (comments are ignored; call `ctx.fetch` by that name). The entry comes from `package.json` `exports` conditions (workers: `workerd`, `worker`, `edge-light`, `browser`, `import`, `default`; browser: `browser`, `import`, `default`), and files reachable from it through relative static or dynamic imports count. Node-only files the runtime never loads (a `node` entry, a CLI script) are listed under "Not checked" instead of failing. |
| `model-override` | for each rung built from an empty env, some `*_MODEL` variable documented in `docs/providers.md` or `.env.example` changes its model when set. The provider may normalise the value (an org prefix, for one). Documented `*_BASE_URL`, `*_URL` and `*_HOST` variables that share the prefix are set alongside, to an address never contacted, so rungs that need their server configured still appear. |
| `health-no-secrets` | `registry.health(env)` with key-shaped values for every secret variable never contains those values |
| `storage-is-enabled` | storage providers decide `isEnabled` synchronously from a frozen env |

Local rungs may have an empty `requires` and gate themselves with `isEnabled` on model variables instead (for example `OLLAMA_MODEL`). That is allowed; only keyless rungs must require nothing, and only free and paid rungs must require a key. A provider whose rungs no documented `*_MODEL` variable touches is listed under "Not checked" with that reason, and its rungs fail `model-override` until the variables are documented.

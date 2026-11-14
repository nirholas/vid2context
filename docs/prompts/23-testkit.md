# 23. Provider conformance kit and fixture recorder

| | |
|---|---|
| Track | A. Core bones |
| You own | `packages/testkit/` |
| Shared edits allowed | root `package.json` (`conformance` and `record` scripts only) |
| Commit scope | `testkit` |
| Runs alongside | 49 other prompts in the same folder; depends only on the foundation |

vid2context turns any video into context for AI agents: transcripts, metadata, chapters and cited briefs, free-first, as a CLI, MCP server, HTTP API and web app. In this wave, dozens of agents add providers and storage backends at the same time. Without a shared definition of "a correct provider", each one interprets the contracts slightly differently, and the house rule of real recorded fixtures depends on every agent hand-rolling its own recording code. This prompt builds the quality backbone: conformance suites every provider and storage backend can run, static invariants checked across the generated registries, and a recorder that captures real HTTP exchanges into fixtures with secrets scrubbed, ready for `replayFetch`.

## Read first

1. `CLAUDE.md` and `AGENTS.md`, then `docs/ARCHITECTURE.md`.
2. `packages/core/src/types.ts`, `packages/core/src/provider.ts` (every provider kind, `Rung`, `rungs(env)`), `packages/core/src/storage.ts` (`Storage`, `MemoryStorage`), `packages/core/src/testing.ts` (`replayFetch`, `testContext`, `RecordedResponse`, `Route`), `packages/core/src/registry.ts` and `packages/core/src/format/index.ts`.
3. `scripts/gen-registry.mjs` and `packages/registry/src/{node,workers,browser}.ts` (how the registries are generated per runtime).
4. `docs/contracts/providers.md` (rules for every provider, rung fields, env conventions, testing section), `tests/fixtures/README.md`, and one existing provider's tests (`providers/youtube/test/`, `providers/stt-openai-compatible/test/`).
5. `docs/prompts/SHARED-CONTRACTS.md`, sections 1.1 (`KvStore`, `VectorStore`), 7, 8 and 9.

## Goal

`@vid2context/testkit` gives every package one-line conformance suites, `npm run conformance` checks the invariants of every provider in every runtime registry, and `npm run record` (plus a `recordingFetch` helper) turns a real run into scrubbed fixture files that `fixtureRoutes()` replays.

## Requirements

### Conformance suites (vitest helpers)

Each suite is a function that declares `describe`/`it` blocks, so a provider adopts it with a few lines in its own `test/conformance.test.ts`:

- `describeSource(provider, { matches, rejects, metadataCases })`: `match()` accepts every input in `matches` and returns a well-formed `VideoRef` (`id === platform + ':' + nativeId`, `kind` valid), returns null for `rejects`, is synchronous and never touches the network (run it with a ctx whose fetch throws, and assert it does not return a Promise); `getMetadata` against recorded routes returns required fields (`title`, `chapters` array, ascending chapter starts).
- `describeCaptions(provider, cases)`: `supports` consistent with the source's refs, `getCaptions` returns segments that are ordered, non-overlapping beyond a small tolerance, non-empty text, a BCP-47 language, a valid `origin`; returns null (not throw) when a video has no tracks.
- `describeSttRung(rung, recorded)`, `describeLlmRung(rung, recorded)`, `describeEmbedRung(rung, recorded)`: id format `<kind>/<service>/<model>`, tier and `requires` consistency, `isEnabled` is env-only (works with a frozen env object and no fetch), call results have the right shape (segments timed and ordered; chat text non-empty; embeddings of `dimensions` length, finite numbers), errors from recorded 4xx/5xx responses are `Vid2ContextError` with sensible codes.
- `describeStorage(factory)`: the full `Storage` contract (contexts round-trip deep-equal, list pagination with cursors, collections lifecycle, add and remove idempotency, delete cascades out of collections, search finds a known phrase in a real fixture), plus the `KvStore` contract (TTL expiry, prefix listing, cursor pages) and the `VectorStore` contract (upsert overwrite, delete by video and model, query ranking, model isolation) when the backend implements them, detected with `hasKv` and `hasVectors` from `packages/core/src/storage-ext.ts`. If that file does not exist yet, create it exactly as SHARED-CONTRACTS section 1.1 shows and follow its procedure.
- `describeFormatter(formatter, contexts)`: renders every real fixture without throwing, output non-empty, deterministic across two runs, `mimeType` and `extension` set.
- All suites use real fixtures only: `tests/fixtures/contexts/*.json` and whatever recorded routes the caller passes.

### Static invariants (`npm run conformance`)

A vitest project or script in `packages/testkit` that loads the generated node, workers and browser registries and checks:

- Unique provider ids, kebab-case; unique rung ids across the whole registry for any given env; ids match `<kind>/<service>/<model>`.
- `requires` is empty exactly for `local` and `keyless` rungs (local rungs may be gated by `isEnabled` on model vars instead; allow that and document it); `free` and `paid` rungs require at least one env var.
- Building rungs twice from the same env returns identical ids (no hidden state).
- Every provider declared for `workers` or `browser` has no `node:` imports, no `child_process`, `fs` or `process.env` anywhere in its source tree, and no global `fetch(` calls (scan the files; allow `ctx.fetch`).
- Every rung's model can be overridden from env: for each provider, setting its documented `<PROVIDER>_MODEL`, `_STT_MODEL` or `_EMBED_MODEL` changes the rung model (read the variable names from `docs/providers.md` where possible, and report providers you cannot check).
- Health output (`registry.health(env)` with fake-looking but syntactically real key values) never contains the key values.
- Run the storage suite against `MemoryStorage` and the formatter suite against every formatter in the map.

Violations are reported with the provider id and file. Do not fix other packages: list violations in your report.

### Recorder

- `recordingFetch(realFetch, { dir, name, scrub? })`: a fetch wrapper that performs the real request and writes `{ request: { method, url, headers (allowlisted), body (text or base64, size-capped) }, response: { status, headers (allowlisted), body } }` files in order (`<name>-001.json`, ...).
- Scrubbing, always on: `Authorization`, `Cookie`, `Set-Cookie`, `x-api-key`, `api-key`, `x-goog-api-key` headers; `key`, `api_key`, `token`, `access_token` query params; JSON body fields named like keys or tokens; the literal values of any env var named `*_KEY`, `*_TOKEN`, `*_SECRET`, `*_PASSWORD`; known key shapes (`sk-`, `gsk_`, `AIza`, `sk-ant-`, `ghp_`, `github_pat_`, `hf_`). Also strip IP-bearing query params in media stream URLs (YouTube `ip=`, `ipbits=`, signatures) and warn about them. Prompt 10 builds a fuller redactor in core; implement this locally, not by importing an unfinished module.
- `fixtureRoutes(dir, { name? })`: loads recorded files and returns `Route[]` for `replayFetch` (exact URL plus method matching, in recorded order for repeated URLs).
- CLI `packages/testkit/src/record.ts`: `npx tsx packages/testkit/src/record.ts --out <dir> [--name <n>] -- <vid2context input> [pipeline options]` runs `getVideoContext` with the node registry and a context whose fetch is a `recordingFetch`, then prints what it recorded and the scrub report. Root script: `"record": "tsx packages/testkit/src/record.ts"`.
- Root script `"conformance": "npm run gen && vitest run packages/testkit"` (or the equivalent you choose).

## Out of scope

- Fixing violations in other packages: report them; the integration pass adopts the suites.
- The repo-wide hygiene checks (dashes, TODOs, secrets in tracked files) and CI pipeline: prompt 38.
- The core redaction module used at runtime: prompt 10.

## Tests

- Self-tests in `packages/testkit/test/`: run every suite against foundation code (the YouTube source and captions with their recorded fixtures, the OpenAI-compatible speech-to-text and LLM rungs with theirs, `MemoryStorage`, the `text` and `json` formatters) and make sure they pass, or that real violations are reported clearly.
- Recorder: record a real keyless call (OVH `GET /v1/models` and one chat completion) with `LIVE=1`, then replay the recorded files through `fixtureRoutes` and assert identical parsed results. Scrubbing test: record a real request made with a fake bearer token header against a public echo endpoint you run locally in the test (a `node:http` server), and assert the token never reaches disk.

## Acceptance criteria

- [ ] `npx tsc -p tsconfig.json --noEmit 2>&1 | grep -E 'packages/testkit'` prints nothing.
- [ ] `npx vitest run packages/testkit` passes, and `npm run conformance` runs and prints a clear pass or violation list for every provider present.
- [ ] `npx biome check packages/testkit` is clean.
- [ ] `npm run record -- --out /tmp/rec -- https://www.youtube.com/watch?v=jNQXAC9IVRw` writes scrubbed fixtures that replay to the same `VideoContext` transcript.

## Docs

- `docs/testing.md`: how to write unit tests on recorded fixtures, how to record, how to replay, how to write `LIVE=1` tests, how to adopt each conformance suite (copyable examples), and what the invariants check.
- `packages/testkit/README.md`: API summary.

## If credentials, tools or network are missing

Nothing here needs a key. Without network, record nothing new: run the suites on existing recorded fixtures and report that the recorder LIVE test was skipped.

<!-- COMMON -->

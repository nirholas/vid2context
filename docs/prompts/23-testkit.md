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

## Repo rules (binding, same as AGENTS.md)

- Never use the em-dash or en-dash characters: not in code, comments, docs, UI copy or commit messages. Use commas, colons, periods or parentheses. No emojis.
- No mocks, fake data, placeholders, TODOs, stub functions or "coming soon" text. If a piece cannot be built for real now, leave it out and say so in your final report.
- Tests use real data only: fixtures recorded from the real service, replayed through `replayFetch` and `testContext` from `@vid2context/core/testing`, or live calls gated by `LIVE=1` (`describe.skipIf(!process.env.LIVE)`). A unit test must never reach the network. Every fixture gets a line in its folder's `README.md` saying where and when it was recorded.
- Core code and providers never read `process.env` or the global `fetch`: use the `ctx` passed to every call. Log through `ctx.log` (stderr). stdout is program output and the MCP stdio channel.
- Prefer plain `fetch` over vendor SDKs. `packages/core` and every provider that declares the `workers` or `browser` runtime must not import Node built-ins.
- Every error a user can see is a `Vid2ContextError` with a stable `code` and a `hint` that says how to recover.
- Free first: local, then free tiers with the user's own key, then keyless hosts, and paid services last, only when their key is set. Every model id is overridable by env. New env vars go into `.env.example` and `docs/providers.md` in the same commit.
- Keep raw transcripts. Cleaned text, summaries, translations and briefs are added layers, never replacements.
- TypeScript, ESM, explicit `.ts` import extensions, Biome formatting (`npx biome check --write <your paths>`).

## Working in a shared folder

You are one of 50 agents working at the same time in this folder, each owning different directories.

- Create and edit files only inside the directories this prompt says you own, plus the shared edits listed in its header. Keep shared edits small and additive, and re-read a shared file immediately before every edit: another agent may have changed it a minute ago. `docs/prompts/SHARED-CONTRACTS.md` section 8 lists who may edit which shared file.
- If the foundation code differs from what this prompt describes, the code wins: read it and adapt. If something you need from another prompt has not landed yet, build everything else first and check again before you finish. If it is still missing, leave that piece out and list it in your report. Never stub it.
- Dependencies go only into your own package's `package.json`. Install through the shared lock so parallel installs cannot corrupt `node_modules`: `mkdir -p .vid2context/locks && flock .vid2context/locks/npm npm install -w <your package dir> <name>@<version>`. Never hand-edit `package-lock.json`; if it conflicts, rerun the install through the lock. Never edit `packages/registry/src/generated/`; run `npm run gen` instead.
- Other agents' unfinished work can break the repo-wide `npm run typecheck` and `npm test`. Judge your own paths: `npx tsc -p tsconfig.json --noEmit 2>&1 | grep -E '<your dirs>'` prints nothing, `npx vitest run <your dirs>` passes, `npx biome check <your dirs>` is clean. Do not fix other agents' files; mention breakage you saw in your report.
- Never run commands that touch other agents' work: `git add -A`, `git add .`, `git commit -a`, `git stash`, `git reset`, `git checkout -- <path>`, `git restore`, `git clean`, `git rebase`, `git push`.
- Servers you start for testing: pick a random port between 20000 and 29999, and stop them when you are done.

## Committing

The owner asks you to commit your own work as described here. Commit each coherent piece as soon as it works, not only at the end.

1. `git status --short` and check that every path you will commit is yours.
2. `flock .vid2context/locks/git git add <explicit paths>` (needed for new files).
3. Commit only your paths, which leaves anything other agents staged untouched:
   `flock .vid2context/locks/git git commit -m "<type>(<scope>): <what changed and why it matters>" -m "<body: what and why, in plain language>" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" -- <explicit paths>`
   (use the Co-Authored-By trailer your harness specifies if it names a different model).
4. `git show --stat HEAD` and confirm only your files are in the commit.

Types: feat, fix, refactor, perf, test, docs, chore. Never use subjects like "update" or "wip". Do not push. Never amend or rewrite a commit you did not make.

## Final report

Finish with a short report to the owner: what you built (paths), what you verified live and how, what you could not verify and why (missing key, tool or network), every shared-file edit you made, what the integration pass needs to wire up, and any breakage you noticed outside your directories.

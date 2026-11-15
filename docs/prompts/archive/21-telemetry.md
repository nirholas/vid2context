# 21. Observability: tracing, metrics, usage and cost

| | |
|---|---|
| Track | A. Core bones |
| You own | `packages/core/src/telemetry/` |
| Shared edits allowed | `packages/core/src/types.ts` (optional `Ctx.telemetry?`), `packages/core/src/context.ts` (pass telemetry through; `VID2CONTEXT_LOG_FORMAT=json`), `packages/core/src/chain.ts` (a span and usage record per rung attempt), `packages/core/src/pipeline.ts` (a span per stage), one `export *` line in `packages/core/src/index.ts`, `docs/contracts/providers.md` (document the optional field), your variables in `.env.example` |
| Commit scope | `telemetry` |
| Runs alongside | 49 other prompts in the same folder; depends only on the foundation |

vid2context turns any video into context for AI agents: transcripts, metadata, chapters and cited briefs, free-first, as a CLI, MCP server, HTTP API and web app. Every request already records `attempts`, which is enough to explain one failure to one user. An operator running vid2context for a team needs more: which rungs fail and how often, latency per stage, tokens and audio minutes consumed per provider, and what paid rungs cost, exported to the tools they already use. This prompt adds a zero-cost-when-unused telemetry layer to core, instruments the chain and the pipeline at a few well-chosen points, and exports OpenTelemetry and Prometheus formats with plain `fetch`, so it works on Node, Workers and the browser alike.

## Read first

1. `CLAUDE.md` and `AGENTS.md`, then `docs/ARCHITECTURE.md` (the rung chain, the pipeline stages).
2. `packages/core/src/types.ts` (`Ctx`, `Attempt`, `Logger`), `packages/core/src/context.ts` (`createContext`, `stderrLogger`), `packages/core/src/chain.ts` (`runChain`, cooldowns), `packages/core/src/pipeline.ts` (stages), `packages/core/src/provider.ts` (`ChatResult.usage`, `SttResult`), `packages/core/src/testing.ts`.
3. `docs/contracts/providers.md` and `docs/providers.md` (which rungs are paid).
4. `docs/prompts/SHARED-CONTRACTS.md`, section 8 (shared files: prompts 02, 04, 10, 22 and 42 also make small edits to `pipeline.ts`, and prompt 10 to `chain.ts` and `context.ts`; re-read before each edit and keep yours minimal).

## Goal

`ctx.telemetry` (optional) receives spans for each pipeline stage and each rung attempt, counters and histograms for outcomes and latency, and a usage ledger with tokens, audio seconds and estimated paid cost. When absent, nothing changes and nothing is allocated. Exporters send OTLP/HTTP JSON through `ctx.fetch`, render Prometheus text, and write JSON-lines logs.

## Requirements

### Interface

- `Telemetry` in `packages/core/src/telemetry/`: `span<T>(name: string, attrs: Attrs, fn: (span: Span) => Promise<T>): Promise<T>`, `counter(name, value, attrs)`, `histogram(name, value, attrs)`, `event(name, attrs)`, `flush(): Promise<void>`. `Span` has `setAttributes`, `recordError`, `end`. Attribute values are strings, numbers or booleans.
- Add optional `telemetry?: Telemetry` to `Ctx`, passed through `createContext`. Instrumentation reads `ctx.telemetry` and does nothing at all when it is undefined (no wrapper objects, no closures allocated on the hot path).
- Metric names follow OpenTelemetry semantic style: `vid2context.rung.attempts` (attrs: rung, service, tier, stage, outcome, reason), `vid2context.rung.duration` (ms histogram), `vid2context.stage.duration`, `vid2context.llm.tokens` (direction in or out), `vid2context.stt.audio_seconds`, `vid2context.paid.usd`.

### Instrumentation (minimal edits)

- `chain.ts`: wrap each rung attempt in a span with rung id, service, tier, outcome, reason and duration; record counters and the duration histogram; record usage when the result carries it (LLM `usage`, STT audio duration when known). One small helper call per attempt; do not restructure `runChain`.
- `pipeline.ts`: one span per stage (`resolve`, `metadata`, `captions`, `audio`, `stt`, `video`, `comments`, `save`) around the existing code.
- Never put transcript text, prompts, URLs with query strings, or any env value into attributes. Inputs are recorded as the ref id only.

### Usage ledger and paid guard

- `UsageLedger`: per rung, requests, failures, tokens in and out, audio seconds, estimated USD for paid rungs. Prices come from an env-overridable table (`VID2CONTEXT_PRICE_<RUNG_ID_NORMALIZED>` as `in,out` USD per million tokens or USD per audio minute); ship defaults only for prices you verified on the vendor's pricing page today (note the date), and leave unknown prices unestimated rather than guessing.
- Daily paid guard: `VID2CONTEXT_MAX_PAID_USD_PER_DAY` (per process, UTC day). When exceeded, paid rungs are skipped with attempt reason `budget` and a hint naming the variable. Implement it in the chain's filtering with the smallest possible change, and only when a ledger is present.
- `ledger.snapshot()` returns a plain JSON summary for surfaces (`vid2context models`, a future `/metrics` and the web app).

### Exporters (runtime-neutral)

- OTLP/HTTP JSON for traces and metrics to `OTEL_EXPORTER_OTLP_ENDPOINT` (and the signal-specific variants), headers from `OTEL_EXPORTER_OTLP_HEADERS`, resource attributes `service.name=vid2context`, `service.version`, `deployment.environment` from `OTEL_RESOURCE_ATTRIBUTES`; batched, flushed on an interval and on `flush()`, bounded queue, drops (and counts) on failure, never throws into the request path. Uses `ctx.fetch`.
- Prometheus text exposition: `renderPrometheus(telemetry)` for a future `GET /metrics` route (prompt 46 can mount it).
- JSON-lines logs: when `VID2CONTEXT_LOG_FORMAT=json`, `stderrLogger` writes one JSON object per line (`ts`, `level`, `msg`, data fields, `trace_id` and `span_id` when inside a span). Keep the default human format unchanged.
- W3C trace context: `parseTraceparent` and `formatTraceparent` helpers so servers can continue an incoming trace.
- `createTelemetry(ctxLike, opts)` factory that wires the ledger and whichever exporters env enables.

## Prefer free and local

Not a provider. Everything exports to open formats you can run yourself (an OpenTelemetry Collector, Prometheus, Grafana) with no vendor account.

## Out of scope

- Secret redaction in logs and attempts: prompt 10 (security). Coordinate by not logging anything sensitive in the first place.
- Mounting `/metrics` and request ids in the HTTP server: prompt 46. Progress events for jobs: prompt 42.

## Tests

Put tests in `packages/core/test/telemetry/`.

- Run the real pipeline against the recorded YouTube fixtures in `providers/youtube/test/fixtures/` and the OVH Whisper fixtures in `providers/stt-openai-compatible/test/fixtures/` through `replayFetch`, with an in-memory exporter you implement as part of the module (a real exporter that keeps spans in an array, also useful for surfaces' tests). Assert the span tree (stage spans containing rung spans), attributes, counters and histogram values, and that no attribute contains transcript text.
- Assert that with `telemetry` undefined the chain and pipeline produce identical results to before.
- OTLP payload: assert structure against the OTLP JSON encoding (resourceSpans, scopeSpans, nanosecond string timestamps, hex trace and span ids, attribute value encoding). Capture the payload through a `replayFetch` route that records the request body.
- Paid guard: with a ledger whose recorded spend exceeds the limit, a paid rung is skipped with reason `budget`.
- LIVE: when `OTEL_EXPORTER_OTLP_ENDPOINT` points at a running OpenTelemetry Collector (start one with Docker if available), export a real pipeline run and confirm the collector accepted it (status 200); otherwise report it as unverified.

## Acceptance criteria

- [ ] `npx tsc -p tsconfig.json --noEmit 2>&1 | grep -E 'packages/core/src/(telemetry|types|context|chain|pipeline)'` prints nothing.
- [ ] `npx vitest run packages/core` passes (your tests and the existing core tests).
- [ ] `npx biome check packages/core/src/telemetry packages/core/test/telemetry` is clean.
- [ ] `grep -rn "from 'node:" packages/core/src/telemetry` prints nothing.
- [ ] `VID2CONTEXT_LOG_FORMAT=json npm run cli -- https://www.youtube.com/watch?v=jNQXAC9IVRw` writes valid JSON lines to stderr and unchanged output to stdout.

## Docs

- `docs/observability.md`: what is measured, metric names and attributes, the ledger and paid guard, env variables, and a minimal Collector plus Prometheus setup.
- The optional `telemetry` field in `docs/contracts/providers.md`; your variables in `.env.example` (`VID2CONTEXT_LOG_FORMAT`, `VID2CONTEXT_MAX_PAID_USD_PER_DAY`, `VID2CONTEXT_PRICE_*`, `OTEL_*` you read).

## If credentials, tools or network are missing

No keys are needed. Without Docker or a Collector, test the OTLP payload shape on captured requests and report that a live export was not verified.

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

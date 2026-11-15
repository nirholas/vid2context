# @vid2context/testkit

Conformance suites, registry invariants and a fixture recorder for vid2context. Node-only, for tests and scripts. Full guide: [docs/testing.md](../../docs/testing.md).

## Suites (vitest)

| Function | For |
|---|---|
| `describeSource(provider, { matches, rejects, metadataCases?, metadataErrors? })` | source providers |
| `describeCaptions(provider, { source?, cases, unsupported?, overlapToleranceSec? })` | captions providers |
| `describeSttRung(rung, { audio, options?, routes, env?, expectText?, errors? })` | speech-to-text rungs |
| `describeLlmRung(rung, { request, routes, env?, expectText?, errors? })` | LLM rungs |
| `describeEmbedRung(rung, { texts, routes, env?, errors? })` | embedding rungs |
| `describeStorage(factory, { name?, cleanup?, ttlWaitSec? })` | `Storage` backends, plus `KvStore` and `VectorStore` when implemented |
| `describeFormatter(formatter, contexts?)` | output formatters (default: every file in `tests/fixtures/contexts`) |

The checks behind them are exported too, for your own assertions: `refProblems`, `metadataProblems`, `transcriptProblems`, `rungProblems`, `expectedRungId`, `expectedCodeForStatus`.

## Recorder

| Function | What it does |
|---|---|
| `recordingFetch(realFetch, { dir, name?, scrub? })` | a fetch that performs the real request, scrubs the exchange and writes `<name>-001.json`, ... in call order; `.files`, `.report()`, `.reports()` |
| `fixtureRoutes(dir, { name? })` | recorded files as `Route[]` for `replayFetch` (exact URL plus method; `REDACTED` matches any value; repeats in order) |
| `readRecorded(dir, { name? })` | the parsed exchanges |
| `Scrubber` | the scrubbing rules on their own (`url`, `headers`, `body`, `text`, `report`) |

CLI: `npm run record -- --out <dir> [--name <n>] -- <input> [--mode ...] [--lang xx] [--no-auto]`.

## Invariants

`checkInvariants()` returns `{ violations, notes, providers }` for the generated node, workers and browser registries. `formatReport(report)` renders it as text. `npm run conformance` runs it through vitest (`vitest.conformance.config.ts`) together with the storage suite on `MemoryStorage` and the formatter suite on every formatter.

The building blocks are exported too: `scanPortable(pkgDir, root?, runtime?)` (hits carry `reachable`), `runtimeEntry(pkgDir, runtime)` (the file `exports` conditions resolve to, per `RUNTIME_CONDITIONS`), `reachableFiles(entry)` and `overrideEnv(var, value, documented)`.

## Helpers

`loadContextFixtures()`, `loadContextFixture(file)`, `withoutNetwork(fn)`, `withoutNetworkAsync(fn)`, `offlineContext(env)`, `repoRoot`, `BCP47`.

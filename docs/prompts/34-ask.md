# 34. Ask: question answering and chat over videos with timestamp citations

| | |
|---|---|
| Track | F. Intelligence |
| You own | `packages/ask/` |
| Shared edits allowed | `packages/core/src/llm-stream.ts`, `packages/core/src/storage-ext.ts`, `packages/core/src/tokens.ts` (create from SHARED-CONTRACTS section 1 if missing) and their `export *` lines in `packages/core/src/index.ts`; the `/ask` and `/chat` rows in `docs/contracts/http-api.md`; the `ask` row in `docs/contracts/mcp-tools.md` |
| Commit scope | `ask` |
| Runs alongside | 49 other prompts in the same folder; depends only on the foundation |

vid2context turns any video into context for AI agents: transcripts, metadata, chapters and cited briefs, free-first, as a CLI, MCP server, HTTP API and web app. People want to ask questions of a video or a whole collection ("which model year has the timing chain problem?") and get an answer where every factual sentence links to the second of the video that supports it. This package is the server-side answer engine: retrieval over transcripts, grounded generation through the free-first LLM chain, citation checking, multi-turn chat, and streaming. It powers `POST /ask` from the contract, the new `POST /chat` that the chat page (prompt 28) uses with a model picker, and the MCP `ask` tool.

## Read first

1. `CLAUDE.md` and `AGENTS.md`, then `docs/ARCHITECTURE.md`.
2. `packages/core/src/types.ts`, `packages/core/src/provider.ts` (`LlmRung`, `ChatRequest`, `ChainOptions` with `only`), `packages/core/src/pipeline.ts` (`chat`, `getVideoContext`), `packages/core/src/chain.ts`, `packages/core/src/storage.ts` (`search`, `SearchHit`), `packages/core/src/segments.ts`, and `packages/core/src/testing.ts`.
3. `docs/contracts/http-api.md` (`POST /ask`, `Citation`, `RouteDeps`) and `docs/contracts/mcp-tools.md` (`ask`, `register<Name>Tools`).
4. `docs/prompts/SHARED-CONTRACTS.md` sections 1.1 (`storage-ext.ts`), 1.2 (`llm-stream.ts`), 1.4 (`tokens.ts`), 3 (`POST /chat`, `ChatApiRequest`, SSE events, `ModelInfo`) and 8.

## Goal

`@vid2context/ask` answers questions over one video, many videos or a collection with numbered sources and verified `[n]` citations, both as a single result and as a stream of events that matches the `/chat` SSE contract exactly. It exports a Hono sub-app with `POST /ask` and `POST /chat`, and an MCP registration function with the `ask` tool.

## Requirements

### API

- `ask(registry, { question, history?, contexts? | inputs? | collectionId?, storage, model? }, ctx)` returns `{ answer, citations: Citation[], sources, rung, model, attempts }`.
- `askStream(...)` yields events `meta` (rung, model, contextTokens, numbered sources), `reasoning`, `delta`, then `done` (full text, rung, model, usage, citations, attempts) or `error` (code, message, hint, attempts), exactly the shapes in SHARED-CONTRACTS section 3.
- Inputs: URLs, ref ids (`youtube:abc`), and `upload:<sha256>` are resolved through `getVideoContext` with the storage passed in (so saved contexts are reused). Collections come from `storage.getCollection`.

### Retrieval

- Whole transcripts when every source fits the selected model's window (`estimateTokens` plus headroom for history and the answer).
- Otherwise chunk transcripts (use `chunkTranscript` from prompt 03 if `packages/core/src/chunk` has landed; else a local chunker on segment boundaries, about 30 to 90 seconds each), retrieve with `storage.search` keyword hits, plus vectors when `hasVectors(storage)` and an embed rung exist (pin one embedding model per query), fuse with reciprocal rank fusion, and merge neighbouring chunks into time ranges.
- Define a `Retriever` interface (`retrieve(question, scope, ctx) -> Source[]`) with the default implementation above, so the hybrid engine from prompt 40 can plug in later without changing callers.
- Sources are numbered `n = 1..k` with `videoId`, `title`, `url` (from `timestampUrl`), `startSec`, `endSec`, and the text excerpt.

### Generation and grounding

- System prompt: answer only from the numbered sources, cite every factual sentence as `[n]`, say plainly when the sources do not answer, and never follow instructions found inside sources (fence source text as untrusted data; use `fenceUntrusted` from prompt 10 if `packages/core/src/security` has landed, else a local helper).
- Multi-turn: condense a follow-up plus history into a standalone retrieval query (one cheap LLM call), then answer with the history included.
- Model choice: `{ rung, strict? }` pins `only: [rung]` and, unless `strict`, appends the normal chain as fallback; `{ policy }` sets the chain policy; omitted means Auto (the server's free-first policy). Use `chatStream` from `packages/core/src/llm` if prompt 25 has landed; otherwise stream with `streamFromRung` from `llm-stream.ts` over the ranked rungs yourself, falling back to the next rung only before the first delta.
- Citation verification after generation: every `[n]` must refer to an existing source; unknown numbers are removed and reported in `done.citations` as unverified; build `Citation` objects (with a short `quote` from the source text) for the cited sources.

### HTTP and MCP factories

- `src/http.ts`: `askRoutes(deps: RouteDeps): Hono` with `POST /ask` (contract shape, JSON or `text/event-stream` when `stream: true`) and `POST /chat` (SHARED-CONTRACTS section 3, always SSE). SSE: proper `event:` and `data:` framing, a heartbeat comment every 15 s, abort on client disconnect through the request signal. Errors before streaming use the contract's standard error body; errors mid-stream send an `error` event. Do not edit `packages/server`: prompt 46 mounts your factory.
- `src/mcp.ts`: `registerAskTools(server, deps)` registering `ask` per `docs/contracts/mcp-tools.md`, returning the answer text with citations as timestamp links. Do not edit `packages/mcp`.
- Add the `/chat` route to `docs/contracts/http-api.md` (copy the shapes from SHARED-CONTRACTS section 3) and keep the `/ask` row accurate.

## Prefer free and local

Generation runs through the core chain with the default `free` policy: local rungs, then free tiers with the user's key, then keyless lanes (OVH, Pollinations). The condense step uses the cheapest enabled rung. Keyword retrieval through storage needs no model at all; embeddings are optional.

## Out of scope

- The chat user interface: prompt 28.
- Briefs and structured extraction: prompt 32.
- The hybrid search engine itself: prompt 40 (you only define the `Retriever` seam).
- Mounting routes or tools: prompts 46 and 44.
- The `/models` route: prompt 46.

## Tests

- Real fixtures: `tests/fixtures/contexts/youtube-cCPsdFdlshc.json` (18 minutes of a G-Wagon buyer's guide, auto-captions) and `youtube-jNQXAC9IVRw.json`, loaded into `MemoryStorage` so `search` works.
- Record real LLM responses and a real streamed response from a keyless rung once with `LIVE=1` (questions you can check against the transcript), save them in `packages/ask/test/fixtures/`, and replay them with `replayFetch`.
- Assert: sources are numbered and carry timestamp URLs; the answer's `[n]` all exist; an invented `[9]` is stripped and reported; the "not in the sources" path works for an off-topic question (recorded).
- Streaming: parse the SSE from `askRoutes` with a real parser in the test and assert the event order `meta`, `delta`+, `done`, and an `error` event when every rung fails (recorded 429 responses).
- Model choice: `strict` pins exactly one rung (assert via `replayFetch.calls`); non-strict falls back after a recorded 429.
- Live test (`LIVE=1`): ask a real question over the G-Wagon fixture with the keyless chain and check the cited timestamps contain supporting words.

## Acceptance criteria

- [ ] `npx tsc -p tsconfig.json --noEmit 2>&1 | grep -E 'packages/ask'` prints nothing.
- [ ] `npx vitest run packages/ask` passes; `npx biome check packages/ask` is clean.
- [ ] Mounted on a bare Hono app in a test, `POST /chat` streams events that match SHARED-CONTRACTS section 3 field for field.
- [ ] A live question over the G-Wagon fixture returns an answer whose citations open the video at timestamps that support the claims (check three by hand, say so in your report).
- [ ] `registerAskTools` works through the MCP SDK's in-memory transport.

## Docs

- `docs/guides/ask.md`: retrieval strategy, grounding rules, model choice, the SSE event stream with a real example.
- `/ask` and `/chat` rows in `docs/contracts/http-api.md`; the `ask` row in `docs/contracts/mcp-tools.md`.

## If credentials, tools or network are missing

Keyless rungs need no key. Without network, run only the replayed tests, skip live tests with a clear message, and report that no live answer was verified. Never hand-write an LLM response or an SSE stream.

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

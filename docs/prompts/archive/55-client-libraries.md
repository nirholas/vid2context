# 55. Client libraries: Python, LangChain and LlamaIndex

| | |
|---|---|
| Track | L. Reach (wave 2) |
| You own | `clients/python/` (new), `packages/langchain/` (new package `@vid2context/langchain`) |
| Shared edits allowed | your entry in `THIRD_PARTY_NOTICES.md` if you copy code; one `exclude` entry for `clients/**` in root `tsconfig.json` only if TypeScript tries to read your Python folder (re-read the file first) |
| Commit scope | `clients` |
| Runs alongside | wave 1 (01 to 50) and the other wave 2 prompts; depends only on the foundation |

vid2context turns any video into context for AI agents. Most people building agents and RAG pipelines work in Python, through LangChain and LlamaIndex. A document loader there ("load this playlist as documents with timestamp metadata") is one of the biggest distribution channels for a tool like this, and no wave-1 prompt covers it. The core stays TypeScript (Python was rejected for the core because Workers and browsers run JS); these are thin clients of the HTTP API.

## Read first

1. `CLAUDE.md` and `AGENTS.md`, then `docs/ARCHITECTURE.md`.
2. `docs/contracts/http-api.md` in full (implemented routes and the error body; planned routes your client should support when they exist).
3. `packages/server/src/app.ts` and its tests (what is implemented right now), `packages/core/src/types.ts` (`VideoContext` shape).
4. The current LangChain (Python and JS) document loader interfaces and LlamaIndex reader interface (fetch their docs; verify class names and import paths for current versions).
5. `docs/prompts/SHARED-CONTRACTS.md` section 8.

## Goal

`pip install` of the local package, then `VideoContextLoader("https://youtu.be/jNQXAC9IVRw").load()` in Python returns LangChain `Document`s with text and metadata (title, channel, url, start time, timestamp URL), produced by a running vid2context server. The JS loader does the same in LangChain.js.

## Requirements

### Python package (`clients/python/`)

- `pyproject.toml` (hatchling or setuptools), package name `vid2context`, Python 3.10+, only dependency `httpx`. Optional extras `langchain` (`langchain-core`) and `llama-index` (`llama-index-core`), imported lazily with a clear error when missing.
- `vid2context.Client(base_url=..., api_key=None, timeout=...)` and `AsyncClient`: `health()`, `context(url, mode=None, lang=None)`, `transcript(url, format="text", timestamps=False, ...)`; methods for planned routes (`items`, `section`, `search`, collections) only when the route exists in `packages/server` when you finish; otherwise leave them out and list them in your report. Base URL from the argument or `VID2CONTEXT_API_URL`, API key from `VID2CONTEXT_API_KEY` (sent as `Authorization: Bearer`).
- Typed models (dataclasses or TypedDicts, no pydantic dependency) mirroring `VideoContext`, `VideoMetadata`, `Segment`, `Attempt`. Errors: `Vid2ContextError` with `code`, `message`, `hint`, `attempts`, `status`, parsed from the contract's error body.
- `vid2context.langchain.VideoContextLoader(urls, chunking="chapters" | "segments" | "window", window_sec=60, client=None)`: one `Document` per chapter (or window), with metadata `source`, `title`, `channel`, `video_id`, `start_sec`, `end_sec`, `url` (timestamp link), `transcript_origin`, `language`. Implement `lazy_load`.
- `vid2context.llama_index.VideoContextReader` with `load_data(urls)` returning LlamaIndex `Document`s with the same metadata.
- Build with `uv build` (uv is on the machine at `~/.local/bin/uv`); do not publish.

### JS package (`packages/langchain/`)

- `VideoContextLoader` extending LangChain.js's base document loader, calling the HTTP API with `fetch` (configurable base URL and key), same chunking and metadata. `@langchain/core` as a peer dependency.

## Prefer free and local

The clients talk to a vid2context server the user runs (default `http://127.0.0.1:8787`), so everything stays free and local unless the user points them elsewhere.

## Out of scope

- Publishing to PyPI or npm: item 38 handles release tooling; describe the steps in your README.
- A Python reimplementation of the pipeline.

## Tests

- Record real HTTP responses from a real vid2context server: start `packages/server` on a random port, call it for `jNQXAC9IVRw` and `cCPsdFdlshc` and for an error case (an unavailable id), and save the bodies and statuses as fixtures in `clients/python/tests/fixtures/` (documented in a README). Python tests (pytest, run through `uv run pytest`) replay them with `httpx.MockTransport` serving those recorded bodies only, and cover the client, error parsing, both loaders and chunking modes. A live test (`LIVE=1`) starts nothing itself: it reads `VID2CONTEXT_API_URL` and is skipped when unset.
- JS tests replay the same recorded bodies through `replayFetch`.
- Do not add Python tests to vitest; document `uv run pytest` in your README and report the result.

## Acceptance criteria

- [ ] `cd clients/python && uv run pytest` passes; `uv build` produces a wheel and sdist.
- [ ] `npx tsc -p tsconfig.json --noEmit 2>&1 | grep packages/langchain` prints nothing; `npx vitest run packages/langchain` passes; `npx biome check packages/langchain` is clean.
- [ ] LIVE: with a local server running, the Python loader loads the G-Wagon video as chapter or window documents; paste the first document's metadata.

## Docs

- `clients/python/README.md` and `packages/langchain/README.md`: install from the repo, quick start, loader options, metadata fields.

## If credentials, tools or network are missing

No key is needed. If `uv` is missing, use `python3 -m venv` and pip, and report it. If YouTube blocks the machine while recording, record against a local media file through the server instead and report it.

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

You are one of many agents working at the same time in this folder (wave 1 prompts 01 to 50 and wave 2 prompts 51 to 62), each owning different directories.

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

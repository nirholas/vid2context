# 44. MCP server: tools, resources and prompts

| | |
|---|---|
| Track | H. Surfaces |
| You own | `packages/mcp/` (you are its only editor during the wave) |
| Shared edits allowed | `docs/contracts/mcp-tools.md` (move tools from "Planned" to "Implemented", add `list_models`); `packages/core/src/tokens.ts` (create from SHARED-CONTRACTS 1.4 if missing) and its `export *` line |
| Commit scope | `mcp` |
| Runs alongside | 49 other prompts in the same folder; depends only on the foundation |

vid2context turns any video into context for AI agents: transcripts, metadata, chapters and cited briefs, free-first, as a CLI, MCP server, HTTP API and web app. MCP is how the owner actually uses it: Claude Code in VS Code calls the server with a URL and gets the transcript, and later ChatGPT does the same over the remote transport. Today the server has two tools, `get_transcript` and `get_metadata`. Agents need more than whole transcripts: a 15-episode series is about 90k tokens, so they need an outline first, sections on demand, search across saved videos, collections, and prompts that teach them to write cited briefs. This prompt builds the full tool set from the contract, written for agents to use well.

## Read first

1. `CLAUDE.md` and `AGENTS.md` (operating rules and commands), then `docs/ARCHITECTURE.md`.
2. `packages/core/src/types.ts`, `packages/core/src/provider.ts`, `packages/core/src/pipeline.ts`, `packages/core/src/storage.ts`, `packages/core/src/segments.ts` and `packages/core/src/testing.ts`.
3. `docs/contracts/mcp-tools.md` in full: rules for every tool, implemented tools, planned tools with owners, the `register<Name>Tools` pattern, prompts and resources. Tool names there are final (`search_transcript`, singular).
4. `packages/mcp/src/server.ts`, `packages/mcp/src/bin.ts`, `packages/mcp/test/mcp.test.ts` (keep `createServer(registry, ctx, version)`, `toolError` and `contextHeader` working).
5. `docs/prompts/SHARED-CONTRACTS.md`, sections 3 (`ModelInfo`), 4 (the `list_models` addition) and 8.

## Goal

`createServer(registry, ctx)` exposes every tool the contract assigns to item 44, plus `list_models`, the prompts and resources in the contract, and calls every `register<Name>Tools` function from parallel packages that exist when you finish. Every tool is tested through a real MCP client, and the server is verified from Claude Code and the MCP Inspector.

## Requirements

### Tools (names, inputs and outputs exactly as `docs/contracts/mcp-tools.md`)

- Keep `get_transcript` and `get_metadata`. Add `maxTokens` and `cursor` to `get_transcript` (additive): when the rendered transcript exceeds `maxTokens` (via `estimateTokens`), return the first part and a continuation cursor, and say so in the text.
- `list_formats`: from the `formatters` map at runtime.
- `get_outline`: metadata, chapters (or time sections of about 5 minutes when there are none) with estimated tokens per chapter and the total. Use prompt 03's `outline()` from `@vid2context/core` if it exists when you finish; otherwise compute it locally with `estimateTokens` and `sliceSegments`, and report it.
- `get_section`: `{ url, from?, to?, chapter?, format?, timestamps? }`; `from`/`to` accept seconds or `m:ss`/`h:mm:ss`; `chapter` is an index or a title match.
- `list_items`: through `expandInput`.
- `search_transcript`: `Storage.search` on `registry.openStorage(ctx)` (or `MemoryStorage`), hits with title, `[m:ss]`, text and timestamp URL. If `registerSearchTools` from `@vid2context/search` (prompt 40) exists when you finish, let it own the tool instead.
- `get_comments`: through `getVideoContext` with `comments`.
- `export_context_pack`: the `pack` formatter via `renderMany` (prompt 01) when present, else per-video `text` with headers; report which.
- Collection tools (`list_collections`, `create_collection`, `add_to_collection`, `get_collection`) over the `Storage` collection methods; if `registerLibraryTools` from `@vid2context/library` (prompt 41) exists, call it instead.
- `list_models`: `ModelInfo[]` from the rungs (`registry.llmRungs(env)` and the other getters), `capabilities` plus `stream` when `canStream` (from `llm-stream.ts`) says so; use `listModels` from prompt 25 if exported. Never include env values.
- Tools backed by other packages (`ask` from 34, `extract` and `build_brief` from 32): call `registerAskTools`, `registerInsightsTools` (or whatever the package's `src/mcp.ts` exports) when they exist. Check for each `src/mcp.ts` before finishing; list missing ones in your report for a one-line wiring later.

### Agent-quality descriptions and schemas

- Each tool description says when to use it, what it returns, and roughly what it costs in tokens (for example "about 12k tokens per hour of video; call get_outline first for long videos").
- JSON Schema inputs with descriptions per field; `outputSchema` plus `structuredContent` where the result is structured; annotations `readOnlyHint`, `openWorldHint`, `idempotentHint` set truthfully (collection writes are not read-only).
- Errors are tool results with `isError: true` and the contract's JSON body, never protocol errors. Each call gets its own `Ctx` with the call's abort signal.
- Progress notifications for long operations (`add_to_collection` over a playlist) when the client sends a progress token.

### Prompts and resources

- Prompts `brief` and `buyer_guide` (contract names), each producing messages that tell the calling agent to fetch the outline, read sections, search, and cite every claim as `[Title @ m:ss](url)`, flagging consensus and disagreement. Use prompt text exported by `@vid2context/insights` (prompt 32) if it exists; otherwise write it here.
- Resources and templates: `vid2context://video/{id}`, `vid2context://video/{id}/transcript`, `vid2context://collection/{id}`, listing saved items from storage.

## Prior art you may reuse

jkawamoto/mcp-youtube-transcript (MIT) pages long transcripts with `next_cursor`; kimtaeyoon83/mcp-server-youtube-transcript (MIT) caps output with `max_tokens`; coyaSONG/youtube-mcp-server (MIT) ships resources and prompts worth comparing against. Licenses and attribution rules: `docs/prior-art.md`. Copy only MIT, BSD, ISC, Unlicense or Apache-2.0 code, keep the original copyright line in the copied file, and add the project to `THIRD_PARTY_NOTICES.md` (create it if missing; additive edits only). Never copy GPL or unlicensed code.

## Out of scope

- The Streamable HTTP transport, OAuth and the tunnel guide: prompt 45 (`packages/mcp-http`). Keep `createServer` free of transport code so 45 can serve it unchanged.
- The logic of ask, briefs, extraction, search and collections: prompts 34, 32, 40, 41. You wire their registration functions.
- Install commands for each agent client: prompt 16 (agent integrations).

## Tests

- Use the SDK's in-memory linked transport pair (`InMemoryTransport.createLinkedPair()`) with a real `Client`: a real transport, not a mock. Call every tool against a `testContext` whose `replayFetch` serves recorded fixtures (`providers/youtube/test/fixtures/`, plus your own recordings in `packages/mcp/test/fixtures/` documented in its README).
- Assert schemas (`listTools`), outputs, `isError` bodies with hints, pagination of `get_transcript` on the long `cCPsdFdlshc` fixture, `get_section` by time and by chapter on the `jNQXAC9IVRw` fixture (it has 3 chapters), `list_models` never containing a key value set in the test env.
- Prompts and resources listed and readable.
- `LIVE=1`: spawn `npx tsx packages/mcp/src/bin.ts` and drive it over stdio with the SDK client against real YouTube.

## Acceptance criteria

- [ ] `npx tsc -p tsconfig.json --noEmit 2>&1 | grep packages/mcp/` prints nothing.
- [ ] `npx vitest run packages/mcp` passes.
- [ ] `npx biome check packages/mcp` is clean.
- [ ] `npx @modelcontextprotocol/inspector --cli npx tsx packages/mcp/src/bin.ts --method tools/list` lists every tool, and a `tools/call` of `get_outline` on a real YouTube URL succeeds (record the commands and output in your report).
- [ ] `claude mcp add vid2context -- npx tsx packages/mcp/src/bin.ts` is documented, and you state whether you verified it from a Claude Code session.
- [ ] `docs/contracts/mcp-tools.md` lists what is implemented and what is still planned.

## Docs

- Update `docs/contracts/mcp-tools.md`.
- `docs/guides/mcp.md`: setup for Claude Code and other stdio clients, every tool with an example call, the outline-first reading strategy, and how citations look.

## If credentials, tools or network are missing

No key is needed. Without network, test through the in-memory transport on recorded fixtures and skip LIVE tests with a clear message. If the Inspector cannot be installed, verify over stdio with the SDK client and say so.

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

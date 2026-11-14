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
- `list_models`: `ModelInfo[]` from the rungs (`registry.llmRungs(env)` and the other getters), `capabilities` plus `streaming` when `canStream` (from `llm-stream.ts`) says so; use `listModels` from prompt 25 if exported. Never include env values.
- Tools backed by other packages (`ask` from 34, `extract` and `build_brief` from 32): call `registerAskTools`, `registerInsightsTools` (or whatever the package's `src/mcp.ts` exports) when they exist. Check for each `src/mcp.ts` before finishing; list missing ones in your report for a one-line wiring later.

### Agent-quality descriptions and schemas

- Each tool description says when to use it, what it returns, and roughly what it costs in tokens (for example "about 12k tokens per hour of video; call get_outline first for long videos").
- JSON Schema inputs with descriptions per field; `outputSchema` plus `structuredContent` where the result is structured; annotations `readOnlyHint`, `openWorldHint`, `idempotentHint` set truthfully (collection writes are not read-only).
- Errors are tool results with `isError: true` and the contract's JSON body, never protocol errors. Each call gets its own `Ctx` with the call's abort signal.
- Progress notifications for long operations (`add_to_collection` over a playlist) when the client sends a progress token.

### Prompts and resources

- Prompts `brief` and `buyer_guide` (contract names), each producing messages that tell the calling agent to fetch the outline, read sections, search, and cite every claim as `[Title @ m:ss](url)`, flagging consensus and disagreement. Use prompt text exported by `@vid2context/insights` (prompt 32) if it exists; otherwise write it here.
- Resources and templates: `vid2context://video/{id}`, `vid2context://video/{id}/transcript`, `vid2context://collection/{id}`, listing saved items from storage.

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

<!-- COMMON -->

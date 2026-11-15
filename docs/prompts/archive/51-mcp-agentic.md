# 51. MCP sampling, elicitation, completions and subscriptions

| | |
|---|---|
| Track | J. Agent experience (wave 2) |
| You own | `packages/mcp-agentic/` (new package `@vid2context/mcp-agentic`) |
| Shared edits allowed | your rows in `docs/providers.md` and `.env.example`; your entry in `THIRD_PARTY_NOTICES.md` if you copy code |
| Commit scope | `mcp-agentic` |
| Runs alongside | wave 1 (01 to 50) and the other wave 2 prompts; depends only on the foundation |

vid2context turns any video into context for AI agents: transcripts, metadata, chapters and cited briefs, free-first, as a CLI, MCP server, HTTP API and web app. A core design rule is that the calling agent does the synthesis, so the user needs no extra key. MCP has four features that make this much better, and the wave-1 plan uses none of them. **Sampling** lets the server ask the client's own model to do work (digest each video of a 15-episode series, then combine the digests), so server-side map-reduce costs the user nothing extra. **Elicitation** lets the server ask the user mid-call ("pick a caption language", "transcribe 40 minutes of audio?"). **Completions** autocomplete prompt and resource arguments such as collection ids. **Resource subscriptions** tell the agent when a watched collection gains a video. This prompt builds all four as a package that the MCP server mounts.

## Read first

1. `CLAUDE.md` and `AGENTS.md`, then `docs/ARCHITECTURE.md` ("Who synthesizes").
2. `packages/core/src/types.ts`, `provider.ts`, `pipeline.ts`, `storage.ts`, `segments.ts`, `testing.ts`.
3. `packages/mcp/src/server.ts` and its tests: how tools are registered, `toolError`, `contextHeader`, per-call `Ctx`.
4. `docs/contracts/mcp-tools.md`: the rules for every tool and the "Wave 2 tools" table (your names: `digest_videos`, `choose_caption_track`, prompt `digest`, resource `vid2context://collection/{id}/latest`).
5. The MCP specification pages for sampling, elicitation, completion and resource subscriptions (fetch the current spec from modelcontextprotocol.io), and the SDK's `server/index.d.ts` (`createMessage`, `elicitInput`, `getClientCapabilities`, `registerCapabilities`, `sendResourceUpdated`) and `server/completable.d.ts` in `node_modules/@modelcontextprotocol/sdk`.
6. `docs/prior-art.md`, and `docs/prompts/SHARED-CONTRACTS.md` sections 1 (`tokens.ts` if present) and 8.

## Goal

`registerAgenticFeatures(server, deps)` adds the tools, prompt and resource above to any `McpServer`. With a client that supports sampling, `digest_videos` on a playlist of real videos returns one digest where every claim cites `[Title @ m:ss](url)`, produced entirely by the client's model. With a client that does not, the same call returns a usable chunk plan instead of failing.

## Requirements

### Package shape

- `packages/mcp-agentic/src/index.ts` exports `registerAgenticFeatures(server: McpServer, deps: { registry: Registry; ctx: Ctx; storage?: (ctx: Ctx) => Promise<Storage | null> })` plus the helpers below. `src/mcp.ts` re-exports `registerAgenticFeatures` as the package's registration entry (the contract's `register<Name>Tools` pattern).
- Depend on `@modelcontextprotocol/sdk` (same major as `packages/mcp`), `zod`, `@vid2context/core`. No transport code: the same function must work over stdio and Streamable HTTP.
- Call `server.server.registerCapabilities(...)` for what you add (resource subscriptions, completions) before the server connects; document that it must be called before `connect`.

### Sampling: `digest_videos`

- Inputs per the contract. Resolve inputs with `expandInput` (playlists become videos) and `getVideoContext` (honour `deps.storage` as the cache).
- Chunk each transcript by chapters when present, otherwise by time windows sized to `maxTokensPerVideo` (default 6000) using `estimateTokens` from `packages/core/src/tokens.ts` if it exists, else a documented chars-per-token estimate in your package. Keep `[m:ss]` markers in the chunk text.
- Map: for each chunk, `server.server.createMessage` with a system prompt that demands notes where every claim ends with `[m:ss]`, a `maxTokens` budget, and `modelPreferences` that favour cost and speed (`costPriority` high). Reduce: one more sampling call combining the notes into a digest that cites `[Title @ m:ss](timestampUrl)`, flags where sources agree and disagree, and answers `question` when given.
- Validate citations: every `[m:ss]` in model output must fall inside the cited video's duration and match a segment within a tolerance (default 5 seconds); drop or flag claims whose timestamp does not exist, and say how many were dropped.
- Progress notifications per chunk when the client sends a progress token. Honour cancellation (`extra.signal`) between calls.
- Run map calls with bounded concurrency (default 3), since some clients serialize sampling.
- If `getClientCapabilities()?.sampling` is absent: return the chunk plan (video, chunk index, time range, token estimate, the exact map and reduce instructions) so the agent can do the same work itself. Never an error for missing sampling.

### Elicitation: `choose_caption_track`, `confirmExpensive`

- `choose_caption_track { url }`: list tracks through the captions provider's `listTracks`; if there is more than one and the client supports elicitation, `server.server.elicitInput` with an enum schema of the tracks (label "English (auto-generated)" and so on); fetch and return the chosen transcript with `contextHeader`. Declined or cancelled: return the track list. No elicitation support: return the track list with an instruction to call `get_transcript` with `language`.
- Export `confirmExpensive(server, opts: { message: string; estimateMinutes: number }): Promise<'accept' | 'decline' | 'unsupported'>` for other tools (item 44 can use it before speech-to-text on long audio). Threshold env var `VID2CONTEXT_CONFIRM_STT_MINUTES` (default 20), read from `ctx.env`.

### Completions

- Register prompt `digest` with arguments wrapped in `completable()`: `collection` completes collection ids and names from storage; `urls` completes saved video ids and titles (prefix match, at most 20). Export `completeCollections(storage, prefix)` and `completeVideos(storage, prefix)` so item 44 can use them for its own prompts and resource templates.

### Subscriptions

- Resource template `vid2context://collection/{id}/latest` (the 20 newest videos of a collection as JSON). Handle `resources/subscribe` and `resources/unsubscribe` (request handlers on `server.server`), track subscriptions per session, and export `notifyCollectionUpdated(server, collectionId)` that sends `notifications/resources/updated` to subscribers. The library package (41) calls it after ingest; if `@vid2context/library` exposes an event or callback when you finish, wire it, else list it for the integration pass.

## Prefer free and local

Sampling uses the client's own model, so no key at all. Nothing in this package calls a hosted LLM directly.

## Out of scope

- The base tools (`get_transcript`, `get_outline`, ...): item 44. Transports: 44 and 45. Library ingest: 41.
- Choosing the server-side brief engine for very large collections without sampling: item 32 (`build_brief`).

## Tests

- Connect a real SDK `Client` to a server with your features over `InMemoryTransport`. Declare `sampling` and `elicitation` client capabilities and implement the client's `sampling/createMessage` handler with the real vid2context LLM chain (`chat()` from core with the registry): unit tests replay recorded real chain responses through `replayFetch` (record them with `LIVE=1` against the keyless OVH or Pollinations lanes for the exact prompts your code sends, and document them in `test/fixtures/README.md`); the LIVE test calls the chain for real.
- Use the shared real contexts in `tests/fixtures/contexts/` (served through a `MemoryStorage` pre-filled with them, so no YouTube calls) for chunking and citation validation.
- Cover: map and reduce call counts, citation validation dropping an out-of-range timestamp that the recorded model output really produced (if the recorded output has none, assert the validator on the recorded text and report it), the no-sampling fallback, elicitation accept, decline and unsupported paths (the client handler's answer is the test's user input), completions for a prefix, subscribe then `notifyCollectionUpdated` delivering an update to the subscribed client only.
- Optional live check: add the stdio server with your features to Claude Code and report whether the client supports sampling and elicitation today.

## Acceptance criteria

- [ ] `npx tsc -p tsconfig.json --noEmit 2>&1 | grep packages/mcp-agentic` prints nothing.
- [ ] `npx vitest run packages/mcp-agentic` passes; `npx biome check packages/mcp-agentic` is clean.
- [ ] LIVE: `digest_videos` on two real YouTube videos with the client handler on the keyless chain returns a digest whose citations all validate. Paste a trimmed sample in your report.

## Docs

- `packages/mcp-agentic/README.md`: what each feature does, which clients support it (as far as you can verify), how item 44 mounts it, and the fallback behaviour.
- `VID2CONTEXT_CONFIRM_STT_MINUTES` in `.env.example` and `docs/providers.md` (chain controls section, your row only).

## If credentials, tools or network are missing

No key is needed. If the keyless lanes are rate-limited, wait for the quota window (about one minute) and retry. If YouTube blocks the machine, use the shared fixture contexts and report it.

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

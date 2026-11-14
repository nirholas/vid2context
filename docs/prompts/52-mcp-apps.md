# 52. MCP Apps: an interactive transcript viewer inside ChatGPT and Claude

| | |
|---|---|
| Track | J. Agent experience (wave 2) |
| You own | `packages/mcp-apps/` (new package `@vid2context/mcp-apps`) |
| Shared edits allowed | your entry in `THIRD_PARTY_NOTICES.md` if you copy code |
| Commit scope | `mcp-apps` |
| Runs alongside | wave 1 (01 to 50) and the other wave 2 prompts; depends only on the foundation |

vid2context turns any video into context for AI agents. The owner researches on YouTube and uses ChatGPT as well as Claude. MCP Apps (the MCP extension that ChatGPT's Apps SDK and Claude both render) let a tool return an interactive UI inside the chat. A transcript viewer there, with chapters, search, clickable timestamps and one-click citations, is the best way to read a video's context in ChatGPT, far beyond uploading a file. No wave-1 prompt builds it. The official SDK is `@modelcontextprotocol/ext-apps` (MIT); samson-art/transcriptor-mcp (MIT) ships MCP Apps widgets you may study.

## Read first

1. `CLAUDE.md` and `AGENTS.md`, then `docs/ARCHITECTURE.md`.
2. `packages/core/src/types.ts`, `segments.ts` (`timestampUrl`, `formatTimestamp`), `pipeline.ts`, `testing.ts`.
3. `packages/mcp/src/server.ts` (`contextHeader`, `toolError`, per-call `Ctx`).
4. `docs/contracts/mcp-tools.md`, "Wave 2 tools" (`open_transcript_viewer`, `ui://vid2context/transcript-viewer`).
5. The current MCP Apps specification and the `@modelcontextprotocol/ext-apps` README and types (install it and read them; fetch the spec from modelcontextprotocol.io), plus OpenAI's Apps SDK docs on how ChatGPT renders MCP Apps resources (metadata keys, CSP, display modes). Verify everything against current docs, not memory.
6. `docs/prior-art.md`, `docs/prompts/SHARED-CONTRACTS.md` section 6 (design tokens) and 8.

## Goal

`registerAppsTools(server, deps)` adds `open_transcript_viewer`. In a client that supports MCP Apps, calling it on a YouTube URL shows the viewer; in one that does not, the same call returns the normal text header and transcript.

## Requirements

### Tool and resource

- `open_transcript_viewer { url, language? }`: `getVideoContext`, then return `structuredContent` `{ metadata, chapters, segments, timestampBase }` (segments as `[startSec, endSec, text]` tuples to save tokens), a text fallback (`contextHeader` plus the first part of the transcript, capped, with a note that the full transcript is in the viewer), and the tool metadata that links the UI resource, exactly as the current spec and ext-apps SDK define it.
- Register the UI resource `ui://vid2context/transcript-viewer` with the spec's HTML mime type, using the ext-apps server helpers if they fit the SDK version in `packages/mcp`.

### The viewer (one self-contained HTML document)

- Inline CSS and JS only: no external scripts, fonts or images (MCP Apps hosts sandbox the iframe with a strict CSP). Write the viewer in TypeScript under `src/ui/` and bundle it into one HTML string with esbuild (already in the tree through tsx) from `scripts/build-viewer.mjs` in your package. Commit the built output as `src/ui/viewer.html.ts` (so the package still exports source with no build step), and add a test that rebuilds it and fails if the committed output is stale.
- Features: title, channel and duration header; chapter list that jumps; full-text search with match highlighting and next/previous; each line shows `[m:ss]`; clicking a timestamp opens the video at that moment (through the host's open-link capability from the ext-apps client API, falling back to a plain link); a "copy citation" button per line producing `[Title @ m:ss](url)`; "send to chat" for a selected range using the host's message capability when available; light and dark themes from the host's theme hint.
- Accessible: keyboard navigation, focus states, ARIA labels, readable at 360 px wide.
- Long transcripts (an hour is about 1,500 lines): render with windowing so the iframe stays fast.

### Package shape

- `src/mcp.ts` exports `registerAppsTools(server: McpServer, deps: { registry: Registry; ctx: Ctx })`. No transport code.

## Prefer free and local

No services beyond the existing pipeline.

## Out of scope

- Serving the server over HTTPS for ChatGPT: item 45. The web app: 47.

## Tests

- Real data: render the viewer against `tests/fixtures/contexts/youtube-cCPsdFdlshc.json` (521 real segments) in a DOM test environment (add `happy-dom` or `jsdom` to your package's devDependencies) and assert chapter jumps, search hits for a word that really occurs, citation text, and windowing (only a bounded number of line elements exist).
- Tool test over `InMemoryTransport` with a real SDK client: the result carries `structuredContent`, the UI resource link and the text fallback; `resources/read` on the UI URI returns the HTML with the right mime type. Serve the context from a `MemoryStorage` pre-filled with the shared fixture so no network is touched.
- Stale-bundle test as described above.

## Acceptance criteria

- [ ] `npx tsc -p tsconfig.json --noEmit 2>&1 | grep packages/mcp-apps` prints nothing; `npx vitest run packages/mcp-apps` passes; `npx biome check packages/mcp-apps` is clean.
- [ ] The HTML has no external URLs except timestamp links (test asserts it).
- [ ] Report whether you could render it in a real MCP Apps host (for example the ext-apps example host or ChatGPT developer mode through a tunnel); if not, say what the integration pass must do to try it.

## Docs

- `packages/mcp-apps/README.md`: what the viewer does, supported hosts as verified, how 44 mounts it, how 45 exposes it to ChatGPT.

## If credentials, tools or network are missing

No key is needed. If you cannot reach a real MCP Apps host, verify with the DOM tests and the protocol test, and report that live rendering is unverified.

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

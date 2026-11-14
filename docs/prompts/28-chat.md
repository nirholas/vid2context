# 28. The chat workspace with a model picker

| | |
|---|---|
| Track | H. Surfaces |
| You own | `packages/chat/` |
| Shared edits allowed | root `tsconfig.json` (add `packages/chat/**` to `exclude`), `packages/core/src/llm-stream.ts` and `packages/core/src/tokens.ts` (create from SHARED-CONTRACTS 1.2 and 1.4 if missing, with their export lines) |
| Commit scope | `chat` |
| Runs alongside | 49 other prompts in the same folder; depends only on the foundation |

vid2context turns any video into context for AI agents: transcripts, metadata, chapters and cited briefs, free-first, as a CLI, MCP server, HTTP API and web app. The owner wants a chat-style page where users talk to their videos and decide which LLM answers, modeled on the LobeHub chat UI they shared: a conversation sidebar, a streaming thread, a composer, and a model picker popover with "Auto" at the top, models grouped by provider, capability icons and a context-size badge. Answers cite the videos with timestamps, and clicking a citation opens the video at that moment. This prompt builds that workspace as a standalone static app at `/chat/`, and exports its components so the integration pass can mount them inside the web app at `/app/`.

## Read first

1. `CLAUDE.md` and `AGENTS.md`, then `docs/ARCHITECTURE.md`.
2. `docs/prompts/SHARED-CONTRACTS.md` sections 3 (`ModelInfo`, `ChatApiRequest`, the chat SSE events and `[n]` citations), 6 (stack, URL layout, hand-off links, browser storage keys, design tokens, visual language) and 8, in full.
3. `docs/contracts/http-api.md` (error body, `Citation`, `/library`, `/ask`, auth) and `packages/core/src/types.ts`, `packages/core/src/provider.ts`, `packages/core/src/segments.ts` (`timestampUrl`, `formatTimestamp`).
4. `packages/registry/src/browser.ts` (`createRegistry`, `createBrowserContext`) for client-only mode, and `packages/core/src/llm-stream.ts` if it exists.
5. `tests/fixtures/README.md` and `tests/fixtures/contexts/*.json`.

## Goal

`/chat/` is a fast, accessible, dark-by-default chat workspace where a user attaches videos or a collection, picks a model (or Auto), and gets streaming answers with clickable timestamp citations. It works against the HTTP API, and in client-only mode (GitHub Pages, no API) it runs the LLM chain in the browser with the user's own keys.

## Requirements

### Stack and setup

- React 19, Vite (`base: '/chat/'`), TypeScript, Tailwind CSS v4, `lucide-react`, fonts via `@fontsource` (Inter, JetBrains Mono), no third-party requests at runtime. Copy the token CSS from SHARED-CONTRACTS section 6 into `src/styles/tokens.css` unchanged. Own `tsconfig.json`; add `packages/chat/**` to the root `exclude` (re-read the root file first; prompt 36 makes the same kind of edit).
- `@vid2context/core` is imported directly in the browser for types, `timestampUrl`, `estimateTokens` and streaming helpers.
- Export the building blocks from `src/index.ts` (`ChatWorkspace`, `ModelPicker`, `Thread`, `Composer`, `CitationChip`, `SourcePanel`, the API client) so the web app can mount them later.

### Layout (modeled on the LobeHub chat the owner showed)

- Left sidebar: "New chat" button, search over conversations, conversations grouped by Today, Yesterday, Previous 7 days and Older, star to pin, rename and delete, collapsible on narrow screens.
- Main thread: user and assistant messages; assistant Markdown rendered safely (a sanitizing Markdown renderer, code blocks with copy, tables); streaming text with a stop button; per-message actions: copy, regenerate, edit and resend (user messages); the model that answered shown under each assistant message, like the screenshot's model tag.
- Composer: multi-line input ("Ask about your videos..."), Enter to send, Shift+Enter for a newline, an attach button, and attached context chips above the input showing thumbnail, title and estimated tokens, each removable.
- Attaching context: paste a video URL (any input the server accepts), pick from the library (`GET /api/v1/library`), pick a collection (`GET /api/v1/collections`) when that route exists, or upload a file (`POST /api/v1/uploads`) when that route exists. `?input=` and `?collection=` query params open a new chat with that context attached (hand-off from the web app).

### Model picker

- A button in the thread header showing the current choice (for example "Auto" or "gpt-oss-120b"), opening a popover with: a search box that filters by label, service and capability; "Auto" first with a short description ("Free-first: local, then free tiers, then keyless") and a small "Recommended" badge; then sections by tier (Local, Free, Keyless, Paid) and within each by service (Groq, OVH, Ollama, Anthropic, ...), using tier colors from the tokens.
- Each row: model label, service, capability icons with tooltips (vision, video, tools, JSON, reasoning, streaming), and a context badge (`128K`, `1M`). Disabled rows are greyed and say what is missing ("Needs GROQ_API_KEY"), linking to settings in client-only mode or to `docs/providers.md` in server mode.
- Favorites: star a model to pin it at the top. The choice is saved per conversation; new conversations use the last choice.
- Sends `model: { rung }` (non-strict, so the server can fall back) or omits `model` for Auto; a "Strict" toggle in the popover footer sends `strict: true`.
- Data: `GET /api/v1/models?kind=llm` (`{ models: ModelInfo[] }`). In client-only mode, build the same list in the browser from the browser registry (use `listModels` from `packages/core/src/llm/` if prompt 25 has landed; otherwise derive `ModelInfo` from `registry.llmRungs(env)` in a small local helper).

### Streaming and citations

- `POST /api/v1/chat` with `ChatApiRequest`, consuming the SSE events exactly as SHARED-CONTRACTS section 3 lists (`meta`, `reasoning`, `delta`, `done`, `error`). Parse SSE with `fetch` and a stream reader (POST bodies rule out `EventSource`). Reasoning, when present, goes in a collapsed "Thinking" disclosure, never mixed into the answer.
- `[n]` markers in the answer render as chips "Title @ m:ss" built from `meta.sources`. Clicking a chip opens a right-side source panel: a YouTube embed (`youtube-nocookie.com`, loaded only on click) seeking to the cited second when the source is YouTube, otherwise a link, plus the transcript for the cited range, scrolled and highlighted, fetched from `/api/v1/library/:id` or `/api/v1/section` when those routes exist.
- Errors show the error hint and the attempts (which rungs were tried and why they failed), with a retry button. Never a bare "something went wrong".
- Token meter in the header: estimated tokens of attached context plus the conversation versus the selected model's `contextTokens`, warning before overflow and suggesting a larger-context model from the list.

### Client-only mode

- Active when the API is unreachable or the build sets `VITE_CLIENT_ONLY=1`. Uses `@vid2context/registry/browser` with `createBrowserContext(env)` where `env` is the provider keys stored in IndexedDB `v2c-settings` (store `kv`, key `providerKeys`), and streams with `streamFromRung` or prompt 25's `chatStream` when present.
- Verify which hosted providers allow browser CORS today (test each from a real browser page) and only offer those in this mode; record the result in the guide. Context in this mode comes from transcripts the user pastes or from `.json` bundle files they drop in (VideoContext JSON).
- A settings dialog to enter keys, with a plain warning that keys stay in this browser's storage and are sent only to the provider.

### Quality

- Persistence in IndexedDB `v2c-chat` (conversations, messages, attached context references, model choice). Export a conversation as Markdown with citations as timestamp links.
- Keyboard shortcuts (new chat, focus composer, open model picker, stop), WCAG 2.2 AA (focus order, ARIA for the popover and listbox, contrast), responsive down to 360 px, initial JS under 200 KB gzipped with the Markdown renderer and source panel code-split.

## Prefer free and local

Auto is the default and means free-first. The picker shows local models first. Client-only mode never routes through vid2context servers.

## Out of scope

- The `/chat` route itself (prompt 34) and `/models`, `/uploads` (prompt 46); the web app (prompt 47); the landing site (prompt 36). If `/api/v1/chat` does not exist when you finish, build against the contract, verify in client-only mode, and report that server-mode e2e is pending.

## Tests

- Record real SSE responses into `packages/chat/test/fixtures/`: from a running local server's `/api/v1/chat` if prompt 34 has landed, otherwise a real keyless OpenAI-compatible stream recorded once (and note which), plus a real `/api/v1/health` or a `ModelInfo[]` payload produced by running the real registry (`listModels` or your helper) and saving its output.
- Component tests (vitest, jsdom, Testing Library) using those recordings: picker grouping, search, disabled reasons, favorites; streaming render and stop; citation chips from `meta.sources`; error rendering with hint and attempts; token meter math on the real context fixtures.
- Playwright e2e when available: client-only mode with a keyless rung (real network, LIVE), and server mode against a locally started server on a random port when `/api/v1/chat` exists.

## Acceptance criteria

- [ ] `cd packages/chat && npx tsc --noEmit` passes, `npx vitest run packages/chat` passes, `npx biome check packages/chat` is clean.
- [ ] `npm run build -w packages/chat` produces static files that work when served under `/chat/`.
- [ ] A real conversation about `https://www.youtube.com/watch?v=cCPsdFdlshc` streams an answer whose citation chips open the video at the cited time (server mode if available, otherwise client-only with the transcript JSON attached).
- [ ] Screenshots of the workspace and the open model picker, taken from the running app, are in the guide.

## Docs

- `packages/chat/README.md` (dev, build, env, client-only mode) and `docs/guides/chat.md` (using the workspace, the model picker, citations, client-only CORS table, screenshots).

## If credentials, tools or network are missing

No keys are required: keyless rungs cover client-only verification, and server mode needs only the local server. If Playwright or a browser is unavailable, verify with component tests and say what was not checked in a real browser.

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

# 48. Browser extension

| | |
|---|---|
| Track | H. Surfaces |
| You own | `packages/extension/` |
| Shared edits allowed | None (the root `tsconfig.json` already excludes `packages/extension`) |
| Commit scope | `extension` |
| Runs alongside | 49 other prompts in the same folder; depends only on the foundation |

vid2context turns any video into context for AI agents: transcripts, metadata, chapters and cited briefs, free-first, as a CLI, MCP server, HTTP API and web app. The extension puts it one click away while browsing. On YouTube it can work with no server at all: the content script runs on youtube.com, so it can read the player response embedded in the page and fetch caption tracks from the same origin without CORS or datacenter-IP problems, then format them with `@vid2context/core`. On any other page it hands the URL to the web app or the API. This prompt builds a Manifest V3 extension for Chrome and Edge with a Firefox build.

## Read first

1. `CLAUDE.md` and `AGENTS.md` (operating rules and commands), then `docs/ARCHITECTURE.md`.
2. `packages/core/src/types.ts`, `packages/core/src/format/index.ts`, `packages/core/src/segments.ts`.
3. `providers/youtube/src/` (caption track choice and the srv3 and srv1 parsers; the package exports `chooseTrack`, `parseSrv3`, `parseSrv1`, `parseTimedText`, `parseDescriptionChapters`, `matchYouTube`) and its fixtures in `providers/youtube/test/fixtures/`.
4. `docs/contracts/http-api.md` (routes, error body, CORS via `VID2CONTEXT_CORS_ORIGINS`).
5. `docs/prompts/SHARED-CONTRACTS.md` sections 2 (formats, bundle), 6 (stack, tokens, hand-off links `/app/?url=`) and 8.

## Goal

An unpacked-loadable MV3 extension that, on a YouTube watch page, copies an agent-ready transcript, downloads a .zip, or opens the video in vid2context, all computed in the page's origin without a server; adds a context menu for any link or page; and has a popup and options page in the shared design. Firefox gets an equivalent build.

## Requirements

### Build

- Vite with multiple entries (content script, service worker, popup, options), React 19 for popup and options, Tailwind v4 with the shared tokens copied into `src/styles/tokens.css` unchanged, `lucide-react`.
- Outputs `dist/chrome/` and `dist/firefox/` with per-browser manifests generated from one source (Firefox: `browser_specific_settings.gecko.id`, background scripts where service workers differ). Use the `browser` namespace through a small typed wrapper or `webextension-polyfill`.
- No remote code, no `eval`, CSP-clean, no third-party requests.

### YouTube watch pages

- A small button group near the video title: "Copy for AI", "Download .zip", "Open in vid2context". It survives YouTube's single-page navigation (`yt-navigate-finish`) and does not duplicate itself.
- Extraction in the content script: read the player response from the page (the `ytInitialPlayerResponse` data in the page, or the current player's response after navigation, read through a minimal injected script that posts it to the content script), pick a track with the YouTube provider's exported choice logic, fetch the track from youtube.com, parse with the exported parsers, and build a `VideoContext` (metadata from `videoDetails`, chapters from the description parser). Import those functions from `@vid2context/provider-youtube`; do not fork them.
- "Copy for AI": `agentPrompt` from prompt 15 (`@vid2context/core`) when it exists, otherwise the `pack` formatter from prompt 01, otherwise the `text` formatter with timestamps and a header; report which was used at build time.
- "Download .zip": `buildBundle` from prompt 15 when it exists when you finish; otherwise leave the button out and report.
- "Open in vid2context": opens `<app base>/app/?url=<encoded watch URL>`.
- When the page has no captions, say so and offer "Open in vid2context" (which can transcribe the audio).

### Everywhere else

- Context menu items on links, pages and video elements: "Get context with vid2context" opens the app with that URL; "Copy transcript (via API)" calls `GET <api base>/transcript?url=` and copies the result, showing the API's error hint on failure.

### Popup and options

- Popup: current tab, the quick actions that apply, the last five items (stored in `storage.local`).
- Options: app base (default `https://vid2context.com`), API base (default `http://localhost:8787/api/v1`), default copy format, the copy template, include timestamps. Stored in `storage.sync`.

### Permissions

- `activeTab`, `contextMenus`, `storage`, `scripting`; host permissions for `https://www.youtube.com/*` and `https://m.youtube.com/*` only. API calls to other hosts use optional host permissions requested at the moment of use.

## Out of scope

- The web app and server: prompts 47 and 46. Store publishing (only a checklist).

## Tests

- Unit tests (Vitest) on a real recorded YouTube watch page HTML saved into `packages/extension/test/fixtures/` (record it with `LIVE=1`, strip anything personal, document it): player response extraction, track choice, building the `VideoContext`, and the text produced by "Copy for AI".
- Manifest generation tests for both browsers (required keys, permissions exactly as listed).
- Playwright with the unpacked Chrome build loaded in a persistent Chromium context (`LIVE=1`): open a real YouTube watch page, wait for the buttons, click "Copy for AI", read the clipboard, assert transcript text and timestamps.

## Acceptance criteria

- [ ] `npm run build -w packages/extension` produces `dist/chrome` and `dist/firefox`.
- [ ] `npx vitest run packages/extension` passes and `npx biome check packages/extension` is clean.
- [ ] Loading `dist/chrome` unpacked in Chromium and clicking "Copy for AI" on `https://www.youtube.com/watch?v=jNQXAC9IVRw` copies the transcript (automated with Playwright, or verified by hand and stated).
- [ ] `web-ext lint` on `dist/firefox` passes if `web-ext` can be installed.

## Docs

- `packages/extension/README.md`: build, load unpacked in Chrome, Edge and Firefox, options, permissions and why each is needed, and a store listing checklist (screenshots, privacy statement: no data leaves the browser on YouTube pages).

## If credentials, tools or network are missing

No key is needed. If YouTube is unreachable, unit-test on the recorded page and report the Playwright run as not done. If Playwright cannot load extensions in this environment, say so and describe the manual check.

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
